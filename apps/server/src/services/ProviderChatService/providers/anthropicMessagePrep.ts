// Anthropic message-array preparation: pure, network-free, unit-testable. The
// last-mile stage after all upstream rewriting (compressMessages,
// condenseProcessedToolResults, replay assembly). It guarantees Anthropic's
// structural rules: no empty or trailing-whitespace assistant messages,
// alternating roles, no trailing assistant message, and every tool_use/
// tool_result paired across adjacent messages. The tool-pairing guard is a
// safety net, not license for sloppy compaction: converting an orphaned block
// to text loses structure, so it reports a count callers can alarm on.
//
// Thinking blocks: only the newest assistant turn that carries them keeps
// them (the tool turn the model is continuing from). Dropping a leading run of
// thinking blocks is always valid; older blocks are the ones an upstream edit
// (a condensed tool result, a compaction) is most likely to have invalidated.

import type { ProviderMessage, ToolResultBlock, ToolUseBlock } from '../types';
import { flattenToolResultContentToText } from '../types';
import { TURN_CONTEXT_SENTINEL } from '@server/services/SystemPromptComposer/composeTurnContextTail';

/** Working message shape during preparation (content may be string or blocks). */
export type AnthropicApiMessage = {
  role: 'user' | 'assistant';
  content: ProviderMessage['content'];
  /**
   * Carried through from ProviderMessage.ephemeral (TextMessage) so cache-
   * breakpoint placement can locate the per-turn ephemeral tail structurally
   * rather than by sniffing sentinel substrings. A merged run of same-role
   * messages is ephemeral if any member was (the merged block spans the tail).
   */
  ephemeral?: boolean;
};

export interface AnthropicPrepResult {
  apiMessages: AnthropicApiMessage[];
  /** Orphaned tool_result blocks converted to text by the pairing guard. */
  orphanedToolResults: number;
  /** Orphaned tool_use blocks converted to text by the pairing guard. */
  orphanedToolUses: number;
}

/**
 * Sanitize, merge, trailing-pop, and tool-pair a message array for the
 * Anthropic Messages API. Pure: never touches the network, never reads config,
 * and does not mutate the input array. Cache-control markers are applied by the
 * caller after this returns.
 */
