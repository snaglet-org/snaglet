/**
 * Message-array cache breakpoint placement.
 *
 * The property that matters is prefix survival: the byte sequence a run caches
 * must still be a leading prefix of the next run's request, or Anthropic can
 * never match it and the whole message region is rewritten every run.
 *
 * The per-turn ephemeral tail (workspace change-delta + turn-context) is never
 * persisted or replayed, so it is present in run N and absent from run N+1.
 * Any breakpoint at or after it therefore caches a sequence that cannot recur.
 * These tests pin that the durable breakpoint lands before it, and — with a
 * deliberate negative assertion — that the tail breakpoint alone would not.
 */

import {
  applyMessageCacheBreakpoints,
  applySystemCacheTtl,
  prepareAnthropicApiMessages,
  type AnthropicApiMessage,
} from '@server/services/ProviderChatService/providers/anthropicMessagePrep';
import { TURN_CONTEXT_HEADER } from '@server/services/SystemPromptComposer/composeTurnContextTail';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';

// A second ephemeral block that precedes the turn-context header in the
// per-turn tail. Flagged `ephemeral` so breakpoint placement locates it
// structurally, the same way the runtime marks per-turn tail messages.
const EPHEMERAL_TAIL: ProviderMessage = {
  role: 'user',
  content: '📄 ephemeral tail note',
  ephemeral: true,
};

/** Indices carrying a cache_control marker. */
function breakpointIndices(messages: AnthropicApiMessage[]): number[] {
  const found: number[] = [];
  messages.forEach((msg, i) => {
    if (!Array.isArray(msg.content)) return;
    const marked = (msg.content as Array<Record<string, unknown>>).some((b) => b.cache_control);
    if (marked) found.push(i);
  });
  return found;
}

/**
 * Content of messages[0..index], with cache_control stripped. Anthropic matches
 * on the content bytes, so markers must not participate in the comparison.
 */
function prefixBytes(messages: AnthropicApiMessage[], index: number): string {
  return JSON.stringify(
    messages.slice(0, index + 1).map((msg) => ({
      role: msg.role,
      content: Array.isArray(msg.content)
        ? (msg.content as Array<Record<string, unknown>>).map(
            ({ cache_control: _drop, ...rest }) => rest
          )
        : msg.content,
    }))
  );
}

function build(messages: ProviderMessage[]): AnthropicApiMessage[] {
  const { apiMessages } = prepareAnthropicApiMessages(messages);
  return applyMessageCacheBreakpoints(apiMessages, '1h');
}

// Run N: two persisted turns, then the ephemeral turn-context tail.
const RUN_N: ProviderMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
  { role: 'user', content: TURN_CONTEXT_HEADER },
];

// Run N+1: run N's exchange is now replayed history, the human has sent another
// message, and a fresh ephemeral pair is appended. Run N's turn-context block is
// simply gone — it was never persisted.
const RUN_N_PLUS_1: ProviderMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
  { role: 'user', content: 'next question' },
  EPHEMERAL_TAIL,
  { role: 'user', content: TURN_CONTEXT_HEADER },
];

describe('applyMessageCacheBreakpoints — placement', () => {
  test('durable breakpoint lands on the message before the ephemeral tail', () => {
    const out = build(RUN_N);
    // [user hello][assistant hi there][user turn-context]
    expect(out).toHaveLength(3);
    expect(breakpointIndices(out)).toEqual([1, 2]);
  });

  test('an extra ephemeral block also counts as the start of the ephemeral tail', () => {
    const out = build([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      EPHEMERAL_TAIL,
      { role: 'user', content: TURN_CONTEXT_HEADER },
    ]);
    // The two ephemeral user strings merge into one message; durable stays at 1.
    expect(breakpointIndices(out)).toEqual([1, out.length - 1]);
  });

  test('never places more than two message breakpoints', () => {
    expect(breakpointIndices(build(RUN_N)).length).toBeLessThanOrEqual(2);
    expect(breakpointIndices(build(RUN_N_PLUS_1)).length).toBeLessThanOrEqual(2);
  });

  test('with no ephemeral tail, only the tail breakpoint is placed', () => {
    const out = build([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'bye' },
    ]);
    expect(breakpointIndices(out)).toEqual([out.length - 1]);
  });

  test('an ephemeral tail at index 0 places only the tail breakpoint', () => {
    const out = build([
      { role: 'user', content: TURN_CONTEXT_HEADER },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'go' },
    ]);
    expect(breakpointIndices(out)).toEqual([out.length - 1]);
  });
});

