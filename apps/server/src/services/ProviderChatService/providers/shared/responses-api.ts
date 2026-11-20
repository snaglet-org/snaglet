/**
 * OpenAI Responses API protocol helpers — shared between providers that speak
 * the Responses surface (currently `codex` and `copilot` for codex-class
 * models). Auth, endpoint URL, and request headers belong in the provider
 * file; everything below is protocol-level and pure.
 */

import { safeJsonParse } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  getToolParametersSchema,
  normalizeAnthropicInputSchema,
} from '@server/services/ToolService/ToolFormatService';
import { NO_DOTS_TOOL_NAME_GRAMMAR } from '@server/services/ToolService/lib/toolName';
import { logProviderPayload, parseToolInputJson } from '../../shared';
import { createToolNameSanitizer, type ToolNameSanitizer } from './toolNameSanitizer';
import type { SnagletAgent } from '@server/services/AgentService';
import type {
  OnChunkCallback,
  OnThinkingChunkCallback,
  OnUsageCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ToolCall,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types';
import { splitToolResultContent } from '../../types';

const DEFAULT_RESPONSES_INSTRUCTIONS = 'You are a concise assistant.';

/**
 * Pull the most useful human-readable reason out of a Responses-API error
 * body. Handles the OpenAI shape (`{ error: { message } }`), the ChatGPT/Codex
 * backend's FastAPI shape (`{ detail }`, where `detail` is a string or an array
 * of validation objects), and falls back to a raw-body snippet so a generic
 * HTTP status never hides the real cause.
 */
export function extractResponsesErrorReason(rawBody: string): string {
  const body = (rawBody ?? '').trim();
  if (!body) return '';

  const parsed = safeJsonParse<Record<string, unknown> | null>(body, null);
  if (!parsed || typeof parsed !== 'object') {
    // Non-JSON (HTML gateway page, plain text) — return a trimmed snippet.
    return body.length > 500 ? `${body.slice(0, 500)}…` : body;
  }

  const err = parsed.error as { message?: string; code?: string } | undefined;
  const detail = parsed.detail;
  let reason = '';
  if (typeof err?.message === 'string' && err.message.trim()) {
    reason = err.message.trim();
  } else if (typeof detail === 'string' && detail.trim()) {
    reason = detail.trim();
  } else if (Array.isArray(detail) && detail.length > 0) {
    // FastAPI validation errors: [{ loc: [...], msg, type }, ...]
    reason = detail
      .map((d) => {
        if (d && typeof d === 'object') {
          const o = d as Record<string, unknown>;
          const loc = Array.isArray(o.loc) ? o.loc.join('.') : '';
          const msg = typeof o.msg === 'string' ? o.msg : '';
          return [loc, msg].filter(Boolean).join(': ');
        }
        return String(d);
      })
      .filter(Boolean)
      .join('; ');
  } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
    reason = parsed.message.trim();
  }

  // When the structured reason is empty or uselessly generic, append the raw
  // body so surrounding fields aren't lost behind a bare "Bad Request".
  if (!reason || /^bad request$/i.test(reason)) {
    const snippet = body.length > 600 ? `${body.slice(0, 600)}…` : body;
    return reason ? `${reason} (${snippet})` : snippet;
  }
  return reason;
}

/**
 * Extract a reason from a Responses-API stream error event (`type: "error"`)
 * or a `response.failed` event's `error` object. Falls back to a compact JSON
 * snippet of the event so an error with no `message`/`code` (which the backend
 * does emit, e.g. on oversized input) still surfaces something diagnostic.
 */
export function extractStreamErrorReason(
  ev: Record<string, unknown> | undefined,
  fallback: string
): string {
  if (!ev || typeof ev !== 'object') return fallback;
  const message = typeof ev.message === 'string' ? ev.message.trim() : '';
  const code = typeof ev.code === 'string' ? ev.code.trim() : '';
  const param = typeof ev.param === 'string' ? ev.param.trim() : '';
  if (message) {
    return [message, code && `(${code})`, param && `[param: ${param}]`].filter(Boolean).join(' ');
  }
  if (code) return code;
  try {
    return `${fallback}: ${JSON.stringify(ev).slice(0, 600)}`;
  } catch {
    return fallback;
  }
}