export function prepareAnthropicApiMessages(messages: ProviderMessage[]): AnthropicPrepResult {
  // Anthropic API requires:
  //  - assistant messages must not have empty content
  //  - assistant messages must not end with trailing whitespace
  //  - alternating user/assistant roles
  const sanitized: AnthropicApiMessage[] = messages
    .filter((message) => {
      if (message.role === 'assistant' && typeof message.content === 'string') {
        return message.content.trim().length > 0;
      }
      return true;
    })
    .map((message) => {
      // Carry the structural ephemeral flag through (only TextMessage has it).
      const ephemeral = (message as { ephemeral?: boolean }).ephemeral === true;
      if (message.role === 'assistant' && typeof message.content === 'string') {
        return { role: message.role, content: message.content.trimEnd(), ephemeral };
      }
      return { role: message.role, content: message.content, ephemeral };
    });

  // Merge consecutive same-role messages (filtering may break alternation)
  const apiMessages: AnthropicApiMessage[] = [];
  for (const msg of sanitized) {
    const prev = apiMessages[apiMessages.length - 1];
    if (
      prev &&
      prev.role === msg.role &&
      typeof prev.content === 'string' &&
      typeof msg.content === 'string'
    ) {
      prev.content += '\n\n' + msg.content;
      // A merged run spans the ephemeral tail if any member was ephemeral.
      if (msg.ephemeral) prev.ephemeral = true;
    } else {
      apiMessages.push({ ...msg });
    }
  }

  // Some models (e.g. claude-sonnet-4-6) don't support assistant message prefill.
  // The conversation must end with a user message.
  while (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'assistant') {
    apiMessages.pop();
  }

  if (apiMessages.length === 0) {
    apiMessages.push({ role: 'user', content: '(continue)' });
  }

  // Last-mile tool-pairing guarantee. The API rejects (400) any tool_result
  // whose tool_use is not in the immediately preceding assistant message, and
  // any tool_use with no tool_result in the immediately following user message.
  // Upstream compaction/condensing can orphan either side when a window
  // boundary lands inside a tool cycle (e.g. a compacted head that begins with
  // a tool_result would make every iteration fail). Convert orphaned blocks to
  // plain text so the request is always valid and the information is preserved.
  let orphanedToolResults = 0;
  let orphanedToolUses = 0;
  for (let i = 0; i < apiMessages.length; i++) {
    const msg = apiMessages[i]!;
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;
    if (msg.role === 'user') {
      const prev = apiMessages[i - 1];
      const validIds = new Set<string>();
      if (prev?.role === 'assistant' && Array.isArray(prev.content)) {
        for (const b of prev.content) {
          if ((b as { type: string }).type === 'tool_use') validIds.add((b as ToolUseBlock).id);
        }
      }
      msg.content = (msg.content as Array<{ type: string }>).map((b) => {
        if (b.type !== 'tool_result') return b;
        const tr = b as ToolResultBlock;
        if (validIds.has(tr.tool_use_id)) return b;
        orphanedToolResults++;
        const body = flattenToolResultContentToText(tr.content);
        return {
          type: 'text' as const,
          text: `[tool result from a compacted earlier turn${tr.is_error ? ' (error)' : ''}]\n${body}`,
        };
      }) as typeof msg.content;
    } else if (msg.role === 'assistant') {
      const next = apiMessages[i + 1];
      const answeredIds = new Set<string>();
      if (next?.role === 'user' && Array.isArray(next.content)) {
        for (const b of next.content) {
          if ((b as { type: string }).type === 'tool_result') {
            answeredIds.add((b as ToolResultBlock).tool_use_id);
          }
        }
      }
      msg.content = (msg.content as Array<{ type: string }>).map((b) => {
        if (b.type !== 'tool_use') return b;
        const tu = b as ToolUseBlock;
        if (answeredIds.has(tu.id)) return b;
        orphanedToolUses++;
        return {
          type: 'text' as const,
          text: `[called tool ${tu.name} in a turn whose result was compacted away]`,
        };
      }) as typeof msg.content;
    }
  }

  return { apiMessages: keepLatestThinking(apiMessages), orphanedToolResults, orphanedToolUses };
}

const isThinkingBlock = (block: unknown): boolean => {
  const type = (block as { type?: unknown } | null)?.type;
  return type === 'thinking' || type === 'redacted_thinking';
};

/** True when any message carries a thinking or redacted_thinking block. */
export function hasThinkingBlocks(messages: AnthropicApiMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some(isThinkingBlock));
}

/** The same messages with every thinking and redacted_thinking block removed. */
export function withoutThinking(messages: AnthropicApiMessage[]): AnthropicApiMessage[] {
  return messages.map((m) =>
    Array.isArray(m.content) && m.content.some(isThinkingBlock)
      ? { ...m, content: m.content.filter((b) => !isThinkingBlock(b)) as typeof m.content }
      : m
  );
}

/** Thinking blocks kept on the newest assistant message that has them, removed elsewhere. */
function keepLatestThinking(messages: AnthropicApiMessage[]): AnthropicApiMessage[] {
  let latest = -1;
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(isThinkingBlock)) {
      latest = i;
    }
  });
  if (latest < 0) return messages;
  const stripped = withoutThinking(messages);
  stripped[latest] = messages[latest]!;
  return stripped;
}

/**
 * True when Anthropic refused a request because a replayed thinking block no
 * longer matches the conversation before it ("Invalid `signature` in
 * `thinking` block").
 */
export function isThinkingBindingRejection(message: string): boolean {
  return /invalid\s+`?signature`?\s+in\s+`?(?:redacted_)?thinking`?\s+block/i.test(message);
}

/** TTLs Anthropic accepts on an ephemeral cache_control marker. */
export type CacheTtl = '5m' | '1h';

