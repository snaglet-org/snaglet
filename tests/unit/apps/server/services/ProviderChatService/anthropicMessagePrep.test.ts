/**
 * anthropicMessagePrep — the last-mile Anthropic payload preparation, the
 * safety net after every upstream rewriting layer. Well-formed input passes
 * through untouched (no spurious conversions). A genuinely orphaned block (a
 * tool_result with no preceding tool_use, or a tool_use with no following
 * tool_result) becomes an equivalent text block instead of a 400 from the API;
 * the conversion counters are what the provider logs and what the compaction
 * boundary tests assert stays at zero.
 */

import { describe, expect, test } from '@jest/globals';
import { prepareAnthropicApiMessages } from '@server/services/ProviderChatService/providers/anthropicMessagePrep';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';

const asMsgs = (m: unknown[]): ProviderMessage[] => m as ProviderMessage[];

const userText = (text: string): ProviderMessage => ({ role: 'user', content: text });
const assistantText = (text: string): ProviderMessage => ({ role: 'assistant', content: text });
const toolUse = (id: string, name = 'do_thing'): ProviderMessage =>
  ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] }) as ProviderMessage;
const toolResult = (id: string, content = 'ok'): ProviderMessage =>
  ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  }) as ProviderMessage;

/** Structural orphan check mirroring Anthropic's adjacency rule. */
const isValidPairing = (messages: ProviderMessage[]): boolean => {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === 'user') {
      const prev = messages[i - 1];
      const validIds = new Set<string>();
      if (prev && Array.isArray(prev.content)) {
        for (const b of prev.content as Array<Record<string, unknown>>) {
          if (b.type === 'tool_use') validIds.add(b.id as string);
        }
      }
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result' && !validIds.has(b.tool_use_id as string)) return false;
      }
    } else {
      const next = messages[i + 1];
      const answered = new Set<string>();
      if (next && Array.isArray(next.content)) {
        for (const b of next.content as Array<Record<string, unknown>>) {
          if (b.type === 'tool_result') answered.add(b.tool_use_id as string);
        }
      }
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_use' && !answered.has(b.id as string)) return false;
      }
    }
  }
  return true;
};

describe('prepareAnthropicApiMessages — tool-pairing guard', () => {
  test('leaves a well-formed tool cycle untouched (no conversions)', () => {
    const input = asMsgs([userText('go'), toolUse('call-1'), toolResult('call-1')]);
    const { apiMessages, orphanedToolResults, orphanedToolUses } =
      prepareAnthropicApiMessages(input);

    expect(orphanedToolResults).toBe(0);
    expect(orphanedToolUses).toBe(0);
    expect(isValidPairing(apiMessages as ProviderMessage[])).toBe(true);
    // The tool_result block is preserved verbatim (still a tool_result).
    const last = apiMessages[apiMessages.length - 1]!;
    expect((last.content as Array<{ type: string }>)[0]!.type).toBe('tool_result');
  });

  test('converts an orphaned tool_result (no preceding tool_use) to text, never 400', () => {
    // This is the live-failure head: a compacted payload that begins with a
    // tool_result whose tool_use was folded away.
    const input = asMsgs([toolResult('orphan-1', 'the result body'), userText('continue please')]);
    const { apiMessages, orphanedToolResults, orphanedToolUses } =
      prepareAnthropicApiMessages(input);

    expect(orphanedToolResults).toBe(1);
    expect(orphanedToolUses).toBe(0);
    expect(isValidPairing(apiMessages as ProviderMessage[])).toBe(true);

    const first = apiMessages[0]!;
    const blocks = first.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]!.type).toBe('text'); // converted
    expect(blocks[0]!.text).toContain('compacted earlier turn');
    expect(blocks[0]!.text).toContain('the result body'); // body preserved
    // No tool_result block survives anywhere.
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(false);
  });

  test('preserves folded-in text when converting a [tool_result, text] orphan', () => {
    const mixed = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'orphan-2', content: 'tool output' },
        { type: 'text', text: '@peer message folded in' },
      ],
    };
    const { apiMessages, orphanedToolResults } = prepareAnthropicApiMessages(asMsgs([mixed]));

    expect(orphanedToolResults).toBe(1);
    const blocks = apiMessages[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(false);
    // Both the converted tool output and the original folded text survive.
    expect(blocks.map((b) => b.text).join('\n')).toContain('tool output');
    expect(blocks.map((b) => b.text).join('\n')).toContain('@peer message folded in');
  });

  test('converts an orphaned tool_use (no following tool_result) to text', () => {
    // Assistant calls a tool, but the answering user turn was compacted away.
    // The trailing-assistant pop would normally drop a truly-final assistant
    // message, so anchor a user turn after it to keep the tool_use in place.
    const input = asMsgs([
      userText('start'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'unanswered-1', name: 'search', input: {} }],
      },
      userText('never mind, do this instead'),
    ]);
    const { apiMessages, orphanedToolResults, orphanedToolUses } =
      prepareAnthropicApiMessages(input);

    expect(orphanedToolUses).toBe(1);
    expect(orphanedToolResults).toBe(0);
    expect(isValidPairing(apiMessages as ProviderMessage[])).toBe(true);

    const assistant = apiMessages.find((m) => m.role === 'assistant')!;
    const blocks = assistant.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.text).toContain('search');
    expect(blocks[0]!.text).toContain('compacted away');
  });

  test('sanitize/merge/pop invariants are preserved', () => {
    const input = asMsgs([
      userText('first'),
      userText('second'), // consecutive user strings → merge
      assistantText('   '), // whitespace-only assistant → dropped
      userText('third'),
      assistantText('trailing assistant'), // trailing assistant → popped
    ]);
    const { apiMessages } = prepareAnthropicApiMessages(input);

    // The blank assistant is dropped before the merge pass, so the three user
    // strings become consecutive and collapse into one; the trailing assistant
    // is popped. One user message remains.
    expect(apiMessages).toHaveLength(1);
    expect(apiMessages[0]!.role).toBe('user');
    expect(apiMessages[0]!.content).toBe('first\n\nsecond\n\nthird');
  });

  test('an all-empty input never yields a zero-message payload', () => {
    const { apiMessages } = prepareAnthropicApiMessages(asMsgs([assistantText('')]));
    expect(apiMessages).toHaveLength(1);
    expect(apiMessages[0]!.role).toBe('user');
    expect(apiMessages[0]!.content).toBe('(continue)');
  });
});
