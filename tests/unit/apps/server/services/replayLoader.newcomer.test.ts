/**
 * buildReplayPayload for an agent new to the thread: with no fold and no run of its own it gets
 * the newest units that fit 30% of its model window behind a cut note, the cut is handed to the
 * caller to persist as that agent's own compaction, and an agent that has spoken replays in full.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listMessages = jest.fn<() => Promise<unknown[]>>();
const listRuns = jest.fn<() => Promise<unknown[]>>();

jest.mock('@snaglet/db/db', () => ({ getDb: jest.fn(), transaction: jest.fn() }));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { listByThreadId: () => listMessages() },
}));
jest.mock('@snaglet/db/tables/runs', () => ({ Runs: { listByThreadId: () => listRuns() } }));
jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { getByThreadId: async () => [], getLatestByTool: async () => null },
}));
jest.mock('@snaglet/db/tables/thread_summaries', () => ({
  ThreadSummaries: { getLatestCompaction: async () => null },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: async () => [] },
}));
jest.mock('@snaglet/db/tables/users', () => ({
  Users: { findById: async () => ({ name: 'Test User' }) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: async () => ({ name: 'Ada' }) },
}));

import { buildReplayPayload } from '@server/services/SocketService/handlers/chatPhases/replayLoader';
import type { CompactionRecord } from '@server/services/summary/compactionRecord';

const row = (n: number) => ({
  id: `m${n}`,
  threadId: 't',
  agentId: null,
  userId: 'u1',
  role: 'user',
  content: 'x'.repeat(4000),
  runId: null,
  createdAt: `2026-10-20T10:00:0${n}.000Z`,
  injectedDuringRun: false,
  externalSenderLabel: null,
  messageType: 'message',
  visibleToAgentId: null,
});

/** An 8,000-token window: 30% is 2,400 tokens, room for the two newest ~1,004-token units. */
const budget = { contextWindowTokens: 8_000, tokenThreshold: 4_000, systemPromptTokens: 500 };

beforeEach(() => {
  listMessages.mockReset();
  listRuns.mockReset();
  listMessages.mockResolvedValue([1, 2, 3, 4, 5, 6].map(row));
  listRuns.mockResolvedValue([]);
});

describe('buildReplayPayload for a newcomer', () => {
  it('replays only the newest units that fit 30% of the window, behind a cut note', async () => {
    const full = await buildReplayPayload('t', 'ada');
    const saved: CompactionRecord[] = [];
    const { messages, compaction } = await buildReplayPayload('t', 'ada', budget, async (r) => {
      saved.push(r);
    });

    expect(full.messages).toHaveLength(6);
    expect(messages).toHaveLength(3);
    expect(String(messages[0]!.content)).toContain('[Earlier history not shown');
    expect(String(messages[0]!.content)).toContain('4 earlier turns');
    expect(JSON.stringify(messages.slice(1))).not.toContain('m4');
    expect(compaction).toMatchObject({ cut: true, foldedUnits: 4, through: full.units[3]!.key });
    expect(saved).toEqual([compaction]);
  });

  it('computes the same cut without persisting when no saver is given', async () => {
    const { messages, compaction } = await buildReplayPayload('t', 'ada', budget);
    expect(messages).toHaveLength(3);
    expect(compaction).toMatchObject({ cut: true, foldedUnits: 4 });
  });

  it('leaves an agent that has spoken in the thread whole', async () => {
    listRuns.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 't',
        agentId: 'ada',
        startedAt: '2026-10-20T10:00:02.500Z',
        finishedAt: '2026-10-20T10:00:02.900Z',
        status: 'completed',
      },
    ]);
    const saver = jest.fn(async () => undefined);
    const { messages, compaction } = await buildReplayPayload('t', 'ada', budget, saver);
    expect(messages.length).toBeGreaterThanOrEqual(6);
    expect(compaction).toBeNull();
    expect(saver).not.toHaveBeenCalled();
  });

  it('keeps the whole history when it fits the cap', async () => {
    const saver = jest.fn(async () => undefined);
    const { messages, compaction } = await buildReplayPayload(
      't',
      'ada',
      { ...budget, contextWindowTokens: 100_000 },
      saver
    );
    expect(messages).toHaveLength(6);
    expect(compaction).toBeNull();
    expect(saver).not.toHaveBeenCalled();
  });

  it('replays in full when the window is unknown', async () => {
    const { messages, compaction } = await buildReplayPayload('t', 'ada');
    expect(messages).toHaveLength(6);
    expect(compaction).toBeNull();
  });
});
