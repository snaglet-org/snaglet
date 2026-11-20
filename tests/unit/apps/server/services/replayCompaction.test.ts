import { describe, expect, it } from '@jest/globals';
import {
  assembleAgentPayload,
  type ReplayMessageRow,
  type ReplayUnitSpan,
} from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import { COMPACTION_SUMMARY_HEADER } from '@server/services/contextWindow/compactionMessage';

const user = (n: number): ReplayMessageRow => ({
  id: `message-${n}`,
  agentId: null,
  role: 'user',
  content: `user line ${n}`,
  userId: 'user-1',
  runId: null,
  createdAt: `2026-06-27T10:00:0${n}.000Z`,
});
const base = (messages: ReplayMessageRow[]) => ({
  perceivingAgentId: 'test-agent-a',
  runs: [],
  messages,
  activityByRun: new Map(),
});
const text = (m: { content: unknown }) => (typeof m.content === 'string' ? m.content : '');

describe('replay with a persisted compaction', () => {
  const messages = [1, 2, 3, 4].map(user);

  it('without one, nothing changes and the unit spans are reported', () => {
    const spans: ReplayUnitSpan[] = [];
    const out = assembleAgentPayload({ ...base(messages), unitsOut: spans });
    expect(out.map(text)).toEqual(['user line 1', 'user line 2', 'user line 3', 'user line 4']);
    expect(spans.map((s) => s.end)).toEqual([1, 2, 3, 4]);
    expect(spans.map((s) => s.key.sortId)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
  });

  it('drops exactly the units up to the cut and puts the summary first: no gap, no overlap', () => {
    const spans: ReplayUnitSpan[] = [];
    assembleAgentPayload({ ...base(messages), unitsOut: spans });
    const through = spans[1]!.key; // fold messages 1 and 2

    const out = assembleAgentPayload({
      ...base(messages),
      compaction: { through, summary: 'Messages one and two were about the retry budget.' },
    });
    expect(text(out[0]!)).toContain(COMPACTION_SUMMARY_HEADER);
    expect(text(out[0]!)).toContain('Messages one and two were about the retry budget.');
    expect(out.slice(1).map(text)).toEqual(['user line 3', 'user line 4']);
    expect(out.map(text).join('\n')).not.toContain('user line 1');
    expect(out.map(text).join('\n')).not.toContain('user line 2');
  });

  it('restates the roster carry-forward after the header when the record has one', () => {
    const spans: ReplayUnitSpan[] = [];
    assembleAgentPayload({ ...base(messages), unitsOut: spans });
    const out = assembleAgentPayload({
      ...base(messages),
      compaction: { through: spans[0]!.key, summary: 'S.', carryForward: 'Roster: A, B.' },
    });
    expect(text(out[0]!)).toContain('Roster: A, B.');
    expect(text(out[0]!).indexOf('Roster: A, B.')).toBeLessThan(text(out[0]!).indexOf('S.'));
  });

  it('a cut at the last unit leaves only the summary', () => {
    const spans: ReplayUnitSpan[] = [];
    assembleAgentPayload({ ...base(messages), unitsOut: spans });
    const out = assembleAgentPayload({
      ...base(messages),
      compaction: { through: spans[3]!.key, summary: 'Everything.' },
    });
    expect(out).toHaveLength(1);
  });

  it('a message that arrives after the cut stays, and spans account for the summary message', () => {
    const spans: ReplayUnitSpan[] = [];
    assembleAgentPayload({ ...base(messages), unitsOut: spans });
    const through = spans[1]!.key;
    const withNew = [...messages, user(5)];
    const after: ReplayUnitSpan[] = [];
    const out = assembleAgentPayload({
      ...base(withNew),
      compaction: { through, summary: 'S.' },
      unitsOut: after,
    });
    expect(out.map(text).slice(1)).toEqual(['user line 3', 'user line 4', 'user line 5']);
    // Spans are indexes into the returned messages, summary message included.
    expect(after.map((s) => s.end)).toEqual([2, 3, 4]);
    expect(after.map((s) => s.key.sortId)).toEqual(['message-3', 'message-4', 'message-5']);
  });
});
