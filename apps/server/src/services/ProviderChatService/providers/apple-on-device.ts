/**
 * apple-on-device — Apple's on-device FoundationModels LLM (~3B params,
 * macOS 26+ with Apple Intelligence enabled), routed through the
 * `snaglet-apple-chat` Swift sidecar (native/apple-chat/chat.swift) via
 * {@link AppleChatEngine}.
 *
 * Keyless like Ollama/LM Studio: no `assertSecret`, no `pickSecret`; the model
 * runs on this machine and the "request" is an NDJSON line written to a
 * long-lived subprocess, not an HTTP call.
 *
 * Context window is a hard 4096 tokens total (prompt + completion), not the
 * 8192 ContextWindowService default; the `models` seed row and
 * PROVIDER_SAFETY_MARGIN_PCT keep Snaglet's compaction under that budget.
 *
 * Tool calling is not implemented: `options.tools` is ignored and `toolCalls`
 * is always undefined (it is optional in `ProviderChatResult`).
 * FoundationModels' `Tool` protocol needs per-tool types at compile time, so
 * mapping Snaglet's `ToolRow[]` at runtime would need `DynamicGenerationSchema`.
 */

import type { SnagletAgent } from '@server/services/AgentService';
import { getAppleChatEngine, resolveAppleChatAvailability } from '../appleChat/appleChatResolver';
import { flattenToolResultContentToText } from '../types';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyResult,
  ToolResultBlock,
  ToolUseBlock,
} from '../types';

function roleLabel(role: string): string {
  return role === 'assistant' ? 'Assistant' : 'Human';
}

/**
 * Render one ProviderMessage's content as plain text. Handles all four
 * ProviderMessage shapes (text-only chat, so tool_use/tool_result blocks that
 * show up in a thread's history from an EARLIER turn on a different provider
 * are flattened to a readable description rather than dropped or crashing).
 */
function renderMessageText(msg: ProviderMessage): string {
  if (typeof msg.content === 'string') return msg.content;

  const parts: string[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue;
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
        parts.push('[image attached]');
        break;
      case 'tool_use': {
        const useBlock = block as ToolUseBlock;
        parts.push(`[called tool ${useBlock.name}(${JSON.stringify(useBlock.input ?? {})})]`);
        break;
      }
      case 'tool_result': {
        const resultBlock = block as ToolResultBlock;
        const text = flattenToolResultContentToText(resultBlock.content);
        parts.push(resultBlock.is_error ? `[tool error: ${text}]` : `[tool result: ${text}]`);
        break;
      }
      default:
        break;
    }
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Flatten the full (already-compacted, see ContextWindowService) message
 * array into a single prompt string. The sidecar keeps NO state across
 * calls (a fresh LanguageModelSession per request — see chat.swift's header
 * comment) so the entire visible conversation is re-sent every turn, exactly
 * like every other Snaglet provider (chatOllama, chatOpenAI, …) — there is no
 * separate incremental/session-transcript path to keep in sync with Snaglet's own
 * compaction, which is what actually keeps this under the 4096-token budget.
 */
export function renderApplePrompt(messages: ProviderMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const text = renderMessageText(msg).trim();
    if (!text) continue;
    lines.push(`${roleLabel(msg.role)}: ${text}`);
  }
  lines.push('Assistant:');
  return lines.join('\n\n');
}

export async function chatAppleOnDevice(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const engine = getAppleChatEngine();
  if (!engine) {
    throw new Error(
      "apple-on-device is unavailable on this machine (sidecar isn't buildable/present). " +
        'This should not be reachable from the UI once availability gating hides the provider.'
    );
  }

  const prompt = renderApplePrompt(messages);
  // agent.systemPrompt wins when set (live chat relies on that — the composed
  // chat systemBlocks would blow the 4096-token window). But a caller whose
  // agent has no systemPrompt and passes only systemBlocks must not run
  // instruction-less: fold the blocks in as the fallback.
  const blockText = (options?.systemBlocks ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
  const instructions = agent.systemPrompt?.trim() || blockText || undefined;
  // sessionKey groups requests that must never overlap (see appleChatEngine's
  // per-session mutex) — one Snaglet agent+thread pairing.
  const sessionKey = `${agent.id}:${options?.threadId ?? 'no-thread'}`;

  const result = await engine.chat({
    sessionKey,
    prompt,
    instructions,
    maxTokens: options?.maxOutputTokens,
    onChunk,
    signal: options?.signal,
  });

  return {
    reply: result.text,
    stopReason: result.stopReason,
    usage: undefined,
  };
}

export async function verifyAppleOnDevice(_secret?: string): Promise<ProviderVerifyResult> {
  const availability = await resolveAppleChatAvailability();
  if (availability.available) {
    return { valid: true, message: 'Apple on-device model is available on this Mac' };
  }
  return {
    valid: false,
    message: `Apple on-device model is not available (${availability.reason ?? 'unknown'})`,
  };
}
