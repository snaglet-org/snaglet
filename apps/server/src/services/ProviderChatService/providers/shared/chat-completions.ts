/**
 * OpenAI-compatible Chat Completions protocol helpers.
 *
 * Provider files keep ownership of auth, base URL resolution, model routing,
 * and provider-specific error transforms. This module owns the shared wire
 * format used by OpenAI, Together, LM Studio, Ollama, and Copilot's
 * chat-completions-compatible path.
 */

import type { SnagletAgent } from '@server/services/AgentService';
import { toOpenAITools } from '@server/services/ToolService';
import { safeJsonParse, elapsedMs } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { logProviderPayload } from '../../shared';
import { createToolNameSanitizer, type ToolNameSanitizer } from './toolNameSanitizer';
import type { ToolNameGrammar } from '@server/services/ToolService/lib/toolName';
import type {
  OnChunkCallback,
  OnUsageCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ToolCall,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types';
import { splitToolResultContent, type ImageContentBlock } from '../../types';

interface ChatCompletionToolCallState {
  id: string;
  name: string;
  args: string;
}

export interface OpenAICompatibleChatCompletionRequest {
  url: string;
  providerLabel: string;
  errorLabel: string;
  agent: SnagletAgent;
  messages: ProviderMessage[];
  headers: Record<string, string>;
  onChunk?: OnChunkCallback;
  options?: ProviderChatOptions;
  model?: string | null;
  bodyExtensions?: Record<string, unknown>;
  errorTransform?: (message: string, body: Record<string, unknown>) => string | Promise<string>;
  /**
   * Strict OpenAI-style backends (Copilot) reject top-level schema combinators
   * (`anyOf`/`oneOf`/`allOf`). Set true to flatten tool schemas for the wire.
   */
  strictToolSchemas?: boolean;
  /**
   * The request field that carries the output-token cap. Defaults to
   * `max_tokens`; Copilot's gpt-5.x reject `max_tokens` and require
   * `max_completion_tokens`.
   */
  maxTokensField?: string;
  /**
   * Function-name grammar for the wire. Defaults to the dotted grammar; Copilot
   * (like OpenAI) rejects dots in `tools[].function.name`, so it passes the
   * no-dots grammar. Verified live: a dotted tool name 400s on Copilot's
   * chat-completions surface.
   */
  toolNameGrammar?: ToolNameGrammar;
}

function toOpenAICompatibleMessages(
  systemPrompt: string,
  messages: ProviderMessage[],
  sanitizer: ToolNameSanitizer
): Record<string, unknown>[] {
  const apiMessages: Record<string, unknown>[] = [{ role: 'system', content: systemPrompt }];

  for (const message of messages) {
    if (typeof message.content === 'string') {
      apiMessages.push({ role: message.role, content: message.content });
      continue;
    }

    if (!Array.isArray(message.content)) continue;

    if (message.role === 'user') {
      const blocks = message.content as unknown as Array<Record<string, unknown>>;
      const isToolResult = blocks.some((b) => b.type === 'tool_result');
      if (isToolResult) {
        const followupImages: ImageContentBlock[] = [];
        for (const block of message.content) {
          if ((block as ToolResultBlock).type === 'tool_result') {
            const toolResult = block as ToolResultBlock;
            // OpenAI's `tool` role only accepts string content — the text goes
            // in the tool message; any images (e.g. screenshots) follow as a
            // separate user message below so vision-capable models see them.
            const { text, images } = splitToolResultContent(toolResult.content);
            apiMessages.push({
              role: 'tool',
              tool_call_id: toolResult.tool_use_id,
              content: text || '[tool result]',
            });
            followupImages.push(...images);
          }
        }
        if (followupImages.length > 0) {
          apiMessages.push({
            role: 'user',
            content: followupImages.map((img) => ({
              type: 'image_url',
              image_url: {
                url:
                  img.source.type === 'base64'
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url,
              },
            })),
          });
        }
        continue;
      }

      // Multimodal: OpenAI-compatible chat endpoints use text + image_url parts.
      const parts: Record<string, unknown>[] = [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          const src = block.source as
            | { type: 'base64'; media_type: string; data: string }
            | { type: 'url'; url: string }
            | undefined;
          if (!src) continue;
          const url = src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url;
          parts.push({ type: 'image_url', image_url: { url } });
        }
      }
      if (parts.length > 0) {
        apiMessages.push({ role: 'user', content: parts });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const textParts: string[] = [];
      const toolCallsOut: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if ((block as { type: string }).type === 'text') {
          textParts.push((block as { text: string }).text);
        } else if ((block as ToolUseBlock).type === 'tool_use') {
          const toolUse = block as ToolUseBlock;
          toolCallsOut.push({
            id: toolUse.id,
            type: 'function',
            // Sanitize the persisted tool_use name to the OpenAI function-name
            // grammar. A single poisoned historical name (e.g. `action→<id>`)
            // otherwise 400s the whole request on every replayed turn. The
            // tool_result that follows correlates by `tool_call_id` (the id
            // above), not this name, so sanitizing here can't break correlation.
            function: {
              name: sanitizer.sanitize(toolUse.name),
              arguments: JSON.stringify(toolUse.input),
            },
          });
        }
      }
      apiMessages.push({
        role: 'assistant',
        content: textParts.join('') || null,
        ...(toolCallsOut.length > 0 ? { tool_calls: toolCallsOut } : {}),
      });
    }
  }

  return apiMessages;
}