/**
 * Reasoning-summary opt-in (`reasoning: { summary }`) is only valid on models
 * that actually have a reasoning track; sending it to a non-reasoning model
 * 400s. Gate by id prefix:
 *
 *   - `o1`, `o3`, `o4`        — o-series, always reasoning
 *   - `gpt-5*`                — gpt-5 family broadly (covers gpt-5, gpt-5.5,
 *                                gpt-5-codex, etc.); narrow here if a future
 *                                `-nano`/`-mini` variant 400s
 *   - `*reasoning*`           — explicit marker for anything else
 */
function modelSupportsReasoning(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return (
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.startsWith('gpt-5') ||
    id.includes('reasoning')
  );
}

/** A stop that ended the response before it finished (the output limit). */
function isCutOff(stopReason: string): boolean {
  return (
    stopReason === 'max_output_tokens' || stopReason === 'length' || stopReason === 'max_tokens'
  );
}

function toUnifiedStopReason(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return 'end_turn';
  if (raw === 'tool_calls' || raw === 'tool_use' || raw === 'function_call') return 'tool_use';
  if (raw === 'stop' || raw === 'end_turn' || raw === 'completed') return 'end_turn';
  return raw;
}

interface ResponsesTextToolCallExtraction {
  text: string;
  thinkingText: string;
  toolCalls: ToolCall[];
}

function findBalancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

/**
 * Some Responses-API providers (notably Codex) sometimes emit a textual
 * fallback like `[tool_call:action] {"tool":"file_read","params":{...}}`
 * instead of a native function-call item. Treat that as a real tool call
 * rather than persisting it as user-visible assistant text. Conservative:
 * only recognizes the explicit bracket marker followed by balanced JSON,
 * and should only run when no native tool calls were parsed.
 */
function extractResponsesTextToolCalls(text: string): ResponsesTextToolCallExtraction {
  const markerRe = /\[tool_call:([A-Za-z0-9_-]+)\]\s*/g;
  const toolCalls: ToolCall[] = [];
  const keep: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = markerRe.exec(text)) !== null) {
    const markerStart = match.index;
    const jsonStart = markerRe.lastIndex;
    const end = findBalancedJsonEnd(text, jsonStart);
    if (end < 0) continue;

    const parsed = safeJsonParse<Record<string, unknown>>(text.slice(jsonStart, end));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    keep.push(text.slice(cursor, markerStart));
    const name = match[1]!;
    toolCalls.push({
      id: `responses-text-call-${toolCalls.length + 1}`,
      name,
      input: parsed,
    });
    cursor = end;
    markerRe.lastIndex = end;
  }

  if (toolCalls.length === 0) return { text, thinkingText: '', toolCalls };
  keep.push(text.slice(cursor));
  const thinkingText = keep.join('').trim();
  return {
    text: '',
    thinkingText,
    toolCalls,
  };
}

export interface ResponsesFunctionTool {
  type: 'function';
  strict: false;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Advertise tools on the Responses wire. Names go through the request-scoped
 * `sanitizer` (no-dots grammar) so an id like `get.time` or an MCP `a:b` reaches
 * the backend as a legal function name; the inbound path resolves the echoed
 * name back. Schemas are flattened because the codex/copilot Responses backends
 * 400 on top-level `anyOf`/`oneOf`/`allOf`.
 */
export function toResponsesTools(
  tools: NonNullable<ProviderChatOptions['tools']>,
  sanitizer: ToolNameSanitizer
): ResponsesFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    // Responses otherwise attempts strict normalization, making optional fields required.
    // Snaglet schemas deliberately support omitted patch fields; runtime handlers validate them.
    // https://developers.openai.com/api/docs/guides/function-calling#strict-mode
    strict: false,
    name: sanitizer.sanitize(tool.id),
    description: tool.description,
    parameters: normalizeAnthropicInputSchema(getToolParametersSchema(tool)),
  }));
}

type ResponsesContentPart =
  | { type: 'input_text' | 'output_text'; text: string }
  | { type: 'input_image'; image_url: string };

type ResponsesMessageItem = {
  role: 'user' | 'assistant';
  content: ResponsesContentPart[];
};