/**
 * Give the system prompt's cache breakpoints the run's TTL. Anthropic rejects
 * a request whose later breakpoint has a longer TTL than an earlier one, and
 * tools come before system, so the system markers must match the tool marker.
 * Pure: returns a new array; a plain-string system prompt passes through.
 */
export function applySystemCacheTtl(system: unknown, cacheTtl: CacheTtl): unknown {
  if (!Array.isArray(system)) return system;
  return system.map((block: Record<string, unknown>) =>
    block.cache_control ? { ...block, cache_control: { type: 'ephemeral', ttl: cacheTtl } } : block
  );
}

/**
 * Place the two message-array cache breakpoints (tools and system take two
 * more of the 4-breakpoint budget elsewhere). Pure: returns a new array.
 *   1. Durable prefix: the last message before the per-turn ephemeral tail.
 *   2. Tail: the very last message, for within-run tool-loop iterations.
 * The turn-context tail is never persisted or replayed, and cache entries
 * match only an exact leading byte sequence, so an entry spanning the tail
 * never matches next run. The durable breakpoint sits on replayed history,
 * which stays byte-identical as the thread grows.
 */
export function applyMessageCacheBreakpoints(
  messages: AnthropicApiMessage[],
  cacheTtl: CacheTtl
): AnthropicApiMessage[] {
  // Clone, stripping any inherited cache_control: the message objects share
  // content references with upstream thread state, so writing markers in place
  // would accumulate them across turns and trip the 4-breakpoint cap.
  const out: AnthropicApiMessage[] = messages.map((msg) =>
    Array.isArray(msg.content)
      ? {
          ...msg, // preserves `ephemeral`
          content: msg.content.map((block) => {
            const { cache_control: _stripped, ...rest } = block as Record<string, unknown>;
            return rest;
          }) as AnthropicApiMessage['content'],
        }
      : { ...msg }
  );

  const mark = (index: number): void => {
    const msg = out[index];
    if (!msg) return;
    if (typeof msg.content === 'string') {
      if (msg.content.length === 0) return;
      msg.content = [
        { type: 'text', text: msg.content, cache_control: { type: 'ephemeral', ttl: cacheTtl } },
      ] as unknown as AnthropicApiMessage['content'];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const blocks = msg.content as Array<Record<string, unknown>>;
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: 'ephemeral', ttl: cacheTtl },
      };
    }
  };

  // Locate the per-turn ephemeral tail by the `ephemeral` flag, not by sniffing
  // content: a sentinel phrase quoted in older history would match first and
  // slide the durable breakpoint backwards, silently re-billing the prefix.
  // The flag wins outright; the TURN_CONTEXT_SENTINEL substring is only a
  // fallback when no message is flagged (a message without the flag). Merge
  // (above) ORs the flag onto a same-role run, so a tail glued onto the newest
  // human message is still found, and marking the message before it stays
  // correct because that human message is new content this run anyway.
  const flaggedIndex = out.findIndex((m) => m.ephemeral === true);
  const ephemeralIndex =
    flaggedIndex >= 0
      ? flaggedIndex
      : out.findIndex(
          (m) => typeof m.content === 'string' && m.content.includes(TURN_CONTEXT_SENTINEL)
        );
  const lastIndex = out.length - 1;
  const durableIndex = ephemeralIndex > 0 ? ephemeralIndex - 1 : -1;
  if (durableIndex >= 0 && durableIndex !== lastIndex) mark(durableIndex);
  mark(lastIndex);
  // `ephemeral` is Snaglet's, not Anthropic's. It exists only to locate the tail
  // above; the Messages API rejects unknown top-level message keys outright
  // ("messages.0.ephemeral: Extra inputs are not permitted", 400), so every
  // request fails if it survives to the wire. Strip it here — the last place
  // that reads it — so no caller can forget.
  return out.map(({ ephemeral: _internal, ...wire }) => wire as AnthropicApiMessage);
}
