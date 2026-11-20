import type { SnagletAgent } from '@server/services/AgentService';
import { toAnthropicTools } from '@server/services/ToolService';
import {
  assertSecret,
  buildAnthropicAuthedRequest,
  isAnthropicOAuthToken,
  logProviderPayload,
  parseToolInputJson,
  pickCredentialId,
  pickSecret,
  scrubLoneSurrogates,
} from '../shared';
import { logger } from '@server/config/logger';
import { elapsedMs, getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { ProviderRetryHandledError, TRANSIENT_NETWORK_CODES } from '../errors';
import {
  CLAUDE_CODE_REAUTH_MESSAGE,
  isClaudeCodeTokenKnownBad,
  markClaudeCodeTokenRejected,
  recoverClaudeCodeToken,
  resolveClaudeCodeSecret,
} from '@server/services/ClaudeCodeAuthService/recovery';
import type {
  AssistantTurnBlock,
  OnChunkCallback,
  OnThinkingChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyResult,
  ToolCall,
} from '../types';
import {
  applyMessageCacheBreakpoints,
  applySystemCacheTtl,
  hasThinkingBlocks,
  isThinkingBindingRejection,
  prepareAnthropicApiMessages,
  withoutThinking,
  type AnthropicApiMessage,
} from './anthropicMessagePrep';
import {
  claudeCodeVersionRejectionMessage,
  forgetClaudeCliVersion,
  getClaudeCliVersion,
  isClaudeCodeVersionRejection,
  type ClaudeCliVersionInfo,
} from './claudeCliVersion';
import { readSSEJsonEvents } from './shared/sse';
import { anthropicMaxOutput } from './anthropicLimits';

/**
 * The id Anthropic's API knows for a stored model id. An agent saved on a
 * `[1m]` variant (`claude-opus-4-7[1m]`) runs on the base id: models with a
 * 1M window use it by default, with no separate id or beta header.
 */
function anthropicApiModelId(modelId: string | undefined | null): string {
  return (modelId ?? '').trim().replace(/\[1m\]$/i, '');
}

// Anthropic-side failures worth retrying. Transient HTTP statuses (overload /
// 5xx) and stream error types (overloaded_error / api_error). The stream-error
// case is retried only before any content has been emitted, so a re-send can
// never duplicate output — see streamAnthropicMessage's throw sites.
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 529]);
const ANTHROPIC_VERIFY_TIMEOUT_MS = 20_000;

/** Anthropic rejected the credential itself (401) — never transient. */
class AnthropicAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicAuthError';
  }
}

/** A 400 because the presented `claude-cli/<v>` identity predates the model. */
class AnthropicClaudeCodeVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicClaudeCodeVersionError';
  }
}

/**
 * Replace Anthropic's "run `claude update`" text with copy that names the
 * version Snaglet presented and the remedy that applies, and re-detect the installed
 * CLI before the next request.
 */
function explainVersionRejection(
  err: AnthropicClaudeCodeVersionError,
  modelId: string,
  presented: ClaudeCliVersionInfo | null
): Error {
  forgetClaudeCliVersion();
  logger.warn(
    `[anthropic] ${modelId} refused for claude-cli/${presented?.version ?? 'unknown'} ` +
      `(${presented?.source ?? 'unknown'}): ${err.message}`
  );
  return new Error(
    `${claudeCodeVersionRejectionMessage(modelId, presented)} [status=400, model=${modelId}]`,
    { cause: err }
  );
}
const RETRYABLE_STREAM_ERROR_TYPES = new Set(['overloaded_error', 'api_error']);
// Connection-level failures that occur *before any response byte* are the most
// common Anthropic blips (the API load-sheds by closing sockets) and are always
// safe to re-send because nothing has streamed yet — see TRANSIENT_NETWORK_CODES
// in ../errors.ts for the shared code set.
const MAX_ANTHROPIC_RETRIES = 2; // 3 attempts total
const ANTHROPIC_RETRY_BASE_MS = 500; // exponential backoff: 500ms, then 1000ms