/**
 * Assistant function call from a prior turn (Responses API native shape). Must
 * appear as a sibling item in `input`, not flattened into message content —
 * otherwise the model sees the serialized text in history and starts imitating
 * it instead of using the real tool-call mechanism.
 */
type ResponsesFunctionCallItem = {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
};

/**
 * Result of a prior tool call. `call_id` must match the corresponding
 * function_call item's `call_id` so the model can pair them.
 */
type ResponsesFunctionCallOutputItem = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

/**
 * Convert one ProviderMessage into one or more Responses-API input items.
 * An assistant turn with tool_use expands into a message item (text reply,
 * if any) followed by one function_call item per tool_use block. A user
 * turn carrying tool_result blocks expands into one function_call_output
 * per result with no surrounding message — results are not user messages.
 *
 * `sanitizer` maps every replayed `tool_use.name` to its legal wire name so a
 * single poisoned historical name (e.g. `action→<id>`, or a dotted/`:` name)
 * can't 400 the whole request. `call_id` correlation is by id, never by name,
 * so sanitizing here can't break function_call ↔ function_call_output pairing.
 */
export function toResponsesInputItems(
  message: ProviderMessage,
  sanitizer: ToolNameSanitizer
): ResponsesInputItem[] {
  if (typeof message.content === 'string') {
    return [
      {
        role: message.role,
        content: [
          {
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text: message.content,
          },
        ],
      },
    ];
  }

  if (message.role === 'assistant') {
    const items: ResponsesInputItem[] = [];
    const textParts: string[] = [];
    const toolCallItems: ResponsesFunctionCallItem[] = [];

    for (const block of message.content) {
      const b = block as { type?: string };
      if (b.type === 'text') {
        textParts.push((block as { text: string }).text);
      } else if (b.type === 'tool_use') {
        const toolUse = block as ToolUseBlock;
        toolCallItems.push({
          type: 'function_call',
          call_id: toolUse.id,
          name: sanitizer.sanitize(toolUse.name),
          arguments: JSON.stringify(toolUse.input ?? {}),
        });
      }
    }

    // Only emit a message item when there's actual assistant prose. An empty
    // output_text next to a function_call confuses the model into thinking the
    // prior turn was "silent + tool call", which it shouldn't have to ack.
    const text = textParts.filter(Boolean).join('\n');
    if (text) {
      items.push({
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      });
    }
    items.push(...toolCallItems);
    return items;
  }

  // user (or system, fallback): may carry tool_result blocks.
  const blocks = message.content as Array<unknown>;
  const toolResultItems: ResponsesFunctionCallOutputItem[] = [];
  const parts: ResponsesContentPart[] = [];
  // Images inside a tool_result are re-emitted as a following user message
  // (the Responses `function_call_output` channel is text-only).
  const followupImageParts: ResponsesContentPart[] = [];

  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_result') {
      const toolResult = block as ToolResultBlock;
      // `function_call_output.output` is text-only; images follow as a user
      // message (see followupImageParts) so the model still sees them.
      const { text, images } = splitToolResultContent(toolResult.content);
      toolResultItems.push({
        type: 'function_call_output',
        call_id: toolResult.tool_use_id,
        output: text || '[tool result]',
      });
      for (const img of images) {
        followupImageParts.push({
          type: 'input_image',
          image_url:
            img.source.type === 'base64'
              ? `data:${img.source.media_type};base64,${img.source.data}`
              : img.source.url,
        });
      }
    } else if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'input_text', text: b.text });
    } else if (b.type === 'image') {
      const src = b.source as
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string }
        | undefined;
      if (!src) continue;
      const imageUrl =
        src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url;
      parts.push({ type: 'input_image', image_url: imageUrl });
    }
  }

  const items: ResponsesInputItem[] = [];
  if (parts.length > 0) {
    items.push({ role: 'user', content: parts });
  }
  items.push(...toolResultItems);
  if (followupImageParts.length > 0) {
    items.push({ role: 'user', content: followupImageParts });
  }

  // Defensive: never emit zero items for a non-empty message — the API expects
  // every input message to map to at least one item, and a silent drop would
  // scramble the model's view of turn ordering.
  if (items.length === 0) {
    items.push({ role: 'user', content: [{ type: 'input_text', text: '' }] });
  }
  return items;
}