describe('applyMessageCacheBreakpoints — prefix survives into the next run', () => {
  test('the durable prefix of run N is byte-identical in run N+1', () => {
    const runN = build(RUN_N);
    const runN1 = build(RUN_N_PLUS_1);

    const durable = breakpointIndices(runN)[0]!;
    expect(prefixBytes(runN, durable)).toBe(prefixBytes(runN1, durable));
  });

  test('the tail prefix of run N does not survive — why the durable one exists', () => {
    const runN = build(RUN_N);
    const runN1 = build(RUN_N_PLUS_1);

    // The tail breakpoint is the last message: the ephemeral turn-context.
    const tail = runN.length - 1;
    // Caching only there would cap cache reads at the system+tools size: run
    // N+1 has run N's replayed content at that position instead.
    expect(prefixBytes(runN, tail)).not.toBe(prefixBytes(runN1, tail));
  });

  test('the newest human message merges with the ephemeral pair and stays outside the prefix', () => {
    const runN1 = build(RUN_N_PLUS_1);
    const durable = breakpointIndices(runN1)[0]!;
    const carrier = runN1[durable + 1]!;
    const text = JSON.stringify(carrier.content);

    // prepareAnthropicApiMessages merged 'next question' + both ephemeral
    // blocks into one user message, so the sentinel is not at offset 0 —
    // which is exactly why placement matches on `includes`.
    expect(text).toContain('next question');
    expect(text).toContain('ephemeral tail note');
    expect(prefixBytes(runN1, durable)).not.toContain('next question');
  });
});

describe('applyMessageCacheBreakpoints — purity', () => {
  test('does not mutate the input and strips inherited cache_control', () => {
    const input: AnthropicApiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'stale', cache_control: { type: 'ephemeral', ttl: '5m' } },
        ] as unknown as AnthropicApiMessage['content'],
      },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: TURN_CONTEXT_HEADER },
    ];
    const snapshot = JSON.stringify(input);

    const out = applyMessageCacheBreakpoints(input, '1h');

    expect(JSON.stringify(input)).toBe(snapshot);
    // The inherited 5m marker is gone; only the two placed 1h markers remain.
    const blocks = out[0]!.content as Array<Record<string, unknown>>;
    expect(blocks[0]!.cache_control).toBeUndefined();
    expect(breakpointIndices(out)).toEqual([1, 2]);
  });

  test('honors the requested TTL', () => {
    const out = applyMessageCacheBreakpoints(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: TURN_CONTEXT_HEADER },
      ],
      '5m'
    );
    const blocks = out[1]!.content as Array<Record<string, unknown>>;
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });
});

describe('applyMessageCacheBreakpoints — structural ephemeral flag', () => {
  test('the flag locates the ephemeral tail even when content has no sentinel', () => {
    // This is the whole point of the flag: a tail whose text does not contain
    // any sentinel phrase is still correctly kept out of the durable prefix.
    const out = build([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'a perfectly ordinary tail with no marker at all', ephemeral: true },
    ]);
    // Durable lands on index 1 (before the flagged tail), tail on the last.
    expect(breakpointIndices(out)).toEqual([1, out.length - 1]);
  });

  test('an ordinary message that merely contains a sentinel phrase in history does not move the breakpoint when a real flagged tail exists', () => {
    // A persisted message that happens to quote a sentinel must not be mistaken
    // for the tail. The flagged tail is the real one; findIndex prefers the flag.
    const out = build([
      {
        role: 'user',
        content: `quoting: an old ephemeral note (this is old persisted history)`,
      },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: 'the actual fresh tail', ephemeral: true },
    ]);
    // Without the flag, findIndex would have matched index 0 (the quote) and
    // slid the durable breakpoint to -1 (index 0 has no prior). With the flag,
    // the tail is correctly index 2, durable at 1.
    expect(breakpointIndices(out)).toEqual([1, out.length - 1]);
  });

  test('flag survives the same-role merge (tail glued onto newest human message)', () => {
    const out = build([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'newest human message' },
      { role: 'user', content: 'flagged tail', ephemeral: true },
    ]);
    // The two trailing user strings merge; the merged block is ephemeral, so the
    // durable breakpoint lands before it (index 1) — never inside the tail.
    expect(breakpointIndices(out)).toEqual([1, out.length - 1]);
  });
});

describe('wire shape', () => {
  it('never sends the internal `ephemeral` flag to the API', () => {
    // The Messages API rejects unknown top-level message keys outright —
    // "messages.0.ephemeral: Extra inputs are not permitted" (400) — so a flag
    // that survives to the wire fails every request, not an edge case.
    const out = applyMessageCacheBreakpoints(
      [
        { role: 'user', content: 'durable history' },
        { role: 'assistant', content: 'reply' },
        {
          role: 'user',
          content: '[Turn context — not part of the conversation record]',
          ephemeral: true,
        },
      ] as never,
      '1h'
    );
    for (const msg of out) {
      expect(Object.prototype.hasOwnProperty.call(msg, 'ephemeral')).toBe(false);
    }
  });
});

describe('applySystemCacheTtl', () => {
  const blocks = [
    { type: 'text', text: 'core', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'thread prompt' },
  ];

  it('gives marked system blocks the run TTL and leaves unmarked blocks alone', () => {
    expect(applySystemCacheTtl(blocks, '5m')).toEqual([
      { type: 'text', text: 'core', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { type: 'text', text: 'thread prompt' },
    ]);
  });

  it('does not change the blocks it was given', () => {
    applySystemCacheTtl(blocks, '5m');
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('passes a plain-string system prompt through', () => {
    expect(applySystemCacheTtl('system prompt', '5m')).toBe('system prompt');
  });
});