export function buildOpenAICompatibleChatCompletionBody(args: {
  agent: SnagletAgent;
  messages: ProviderMessage[];
  options?: ProviderChatOptions;
  model?: string | null;
  extensions?: Record<string, unknown>;
  strictToolSchemas?: boolean;
  maxTokensField?: string;
  toolNameGrammar?: ToolNameGrammar;
}): { body: Record<string, unknown>; sanitizer: ToolNameSanitizer } {
  const sanitizer = createToolNameSanitizer(args.toolNameGrammar);

  // Seed the sanitizer with the live tool ids first so the canonical, callable
  // tools claim their un-suffixed wire names; only stale/poisoned historical
  // names that collide take a `_2` suffix. Advertised names and replayed
  // tool_use names then share one mapping, which keeps the round-trip correlated.
  const tools = args.options?.tools ?? [];
  for (const tool of tools) sanitizer.sanitize(tool.id);

  const body: Record<string, unknown> = {
    model: args.model ?? args.agent.modelId,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAICompatibleMessages(args.agent.systemPrompt, args.messages, sanitizer),
    ...(args.extensions ?? {}),
  };

  if (args.options?.maxOutputTokens) {
    body[args.maxTokensField ?? 'max_tokens'] = args.options.maxOutputTokens;
  }

  if (tools.length > 0) {
    body.tools = toOpenAITools(tools, { flattenSchemas: args.strictToolSchemas }).map((tool) => ({
      ...tool,
      function: { ...tool.function, name: sanitizer.sanitize(tool.function.name) },
    }));
  }

  return { body, sanitizer };
}