interface ToolCallState {
  id: string;
  name: string;
  args: string;
}

export interface ResponsesSSEResult {
  text: string;
  thinkingContent?: string;
  toolCalls?: ToolCall[];
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export async function collectResponsesSSE(
  body: ReadableStream<Uint8Array>,
  onChunk?: OnChunkCallback,
  onThinkingChunk?: OnThinkingChunkCallback,
  sanitizer?: ToolNameSanitizer,
  onUsage?: OnUsageCallback,
  /** Fired on every raw read from the stream (see ProviderChatOptions.onStreamActivity). */
  onActivity?: () => void
): Promise<ResponsesSSEResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let thinkingContent = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let stopReason = 'end_turn';

  const toolCalls = new Map<string, ToolCallState>();
  const itemToCallKey = new Map<string, string>();

  const upsertToolCallFromItem = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const item = value as Record<string, unknown>;
    if (String(item.type ?? '') !== 'function_call') return;

    const itemId = String(item.id ?? '');
    const callId = String(item.call_id ?? '');
    const key = callId || itemId;
    if (!key) return;

    const existing = toolCalls.get(key) ??
      (itemId ? toolCalls.get(itemId) : undefined) ?? {
        id: key,
        name: '',
        args: '',
      };
    if (callId) existing.id = callId;

    const name = String(item.name ?? '');
    if (name) existing.name = name;

    const args = item.arguments ?? item.input;
    if (typeof args === 'string') {
      existing.args = args;
    } else if (args && typeof args === 'object') {
      existing.args = JSON.stringify(args);
    }

