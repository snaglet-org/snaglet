import { describe, expect, it } from '@jest/globals';
import {
  reconstructTurn,
  type ReconstructTurnInput,
} from '@server/services/SocketService/handlers/chatPhases/reconstructTurn';

const actorTurn: ReconstructTurnInput = {
  isActor: true,
  reasoning: 'I should read the file first.',
  toolCalls: [
    { id: 'act-1', name: 'file_read', input: { path: '/tmp.txt' }, output: '13kb of notes' },
    { id: 'act-2', name: 'code_search', input: { q: 'cache' }, output: '3 hits' },
  ],
  finalText: "It's a design doc.",
};

// Narrowing helpers — message content is string | block[].
function blocksOf(messages: ReturnType<typeof reconstructTurn>): Array<Record<string, unknown>> {
  return messages.flatMap((m) =>
    Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []
  );
}

describe('reconstructTurn — deterministic, cache-safe turn replay', () => {
  it('is byte-identical across rebuilds (the cache-safety guarantee)', () => {
    // Same input must produce the same prefix every time, or the cache breaks.
    expect(reconstructTurn(actorTurn)).toEqual(reconstructTurn(actorTurn));
    expect(JSON.stringify(reconstructTurn(actorTurn))).toBe(
      JSON.stringify(reconstructTurn(actorTurn))
    );
  });

  it('replays an actor turn as assistant(tool_use)/user(tool_result) cycles + final text', () => {
    expect(reconstructTurn(actorTurn)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I should read the file first.' },
          { type: 'tool_use', id: 'act-1', name: 'file_read', input: { path: '/tmp.txt' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'act-1', content: '13kb of notes' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'act-2', name: 'code_search', input: { q: 'cache' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'act-2', content: '3 hits' }] },
      { role: 'assistant', content: "It's a design doc." },
    ]);
  });

  it('pairs every tool_use with a tool_result by id (API requirement)', () => {
    const out = reconstructTurn(actorTurn);
    const useIds = blocksOf(out)
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id);
    const resultIds = blocksOf(out)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id);
    expect(resultIds).toEqual(useIds);
  });

  it('replays reasoning as a text block, never a thinking block', () => {
    const blocks = blocksOf(reconstructTurn(actorTurn));
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && String(b.text).includes('read the file'))).toBe(
      true
    );
  });

  it('observer projection: peer turns show final text only, no tool detail', () => {
    const out = reconstructTurn({ ...actorTurn, isActor: false });
    expect(out).toEqual([{ role: 'assistant', content: "It's a design doc." }]);
    const hasToolBlocks = blocksOf(out).some(
      (b) => b.type === 'tool_use' || b.type === 'tool_result'
    );
    expect(hasToolBlocks).toBe(false);
  });

  it('flags tool errors with is_error', () => {
    const out = reconstructTurn({
      isActor: true,
      toolCalls: [{ id: 'e1', name: 'x', input: {}, output: 'boom', isError: true }],
      finalText: 'done',
    });
    expect((out[1] as { content: unknown[] }).content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'e1',
      content: 'boom',
      is_error: true,
    });
  });

  it('no-tool actor turn collapses to a single assistant text message', () => {
    expect(reconstructTurn({ isActor: true, reasoning: 'thinking…', finalText: 'hi' })).toEqual([
      { role: 'assistant', content: 'thinking…\n\nhi' },
    ]);
  });

  it('empty turn yields nothing', () => {
    expect(reconstructTurn({ isActor: true })).toEqual([]);
    expect(reconstructTurn({ isActor: false })).toEqual([]);
  });

  it('tools-only turn (message-less run) replays cycles ending in a tool_result, deterministically', () => {
    // A run that aborted before writing any final text: reconstructTurn still
    // renders the tool cycles (the abort marker is appended one level up, in
    // renderActorRun). This is the shape the abort-gap fix relies on.
    const toolsOnly: ReconstructTurnInput = {
      isActor: true,
      toolCalls: [
        { id: 'x1', name: 'workspace_search', input: { q: 'a' }, output: 'hit' },
        { id: 'x2', name: 'get_doc', input: { id: 'd' }, output: 'body' },
      ],
      finalText: null,
    };
    const out = reconstructTurn(toolsOnly);
    // 2 cycles → 4 messages, last is a user(tool_result), no closing assistant text.
    expect(out).toHaveLength(4);
    expect(out[out.length - 1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x2', content: 'body' }],
    });
    expect(out.some((m) => m.role === 'assistant' && typeof m.content === 'string')).toBe(false);
    // Byte-identical across rebuilds (cache-safety guarantee for message-less runs).
    expect(JSON.stringify(reconstructTurn(toolsOnly))).toBe(
      JSON.stringify(reconstructTurn(toolsOnly))
    );
  });
});
