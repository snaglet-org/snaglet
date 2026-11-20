// Turn replay — rebuild one agent's past turn (reasoning + tool calls + final
// text) as a deterministic sequence of ProviderMessages, so an agent's history
// forms a byte-identical, cacheable prefix across its future runs and the agent
// remembers what it actually did.
//
// This is the committed perception model (no feature flag): the whole replay +
// mid-run injection path is unconditional. Pure + side-effect-free on purpose:
// the determinism test (reconstructTurn.test.ts) is the cache-safety proof.

import type { ProviderMessage, ToolUseBlock } from '@server/services/ProviderChatService/types';

/**
 * One tool call from an agent's run, normalized for replay.
 *
 * `id` must be a stable identifier (the `agent_activity_log` row id). It becomes
 * the `tool_use_id`, so the same source row always yields the same id — that is
 * what keeps the rebuilt prefix byte-identical across runs (cache-safe). Never
 * derive it from anything random or time-based.
 */
export interface ReplayToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Stringified tool result. Mark failures with `isError`. */
  output: string;
  isError?: boolean;
}

export interface ReconstructTurnInput {
  /**
   * True when building the payload for the agent whose run this is (the
   * "actor") — it gets the full tool + reasoning replay. False for observers
   * (other agents), who get only this agent's spoken/final text. (Peers see
   * messages, not tool runs. This is the seam to later toggle into full
   * transparency.)
   */
  isActor: boolean;
  /**
   * The agent's reasoning for this run, already concatenated to text. Replayed
   * as a plain assistant text block — not a `thinking` block: we don't store
   * thinking signatures, and a text block needs none and caches the same.
   * Null/blank skips it.
   */
  reasoning?: string | null;
  /** The run's tool calls, in execution order. */
  toolCalls?: ReplayToolCall[];
  /** The agent's final spoken text for this turn (`messages.content`). */
  finalText?: string | null;
}

type AssistantBlock = { type: 'text'; text: string } | ToolUseBlock;

/**
 * Rebuild one agent turn as a deterministic ProviderMessage sequence.
 *
 * Determinism is the whole point: identical input → byte-identical output, so a
 * replayed turn is a stable cache prefix on every subsequent run.
 *
 * Actor turn → `[assistant(reasoning + tool_use), user(tool_result)]`* then a
 *   closing `assistant(final text)`. Tool calls are replayed as sequential
 *   single-tool cycles (one `tool_use` per assistant message). This is
 *   deterministic and API-valid; it does not reproduce live parallel-call
 *   batching (at worst that costs the immediate within-TTL follow-up's cache
 *   hit, never the cross-run prefix).
 *
 * Observer turn → `[assistant(final text)]` only; no tool/reasoning detail.
 *
 * Structural rules (per Anthropic tool-use docs): a `tool_use` lives in the
 * assistant message and its `tool_result` in the immediately following user
 * message, paired by `tool_use_id`. Reasoning is placed once, at the front of
 * the first assistant message.
 */
export function reconstructTurn(input: ReconstructTurnInput): ProviderMessage[] {
  const finalText = input.finalText && input.finalText.trim() ? input.finalText : null;

  // Observer projection: messages only.
  if (!input.isActor) {
    return finalText ? [{ role: 'assistant', content: finalText }] : [];
  }

  const messages: ProviderMessage[] = [];
  const toolCalls = input.toolCalls ?? [];
  const reasoning = input.reasoning && input.reasoning.trim() ? input.reasoning : null;

  // Reasoning attaches to the first assistant message — alongside the first
  // tool_use, or (if no tools ran) the final text.
  let pending: AssistantBlock[] = [];
  if (reasoning) pending.push({ type: 'text', text: reasoning });

  for (const tc of toolCalls) {
    pending.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    messages.push({ role: 'assistant', content: pending });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tc.id,
          content: tc.output,
          ...(tc.isError ? { is_error: true } : {}),
        },
      ],
    });
    pending = [];
  }

  if (finalText) pending.push({ type: 'text', text: finalText });
  if (pending.length > 0) {
    // A pure-text closing turn collapses to a TextMessage; mixed content keeps
    // the block array. Both are stable for identical input.
    if (pending.every((b) => b.type === 'text')) {
      const text = pending.map((b) => (b as { type: 'text'; text: string }).text).join('\n\n');
      messages.push({ role: 'assistant', content: text });
    } else {
      messages.push({ role: 'assistant', content: pending });
    }
  }

  return messages;
}