export async function collectOpenAICompatibleChatCompletionSSE(
  body: ReadableStream<Uint8Array>,
  onChunk?: OnChunkCallback,
  sanitizer?: ToolNameSanitizer,
  onUsage?: OnUsageCallback,
  /** Fired on every raw read from the stream (see ProviderChatOptions.onStreamActivity). */
  onActivity?: () => void
): Promise<ProviderChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let reply = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let finishReason: string | undefined;

  const toolCallMap = new Map<number, ChatCompletionToolCallState>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);

      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;

      const ev = safeJsonParse<Record<string, unknown>>(raw);
      if (!ev) continue;

      const choices = ev.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;

      if (delta?.content) {
        const text = String(delta.content);
        reply += text;
        onChunk?.(text);
      }

      const toolCallDeltas = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCallDeltas) {
        for (const toolCall of toolCallDeltas) {
          const toolCallIndex = Number(toolCall.index ?? 0);
          const fn = toolCall.function as { name?: string; arguments?: string } | undefined;
          if (!toolCallMap.has(toolCallIndex)) {
            toolCallMap.set(toolCallIndex, {
              id: String(toolCall.id ?? ''),
              name: fn?.name ?? '',
              args: '',
            });
          }
          const entry = toolCallMap.get(toolCallIndex)!;
          if (fn?.name) entry.name = fn.name;
          if (fn?.arguments) entry.args += fn.arguments;
        }
      }

      if (choice?.finish_reason) {
        finishReason = String(choice.finish_reason);
      }

      // `stream_options.include_usage` puts usage in a single terminal chunk,
      // so this reports once per call — at the end. There is no mid-generation
      // usage on this wire format, and nothing is estimated to fake one.
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = Number(usage.prompt_tokens ?? 0) || undefined;
        outputTokens = Number(usage.completion_tokens ?? 0) || undefined;
        // Cache reads, two wire conventions — both are SUBSETS of
        // `prompt_tokens` (inclusive), unlike Anthropic's disjoint fields:
        //   - OpenAI-style `prompt_tokens_details.cached_tokens` (OpenAI,
        //     xAI, Copilot)
        //   - DeepSeek's own `prompt_cache_hit_tokens`
        // Absent fields stay undefined — "not reported" is not "zero"
        // (Together/Ollama/LM Studio report neither today). No provider on
        // this wire format reports cache WRITES; there is no creation field.
        const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
        const cachedRaw = promptDetails?.cached_tokens ?? usage.prompt_cache_hit_tokens;
        cacheReadTokens =
          cachedRaw === undefined || cachedRaw === null
            ? cacheReadTokens
            : Number(cachedRaw) || undefined;
        onUsage?.({ inputTokens, outputTokens, cacheReadTokens });
      }
    }
  }

  const toolCalls: ToolCall[] = [];
  for (const [, entry] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
    const parsedInput = safeJsonParse<Record<string, unknown>>(entry.args || '{}', {});
    // The model echoes back the SANITIZED name it was shown; map it back to the
    // real tool id so downstream dispatch and persistence see the canonical id.
    const name = sanitizer ? sanitizer.resolve(entry.name) : entry.name;
    toolCalls.push({ id: entry.id, name, input: parsedInput });
  }

  let stopReason: string = 'end_turn';
  if (finishReason === 'tool_calls') stopReason = 'tool_use';
  else if (finishReason === 'stop') stopReason = 'end_turn';
  else if (finishReason) stopReason = finishReason;

  return {
    reply,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason,
    // `inputTokens` (prompt_tokens) already INCLUDES cached reads on this
    // wire format — no roll-up needed, unlike Anthropic.
    usage: { inputTokens, outputTokens, cacheReadTokens },
  };
}

export async function callOpenAICompatibleChatCompletions({
  url,
  providerLabel,
  errorLabel,
  agent,
  messages,
  headers,
  onChunk,
  options,
  model,
  bodyExtensions,
  errorTransform,
  strictToolSchemas,
  maxTokensField,
  toolNameGrammar,
}: OpenAICompatibleChatCompletionRequest): Promise<ProviderChatResult> {
  const { body, sanitizer } = buildOpenAICompatibleChatCompletionBody({
    agent,
    messages,
    options,
    model,
    extensions: bodyExtensions,
    strictToolSchemas,
    maxTokensField,
    toolNameGrammar,
  });

  logProviderPayload(providerLabel, agent, body, headers);

  const requestStartedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (data.error as { message?: string } | undefined)?.message ??
      `${errorLabel} request failed (${res.status})`;
    throw new Error(errorTransform ? await errorTransform(message, body) : message);
  }

  if (!res.body) throw new Error(`${errorLabel} returned no response body`);

  const result = await collectOpenAICompatibleChatCompletionSSE(
    res.body,
    onChunk,
    sanitizer,
    options?.onUsage,
    options?.onStreamActivity
  );

  // Same line shape as the anthropic/gemini providers so log tooling parses
  // all of them. `input=` is fresh-only there; `prompt_tokens` here is
  // INCLUSIVE of cached reads, so subtract to match. Only log when the
  // provider actually reported cache activity — an all-zero line for
  // providers that never report caching (Together, Ollama…) would be noise
  // implying "0% hit rate" where the truth is "not reported".
  const read = result.usage?.cacheReadTokens ?? 0;
  if (read > 0) {
    const totalIn = result.usage?.inputTokens ?? 0;
    const fresh = Math.max(0, totalIn - read);
    const hitRatio = totalIn > 0 ? read / totalIn : 0;
    const escapedAgentName = (agent.name ?? '').replace(/\s+/g, '_');
    logger.info(
      `[cache_metrics] pid=${process.pid} thread_id=${options?.threadId || 'unknown'} ` +
        `agent_id=${agent.id} agent_name=${escapedAgentName} ` +
        `model=${agent.modelId} input=${fresh} cache_read=${read} ` +
        `cache_creation=0 output=${result.usage?.outputTokens ?? 0} ` +
        `hit_ratio=${hitRatio.toFixed(3)} latency_ms=${elapsedMs(requestStartedAt)}`
    );
  }

  return result;
}