    toolCalls.set(key, existing);
    if (itemId && callId && itemId !== callId) {
      toolCalls.delete(itemId);
    }
    if (itemId) itemToCallKey.set(itemId, key);
  };

  const updateToolArgs = (identifier: unknown, value: unknown, replace = false): void => {
    const id = String(identifier ?? '');
    if (!id) return;
    const key = itemToCallKey.get(id) ?? id;
    if (!itemToCallKey.has(id)) itemToCallKey.set(id, key);
    const existing = toolCalls.get(key) ?? { id: key, name: '', args: '' };

    let next = '';
    if (typeof value === 'string') {
      next = value;
    } else if (value && typeof value === 'object') {
      next = JSON.stringify(value);
    }

    if (replace) existing.args = next;
    else existing.args += next;
    toolCalls.set(key, existing);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        const ev = safeJsonParse<Record<string, unknown> | null>(raw, null);
        if (!ev) continue;

        const type = ev.type as string | undefined;

        if (type === 'error') {
          const errObj = (ev.error as Record<string, unknown> | undefined) ?? ev;
          throw new Error(extractStreamErrorReason(errObj, 'Responses stream error'));
        }
        if (type === 'response.failed') {
          const resp = ev.response as { error?: Record<string, unknown> } | undefined;
          throw new Error(extractStreamErrorReason(resp?.error ?? ev, 'Responses request failed'));
        }

        if (type === 'response.output_text.delta') {
          const delta = String((ev.delta as string | undefined) ?? '');
          text += delta;
          if (delta) onChunk?.(delta);
        }

        // Reasoning deltas — emitted on o-series + reasoning-capable models
        // when the request opts in with `reasoning: { summary: ... }`. The
        // Responses API publishes a few variants — `reasoning_summary_text.delta`
        // (summary-mode), `reasoning_text.delta` (raw). Catch any
        // `response.reasoning*` event carrying a `delta` so new flavors keep
        // working without code changes here.
        if (
          typeof type === 'string' &&
          type.startsWith('response.reasoning') &&
          type.endsWith('.delta')
        ) {
          const delta = String((ev.delta as string | undefined) ?? '');
          if (delta) {
            thinkingContent += delta;
            onThinkingChunk?.(delta);
          }
        }

        // When one reasoning part ends and another begins, separate them so
        // multi-part summaries stay readable. Only fires after we've
        // accumulated something — leading newlines look broken.
        if (type === 'response.reasoning_summary_part.added' && thinkingContent.length > 0) {
          const sep = '\n\n';
          thinkingContent += sep;
          onThinkingChunk?.(sep);
        }

        if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          upsertToolCallFromItem(ev.item);
        }

        if (type === 'response.function_call_arguments.delta') {
          updateToolArgs(ev.item_id ?? ev.call_id, ev.delta);
        }

        if (type === 'response.function_call_arguments.done') {
          updateToolArgs(ev.item_id ?? ev.call_id, ev.arguments, true);
        }

        // A response stopped before it finished: `incomplete_details.reason`
        // is `max_output_tokens` when the output limit cut it off.
        if (type === 'response.incomplete') {
          const resp = ev.response as Record<string, unknown> | undefined;
          const details = resp?.incomplete_details as { reason?: unknown } | undefined;
          stopReason =
            typeof details?.reason === 'string' && details.reason
              ? details.reason
              : 'max_output_tokens';
          const usage = resp?.usage as Record<string, unknown> | undefined;
          if (usage) {
            inputTokens = Number(usage.input_tokens ?? 0) || undefined;
            outputTokens = Number(usage.output_tokens ?? 0) || undefined;
            onUsage?.({ inputTokens, outputTokens, cacheReadTokens });
          }
        }

        if (type === 'response.completed' || type === 'response.done') {
          const resp = ev.response as Record<string, unknown> | undefined;
          // The Responses API reports usage only on the terminal event, so
          // this reports once per call — at the end. No mid-stream signal
          // exists here and none is invented.
          const usage = resp?.usage as Record<string, unknown> | undefined;
          if (usage) {
            inputTokens = Number(usage.input_tokens ?? 0) || undefined;
            outputTokens = Number(usage.output_tokens ?? 0) || undefined;
            const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
            // Responses reports cache hits, but no Anthropic-style cache-write
            // quantity. Preserve that distinction instead of deriving writes
            // from fresh input, which is not guaranteed to populate a cache.
            cacheReadTokens = Number(inputDetails?.cached_tokens ?? 0) || undefined;
            onUsage?.({ inputTokens, outputTokens, cacheReadTokens });
          }

          const output = resp?.output;
          if (Array.isArray(output)) {
            for (const item of output) upsertToolCallFromItem(item);
          }

          const resolvedStopReason = toUnifiedStopReason(resp?.stop_reason ?? resp?.finish_reason);
          if (resolvedStopReason) stopReason = resolvedStopReason;
        }
      }
    }
  }

  // The model echoes back the SANITIZED name it was advertised; map it back to
  // the real tool id so downstream dispatch + persistence see the canonical id.
  const resolveName = (name: string): string => (sanitizer ? sanitizer.resolve(name) : name);

  const parsedToolCalls: ToolCall[] = [];
  for (const toolCall of toolCalls.values()) {
    if (!toolCall.name) continue;
    parsedToolCalls.push({
      id: toolCall.id || `responses-call-${parsedToolCalls.length + 1}`,
      name: resolveName(toolCall.name),
      input: parseToolInputJson(toolCall.args || '{}'),
    });
  }

  if (parsedToolCalls.length === 0) {
    const extracted = extractResponsesTextToolCalls(text);
    if (extracted.toolCalls.length > 0) {
      text = extracted.text;
      if (extracted.thinkingText) {
        const sep = thinkingContent.length > 0 ? '\n\n' : '';
        thinkingContent = `${thinkingContent}${sep}${extracted.thinkingText}`;
      }
      parsedToolCalls.push(
        ...extracted.toolCalls.map((call) => ({ ...call, name: resolveName(call.name) }))
      );
    }
  }

  // Parsed tool calls make this a tool turn, unless the response was cut off:
  // then the last call may be truncated and none of them may run.
  if (parsedToolCalls.length > 0 && !isCutOff(stopReason)) stopReason = 'tool_use';

  return {
    text,
    thinkingContent: thinkingContent || undefined,
    toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
    stopReason,
    inputTokens,
    outputTokens,
    cacheReadTokens,
  };
}

//
// Each provider builds its own headers, URL, and (optionally) instructions /
// model id, then hands the request off here. `callResponsesEndpoint` builds
// the canonical Responses-API body, runs the fetch, parses the SSE stream,
// and surfaces errors through `errorTransform` if provided.