/** A transient Anthropic failure that is safe to re-send. `detail` tags the log. */
class AnthropicRetryableError extends ProviderRetryHandledError {
  constructor(
    message: string,
    readonly detail: string
  ) {
    super(message);
    this.name = 'AnthropicRetryableError';
  }
}

/**
 * Send-with-retry wrapper around a single streaming attempt. Retries only
 * AnthropicRetryableError (transient + pre-content) with exponential backoff;
 * any other error — and an aborted signal — propagates immediately.
 */
async function retryAnthropicStream(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  agent: SnagletAgent,
  onChunk: OnChunkCallback | undefined,
  options: ProviderChatOptions | undefined
): Promise<ProviderChatResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamAnthropicMessage(headers, body, agent, onChunk, options);
    } catch (err) {
      const canRetry =
        err instanceof AnthropicRetryableError &&
        attempt < MAX_ANTHROPIC_RETRIES &&
        !options?.signal?.aborted;
      if (!canRetry) throw err;
      const backoffMs = ANTHROPIC_RETRY_BASE_MS * 2 ** attempt;
      logger.warn(
        `[anthropic] transient error (${(err as AnthropicRetryableError).detail}) for ` +
          `model=${agent.modelId} — retry ${attempt + 1}/${MAX_ANTHROPIC_RETRIES} in ${backoffMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

export async function chatAnthropic(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const storedSecret = await pickSecret(agent);
  assertSecret(storedSecret, agent.provider);
  // Claude Code logins: send the token the CLI holds right now, not the
  // snapshot Snaglet stored at import time (the CLI rotates it). A token Anthropic
  // already rejected is refused up front so a dead login cannot fan out into
  // one 401 per agent run until someone re-authenticates.
  // Identity is only needed for OAuth tokens, so API-key runs skip the lookup.
  const credentialId = isAnthropicOAuthToken(storedSecret) ? await pickCredentialId(agent) : null;
  const secret = await resolveClaudeCodeSecret(storedSecret, credentialId);
  if (isClaudeCodeTokenKnownBad(secret)) throw new Error(CLAUDE_CODE_REAUTH_MESSAGE);

  const apiModelId = anthropicApiModelId(agent.modelId);
  // Claude Code identities present the installed CLI's version; Anthropic
  // gates newer models on it.
  const cliVersion = isAnthropicOAuthToken(secret) ? await getClaudeCliVersion() : null;
  const { headers, system } = buildAnthropicAuthedRequest({
    secret,
    model: apiModelId,
    system: agent.systemPrompt,
    systemBlocks: options?.systemBlocks,
    claudeCliVersion: cliVersion?.version,
  });

  // Sanitize (empty/trailing-whitespace assistant), merge consecutive same-role
  // strings, drop trailing assistant prefill, and enforce the last-mile
  // tool-pairing guarantee, all in a pure, unit-tested helper. The pairing
  // guard is a safety net: a non-zero conversion count means an upstream
  // compaction boundary sliced a tool cycle and should be fixed there, so
  // surface it loudly rather than swallowing it.
  const { apiMessages, orphanedToolResults, orphanedToolUses } =
    prepareAnthropicApiMessages(messages);
  if (orphanedToolResults > 0 || orphanedToolUses > 0) {
    logger.warn(
      `[anthropic] last-mile tool-pairing guard converted ${orphanedToolResults} orphaned ` +
        `tool_result(s) + ${orphanedToolUses} orphaned tool_use(s) to text for ` +
        `model=${agent.modelId} — an upstream compaction boundary landed inside a tool cycle`
    );
  }

  // One TTL for every breakpoint (tools, system, messages): resolved chain is
  // model_metadata.cacheTtl -> '1h' for chat.
  const cacheTtl: '5m' | '1h' = options?.cacheTtl ?? '1h';

  // Message-array breakpoints (durable prefix + tail) — see
  // applyMessageCacheBreakpoints for the placement rules and why the tail
  // breakpoint alone was not enough.
  const cachedMessages = applyMessageCacheBreakpoints(apiMessages, cacheTtl);

  const body: Record<string, unknown> = {
    // `apiModelId` is the id Anthropic recognizes (a `[1m]` suffix is
    // stripped above); logs keep `agent.modelId`.
    model: apiModelId,
    // Required by the API: the caller's limit (the catalog row's), else the
    // model generation's cap.
    max_tokens: options?.maxOutputTokens ?? anthropicMaxOutput(apiModelId),
    stream: true,
    system: applySystemCacheTtl(system, cacheTtl),
    messages: cachedMessages,
  };

  if (options?.tools && options.tools.length > 0) {
    const anthropicTools = toAnthropicTools(options.tools);
    // Cache the tool definitions on their own breakpoint (the first
    // of the 4-breakpoint budget). Tools sit at the very front of the cache
    // prefix (tools → system → messages), and the advertised set is only the
    // stable CORE tier, so this is a durable prefix worth its own breakpoint —
    // and it keeps a system change from re-billing the tool schemas.
    const lastTool = anthropicTools[anthropicTools.length - 1];
    if (lastTool) {
      (lastTool as unknown as Record<string, unknown>).cache_control = {
        type: 'ephemeral',
        ttl: cacheTtl,
      };
    }
    body.tools = anthropicTools;
  }

  logProviderPayload('anthropic', agent, body, headers);

  try {
    return await sendWithThinkingFallback(headers, body, agent, onChunk, options);
  } catch (err) {
    if (err instanceof AnthropicClaudeCodeVersionError) {
      throw explainVersionRejection(err, agent.modelId || apiModelId, cliVersion);
    }
    if (!(err instanceof AnthropicAuthError) || !isAnthropicOAuthToken(secret)) throw err;
    // Revoked/expired Claude Code token: re-read the keychain once. A rotated
    // token gets exactly one retry with fresh auth headers; otherwise the
    // credential is now marked failed and the user is told to sign in again.
    const recovered = await recoverClaudeCodeToken(secret, credentialId);
    if (!recovered) throw new Error(CLAUDE_CODE_REAUTH_MESSAGE, { cause: err });
    logger.warn(
      `[anthropic] retrying once with the rotated Claude Code token (model=${agent.modelId})`
    );
    const retry = buildAnthropicAuthedRequest({
      secret: recovered,
      model: apiModelId,
      system: agent.systemPrompt,
      systemBlocks: options?.systemBlocks,
      claudeCliVersion: cliVersion?.version,
    });
    try {
      return await sendWithThinkingFallback(retry.headers, body, agent, onChunk, options);
    } catch (retryErr) {
      if (retryErr instanceof AnthropicClaudeCodeVersionError) {
        throw explainVersionRejection(retryErr, agent.modelId || apiModelId, cliVersion);
      }
      // The rotated token is dead too: remember it so the next run stops early.
      if (retryErr instanceof AnthropicAuthError) {
        await markClaudeCodeTokenRejected(recovered);
        throw new Error(CLAUDE_CODE_REAUTH_MESSAGE, { cause: retryErr });
      }
      throw retryErr;
    }
  }
}

/**
 * Send, and when the API refuses a replayed thinking block because the
 * history before it changed (a condensed tool result, an in-run compaction),
 * send once more without any thinking blocks. Removing every thinking block
 * is always accepted; the model thinks afresh from the history it is given.
 */
async function sendWithThinkingFallback(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  agent: SnagletAgent,
  onChunk: OnChunkCallback | undefined,
  options: ProviderChatOptions | undefined
): Promise<ProviderChatResult> {
  try {
    return await retryAnthropicStream(headers, body, agent, onChunk, options);
  } catch (err) {
    const messages = body.messages as AnthropicApiMessage[];
    if (!isThinkingBindingRejection(getErrorMessage(err)) || !hasThinkingBlocks(messages)) {
      throw err;
    }
    logger.warn(
      `[anthropic] replayed thinking refused for model=${agent.modelId}; ` +
        `resending without thinking blocks: ${getErrorMessage(err)}`
    );
    const stripped = { ...body, messages: withoutThinking(messages) };
    const result = await retryAnthropicStream(headers, stripped, agent, onChunk, options);
    return { ...result, thinkingDropped: true };
  }
}

/** One streaming attempt against the Messages API. Throws AnthropicRetryableError
 * on transient, pre-content failures so retryAnthropicStream can re-send. */
async function streamAnthropicMessage(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  agent: SnagletAgent,
  onChunk: OnChunkCallback | undefined,
  options: ProviderChatOptions | undefined
): Promise<ProviderChatResult> {
  const requestStartedAt = Date.now();
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(scrubLoneSurrogates(body)),
      signal: options?.signal,
    });
  } catch (err) {
    // Re-throw AbortErrors immediately — wrapping them into a plain Error loses
    // the 'AbortError' name that turnLoop.ts checks to distinguish cancel from failure.
    if ((err instanceof DOMException || err instanceof Error) && err.name === 'AbortError') {
      throw err;
    }
    // undici hides the real network error (ECONNRESET, ENOTFOUND,
    // UND_ERR_SOCKET, cert failures, etc.) behind a generic
    // `TypeError: fetch failed` — unwrap `.cause` so the log says why.
    const cause = (err as { cause?: unknown })?.cause;
    const causeCode = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
    const causeMsg =
      cause instanceof Error
        ? `${causeCode ?? cause.name}: ${cause.message}`
        : cause
          ? String(cause)
          : getErrorMessage(err);
    logger.error(
      `[anthropic] network error calling api.anthropic.com (model=${agent.modelId}): ${causeMsg}`
    );
    const full = `Anthropic request failed: ${causeMsg} [model=${agent.modelId}]`;
    // Connection dropped before any byte streamed → transient and safe to
    // re-send (nothing was emitted to the client). An aborted request is the
    // user canceling — never retry that.
    if (causeCode && TRANSIENT_NETWORK_CODES.has(causeCode) && !options?.signal?.aborted) {
      throw new AnthropicRetryableError(full, `network=${causeCode}`);
    }
    throw new Error(full, { cause: err });
  }

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    logger.error(
      `[anthropic] API error ${res.status} for model=${agent.modelId}:`,
      rawBody.slice(0, 500)
    );
    let errMessage = `Anthropic request failed (${res.status})`;
    let errType: string | undefined;
    const data = safeJsonParse<Record<string, unknown>>(rawBody, {}) ?? {};
    const errObj = data.error as { message?: string; type?: string } | undefined;
    errMessage = errObj?.message || errObj?.type || errMessage;
    errType = errObj?.type;
    const full = `${errMessage} [status=${res.status}, type=${errType ?? 'unknown'}, model=${agent.modelId}]`;
    if (RETRYABLE_HTTP_STATUSES.has(res.status)) {
      throw new AnthropicRetryableError(full, `status=${res.status}`);
    }
    if (res.status === 401) throw new AnthropicAuthError(full);
    if (res.status === 400 && isClaudeCodeVersionRejection(errMessage)) {
      throw new AnthropicClaudeCodeVersionError(full);
    }
    throw new Error(full);
  }

  if (!res.body) throw new Error('Anthropic returned no response body');

  let reply = '';
  let thinkingContent = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let stopReason: string | undefined;
  let inThinkingBlock = false;

  const { onThinkingChunk, onUsage } = options ?? {};

  // Report what Anthropic has actually told us so far for THIS call. Input is
  // known in full from `message_start`, which is why the counter can move
  // within the first moment of every tool cycle rather than only at the end.
  const emitUsage = () => {
    if (!onUsage) return;
    const fresh = inputTokens ?? 0;
    const read = cacheReadTokens ?? 0;
    const write = cacheCreationTokens ?? 0;
    const totalIn = fresh + read + write;
    onUsage({
      inputTokens: totalIn > 0 ? totalIn : inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    });
  };

  const toolCalls: ToolCall[] = [];
  let currentToolId = '';
  let currentToolName = '';
  let currentToolInputJson = '';
  // The response's blocks in order, so a tool turn can go back with its
  // thinking blocks exactly as received (signatures included).
  const blocks: AssistantTurnBlock[] = [];
  let currentText: { type: 'text'; text: string } | null = null;
  let unparsedToolInput: unknown = null;
  let currentThinking: { type: 'thinking'; thinking: string; signature: string } | null = null;

  for await (const ev of readSSEJsonEvents<Record<string, unknown>>(
    res.body,
    options?.onStreamActivity
  )) {
    const type = ev.type as string | undefined;

    if (type === 'content_block_start') {
      const block = ev.content_block as
        | {
            type?: string;
            id?: string;
            name?: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
          }
        | undefined;
      currentText = null;
      currentThinking = null;
      if (block?.type === 'tool_use') {
        currentToolId = block.id ?? '';
        currentToolName = block.name ?? '';
        currentToolInputJson = '';
        inThinkingBlock = false;
      } else if (block?.type === 'thinking') {
        inThinkingBlock = true;
        currentThinking = {
          type: 'thinking',
          thinking: block.thinking ?? '',
          signature: block.signature ?? '',
        };
        blocks.push(currentThinking);
      } else if (block?.type === 'redacted_thinking') {
        inThinkingBlock = false;
        blocks.push({ type: 'redacted_thinking', data: block.data ?? '' });
      } else {
        inThinkingBlock = false;
        if (block?.type === 'text') {
          currentText = { type: 'text', text: block.text ?? '' };
          blocks.push(currentText);
        }
      }
    }

    if (type === 'content_block_delta') {
      const delta = ev.delta as
        | {
            type?: string;
            text?: string;
            partial_json?: string;
            thinking?: string;
            signature?: string;
          }
        | undefined;
      if (inThinkingBlock && delta?.type === 'thinking_delta' && delta.thinking) {
        thinkingContent += delta.thinking;
        if (currentThinking) currentThinking.thinking += delta.thinking;
        onThinkingChunk?.(delta.thinking);
      }
      if (delta?.type === 'signature_delta' && delta.signature && currentThinking) {
        currentThinking.signature += delta.signature;
      }

      if (delta?.type === 'text_delta' && delta.text) {
        reply += delta.text;
        if (currentText) currentText.text += delta.text;
        onChunk?.(delta.text);
      }
      if (delta?.type === 'input_json_delta' && delta.partial_json) {
        currentToolInputJson += delta.partial_json;
      }
    }

    if (type === 'content_block_stop') {
      if (currentToolId) {
        let parsedInput: Record<string, unknown>;
        try {
          parsedInput = parseToolInputJson(currentToolInputJson);
        } catch (err) {
          // A reply cut off at max_tokens closes its last tool call with
          // incomplete JSON; that call is dropped once the stop reason is in.
          unparsedToolInput ??= err;
          currentToolId = '';
          currentToolName = '';
          currentToolInputJson = '';
          currentText = null;
          currentThinking = null;
          continue;
        }
        toolCalls.push({
          id: currentToolId,
          name: currentToolName,
          input: parsedInput,
        });
        blocks.push({
          type: 'tool_use',
          id: currentToolId,
          name: currentToolName,
          input: parsedInput,
        });
        currentToolId = '';
        currentToolName = '';
        currentToolInputJson = '';
      }
      currentText = null;
      currentThinking = null;
    }

    if (type === 'message_delta') {
      const delta = ev.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) {
        stopReason = delta.stop_reason;
      }
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage) {
        outputTokens = Number(usage.output_tokens ?? 0) || undefined;
        emitUsage();
      }
    }

    if (type === 'message_start') {
      const msg = ev.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = Number(usage.input_tokens ?? 0) || undefined;
        cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0) || undefined;
        cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0) || undefined;
        emitUsage();
      }
    }

    if (type === 'error') {
      const err = ev.error as { message?: string; type?: string } | undefined;
      const errType = err?.type ?? 'unknown';
      const full = `Anthropic stream error [type=${errType}, model=${agent.modelId}]: ${
        err?.message ?? errType
      }`;
      // Retry only if nothing has streamed to the client yet — re-sending
      // after onChunk emitted text/thinking/tool data would duplicate it.
      const alreadyStreamed =
        reply.length > 0 ||
        thinkingContent.length > 0 ||
        toolCalls.length > 0 ||
        currentToolId !== '';
      if (RETRYABLE_STREAM_ERROR_TYPES.has(errType) && !alreadyStreamed) {
        throw new AnthropicRetryableError(full, `type=${errType}`);
      }
      throw new Error(full);
    }
  }

  const fresh = inputTokens ?? 0;
  const read = cacheReadTokens ?? 0;
  const write = cacheCreationTokens ?? 0;
  const totalIn = fresh + read + write;
  const hitPct = totalIn > 0 ? Math.round((read / totalIn) * 100) : 0;

  // Log cache metrics for observability. agent_id, agent_name, latency_ms are
  // included so per-turn metrics can be attributed to a specific agent in
  // interleaved group-chat logs.
  const latencyMs = elapsedMs(requestStartedAt);
  const escapedAgentName = (agent.name ?? '').replace(/\s+/g, '_');
  // pid identifies the server process. Every worktree's dev server writes to
  // the same ~/.snaglet/logs/server.log, so without this the metrics from two servers running
  // different code interleave into one indistinguishable stream — which makes
  // any before/after comparison meaningless.
  logger.info(
    `[cache_metrics] pid=${process.pid} thread_id=${options?.threadId || 'unknown'} ` +
      `agent_id=${agent.id} agent_name=${escapedAgentName} ` +
      `model=${agent.modelId} input=${fresh} cache_read=${read} ` +
      `cache_creation=${write} output=${outputTokens ?? 0} ` +
      `hit_ratio=${(hitPct / 100).toFixed(3)} latency_ms=${latencyMs}`
  );

  const cutOff = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded';
  // Malformed tool input in a reply that was not cut off is a real failure.
  if (unparsedToolInput && !cutOff) throw unparsedToolInput;

  // A turn the run continues from goes back with its thinking, unchanged: a
  // tool turn whole, and a turn cut off at the output limit without its
  // tool_use blocks (the last may be truncated) or a thinking block the cut
  // left unsigned (dropping that trailing block is accepted).
  const replayBlocks = blocks.filter(
    (b) =>
      (b.type !== 'text' || b.text.length > 0) &&
      (b.type !== 'thinking' || b.signature.length > 0) &&
      (!cutOff || b.type !== 'tool_use')
  );
  const replayThinking =
    (stopReason === 'tool_use' || cutOff) &&
    replayBlocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');

  return {
    reply,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: stopReason ?? 'end_turn',
    ...(replayThinking ? { assistantContent: replayBlocks } : {}),
    thinkingContent: thinkingContent || undefined,
    usage: {
      // Anthropic's `message_start.usage.input_tokens` is FRESH-only —
      // the cache-read + cache-creation tokens are separate fields, but
      // the model still processed all three combined. Roll them up so
      // downstream consumers (per-message context-usage pill,
      // accounting, telemetry) see the actual prompt size, not just the
      // tiny uncached delta that's left over when caching is doing its
      // job. The granular fresh/read/write split is still emitted in
      // the cache_metrics log above for observability.
      inputTokens: totalIn > 0 ? totalIn : inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    },
  };
}

export async function verifyAnthropic(secret: string): Promise<ProviderVerifyResult> {
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (isAnthropicOAuthToken(secret)) {
    headers['Authorization'] = `Bearer ${secret}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    headers['x-api-key'] = secret;
  }

  // Bounded: verification runs inside sign-in sessions and the credential
  // test button, neither of which may hang on a stalled connection.
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers,
    signal: AbortSignal.timeout(ANTHROPIC_VERIFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (data.error as { message?: string } | undefined)?.message ??
      `Authentication failed (${res.status})`;
    return { valid: false, message };
  }
  return { valid: true, message: 'Connected successfully' };
}