export interface CallResponsesEndpointArgs {
  url: string;
  headers: Record<string, string>;
  agent: SnagletAgent;
  messages: ProviderMessage[];
  options?: ProviderChatOptions;
  onChunk?: OnChunkCallback;
  /** Provider id used for payload logging + the default failure message. */
  providerLabel: string;
  /** Optional override: model id sent in the body. Defaults to `agent.modelId`. */
  modelId?: string;
  /** Optional override: instructions sent in the body. Defaults to `agent.systemPrompt`. */
  instructions?: string;
  /**
   * Optional transform applied to the upstream error message before it's
   * wrapped in `new Error(...)`. Lets the provider quarantine bad models,
   * append hints, etc.
   */
  errorTransform?: (rawMessage: string) => string | Promise<string>;
  /**
   * Optional `prompt_cache_key` (see shared/promptCacheKey.ts). Codex passes
   * one; Copilot does not, since its backend refuses fields it does not know.
   */
  promptCacheKey?: string;
}

export async function callResponsesEndpoint({
  url,
  headers,
  agent,
  messages,
  options,
  onChunk,
  providerLabel,
  modelId,
  instructions,
  errorTransform,
  promptCacheKey,
}: CallResponsesEndpointArgs): Promise<ProviderChatResult> {
  // One request-scoped sanitizer, shared across all three wire sites (advertised
  // tool defs, replayed function_call names, inbound name resolution) so the
  // round-trip stays correlated. The Responses wire uses the stricter no-dots
  // grammar. Seed the live tool ids first so canonical tools win the un-suffixed
  // wire name and only stale historical names take a `_2` suffix.
  const sanitizer = createToolNameSanitizer(NO_DOTS_TOOL_NAME_GRAMMAR);
  const toolList = options?.tools ?? [];
  for (const tool of toolList) sanitizer.sanitize(tool.id);

  const inputItems = messages.flatMap((m) => toResponsesInputItems(m, sanitizer));
  const resolvedModel = modelId ?? agent.modelId ?? '';
  const resolvedInstructions = instructions ?? agent.systemPrompt ?? DEFAULT_RESPONSES_INSTRUCTIONS;

  const body: Record<string, unknown> = {
    model: resolvedModel,
    store: false,
    stream: true,
    input: inputItems,
    instructions: resolvedInstructions,
    text: { verbosity: 'medium' },
  };
  if (promptCacheKey) body.prompt_cache_key = promptCacheKey;

  if (toolList.length > 0) {
    body.tools = toResponsesTools(toolList, sanitizer);
  }
  if (modelSupportsReasoning(resolvedModel)) {
    body.reasoning = { summary: 'auto' };
  }

  logProviderPayload(providerLabel, agent, body, headers);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    const reason = extractResponsesErrorReason(rawBody);
    // The upstream reason is easily lost downstream (errorTransform, UI
    // truncation), and a bare "Bad Request" hides what the backend rejected.
    // Log the full failure once here — status, request shape, and raw body —
    // so the real cause is always recoverable from server logs.
    logger.error(`[${providerLabel}] responses request failed`, {
      status: res.status,
      model: resolvedModel,
      requestShape: {
        inputItems: inputItems.length,
        hasTools: Array.isArray(body.tools) && body.tools.length > 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        hasReasoning: Boolean(body.reasoning),
        verbosity: (body.text as { verbosity?: string } | undefined)?.verbosity,
      },
      requestId: res.headers.get('x-request-id') ?? res.headers.get('cf-ray') ?? undefined,
      body: rawBody.slice(0, 4000),
    });
    const message = reason
      ? `${providerLabel} request failed (${res.status}): ${reason}`
      : `${providerLabel} request failed (${res.status})`;
    const transformed = errorTransform ? await errorTransform(message) : message;
    throw new Error(transformed);
  }

  if (!res.body) throw new Error(`${providerLabel} returned no response body`);

  const result = await collectResponsesSSE(
    res.body,
    onChunk,
    options?.onThinkingChunk,
    sanitizer,
    options?.onUsage,
    options?.onStreamActivity
  );

  return {
    reply: result.text,
    thinkingContent: result.thinkingContent,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
    },
  };
}
