import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { AgentActivityLogRow } from '@snaglet/db/tables/agent_activity_log';

jest.mock('@snaglet/db/db', () => ({ getDb: jest.fn(), transaction: jest.fn() }));
jest.mock('@snaglet/db/tables/messages', () => ({ Messages: { listByThreadId: async () => [] } }));
jest.mock('@snaglet/db/tables/runs', () => ({ Runs: { listByThreadId: async () => [] } }));

import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Messages } from '@snaglet/db/tables/messages';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import {
  assembleWithScaledCap,
  buildReplayPayload,
  loadReplaySource,
} from '@server/services/SocketService/handlers/chatPhases/replayLoader';
import {
  assembleAgentPayload,
  type ReplayActivityRow,
  type ReplayUnitSpan,
} from '@server/services/SocketService/handlers/chatPhases/replayAssembly';

function rows(count: number): AgentActivityLogRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `activity-${String(i).padStart(5, '0')}`,
    agentId: 'test-agent-a',
    runId: i === count - 1 ? 'latest-run' : 'old-run',
    actionType: 'tool_call',
    triggerType: 'manual',
    reason: null,
    content: null,
    tokenEstimate: 0,
    tool: 'file',
    toolInput: {},
    toolOutput: { content: `result-${i}` },
    durationMs: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  }));
}

// Simulate SQL selection, not a database: assert the query direction and model's
// reversal separately, then exercise real normalization and replay assembly.
function mockQuery(data: AgentActivityLogRow[]) {
  return jest.spyOn(AgentActivityLog, 'query').mockImplementation(async (sql, params) => {
    expect(params?.[0]).toBe('thread-1111111111111-aaaaaaaaa');
    const selected = sql.includes('created_at DESC') ? [...data].reverse() : [...data];
    return selected.slice(0, Number(params?.[1])) as never;
  });
}

describe('replay loader activity window', () => {
  it('keeps newest 5,000 rows chronologically and replays the latest tool result', async () => {
    const data = rows(5001);
    const query = mockQuery(data);
    try {
      const source = await loadReplaySource('thread-1111111111111-aaaaaaaaa');
      const retained = [...source.activityByRun.values()].flat();
      expect(retained.map((r) => r.id)).toEqual(data.slice(1).map((r) => r.id));
      const payload = assembleAgentPayload({
        perceivingAgentId: 'test-agent-a',
        messages: [],
        runs: [
          {
            id: 'latest-run',
            agentId: 'test-agent-a',
            startedAt: data[5000]!.createdAt,
            finishedAt: null,
            status: 'failed',
          },
        ],
        activityByRun: source.activityByRun,
      });
      expect(JSON.stringify(payload)).toContain('result-5000');
      expect(JSON.stringify(payload)).not.toContain('result-0"');
    } finally {
      query.mockRestore();
    }
  });

  it.each([0, 1, 8, 5000])('preserves all rows and order under the cap (%i)', async (count) => {
    const data = rows(count);
    const query = mockQuery(data);
    try {
      expect(await AgentActivityLog.getByThreadId('thread-1111111111111-aaaaaaaaa')).toEqual(data);
    } finally {
      query.mockRestore();
    }
  });
});

describe('replay loader skips the stored thread-summary activity row', () => {
  const summaryRow = (id: string, runId: string): AgentActivityLogRow => ({
    ...rows(1)[0]!,
    id,
    runId,
    tool: 'thread_summary',
    toolOutput: { summary: 'SUMMARY-BODY', messages_covered: 12, model_used: 'test/model' },
    createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
  });

  it('never replays it as a tool call, and a run with only that row has no activity', async () => {
    const real = {
      ...rows(1)[0]!,
      id: 'activity-real',
      runId: 'run-1',
      toolOutput: { content: 'REAL' },
    };
    const data = [
      real,
      summaryRow('activity-summary-1', 'run-1'),
      summaryRow('activity-summary-2', 'run-2'),
    ];
    const query = mockQuery(data);
    try {
      const source = await loadReplaySource('thread-1111111111111-aaaaaaaaa');
      const kept = [...source.activityByRun.values()].flat().map((r) => r.id);
      expect(kept).toEqual(['activity-real']);
      expect(source.activityByRun.has('run-2')).toBe(false);
      const payload = assembleAgentPayload({
        perceivingAgentId: 'test-agent-a',
        messages: [],
        runs: [
          {
            id: 'run-1',
            agentId: 'test-agent-a',
            startedAt: real.createdAt,
            finishedAt: null,
            status: 'failed',
          },
          {
            id: 'run-2',
            agentId: 'test-agent-a',
            startedAt: real.createdAt,
            finishedAt: null,
            status: 'failed',
          },
        ],
        activityByRun: source.activityByRun,
      });
      const text = JSON.stringify(payload);
      expect(text).toContain('REAL');
      expect(text).not.toContain('thread_summary');
      expect(text).not.toContain('SUMMARY-BODY');
    } finally {
      query.mockRestore();
    }
  });
});

describe('buildReplayPayload applies the newest compaction for the agent', () => {
  const row = (n: number) =>
    ({
      id: `message-${n}`,
      threadId: THREAD,
      agentId: null,
      role: 'user',
      content: `user line ${n}`,
      runId: null,
      userId: 'user-1',
      messageType: 'text',
      createdAt: `2026-06-27T10:00:0${n}.000Z`,
      injectedDuringRun: false,
      externalSenderLabel: null,
      visibleToAgentId: null,
    }) as never;
  const THREAD = 'thread-1111111111111-aaaaaaaaa';

  const restore: Array<() => void> = [];
  afterEach(() => restore.splice(0).forEach((fn) => fn()));
  const spy = <T extends object, K extends keyof T>(obj: T, key: K, impl: unknown) => {
    const s = jest.spyOn(obj as never, key as never).mockImplementation(impl as never);
    restore.push(() => s.mockRestore());
  };

  it('replays everything when there is no compaction, and reports the unit spans', async () => {
    spy(Messages, 'listByThreadId', async () => [row(1), row(2), row(3)]);
    spy(AgentActivityLog, 'query', async () => []);
    spy(ThreadSummaries, 'getLatestCompaction', async () => null);
    spy(AgentActivityLog, 'getLatestByTool', async () => null);
    const payload = await buildReplayPayload(THREAD, 'test-agent-a');
    expect(payload.messages).toHaveLength(3);
    expect(payload.units.map((u) => u.end)).toEqual([1, 2, 3]);
  });

  it('starts with a fold saved as a thread summary and leaves out exactly the folded units', async () => {
    spy(Messages, 'listByThreadId', async () => [row(1), row(2), row(3)]);
    spy(AgentActivityLog, 'query', async () => []);
    const legacy = jest.fn(async () => null);
    spy(AgentActivityLog, 'getLatestByTool', legacy);
    spy(ThreadSummaries, 'getLatestCompaction', async (_t: string, agentId: string) => {
      expect(agentId).toBe('test-agent-a');
      return {
        summaryText: 'Line one was folded.',
        compaction: {
          through: {
            effectiveStart: '2026-06-27T10:00:01.000Z',
            startAt: '2026-06-27T10:00:01.000Z',
            sortId: 'message-1',
          },
          folded_units: 1,
          carry_forward: null,
        },
      };
    });
    const payload = await buildReplayPayload(THREAD, 'test-agent-a');
    const text = JSON.stringify(payload.messages);
    expect(text).toContain('Line one was folded.');
    expect(text).not.toContain('user line 1');
    expect(text).toContain('user line 2');
    expect(payload.units.map((u) => u.key.sortId)).toEqual(['message-2', 'message-3']);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('still applies a fold saved in the activity log before summaries held them', async () => {
    spy(Messages, 'listByThreadId', async () => [row(1), row(2), row(3)]);
    spy(AgentActivityLog, 'query', async () => []);
    spy(ThreadSummaries, 'getLatestCompaction', async () => null);
    spy(AgentActivityLog, 'getLatestByTool', async (_t: string, agentId: string) => {
      expect(agentId).toBe('test-agent-a');
      return {
        toolOutput: {
          through: {
            effectiveStart: '2026-06-27T10:00:01.000Z',
            startAt: '2026-06-27T10:00:01.000Z',
            sortId: 'message-1',
          },
          summary: 'Line one was folded.',
          folded_units: 1,
        },
      };
    });
    const payload = await buildReplayPayload(THREAD, 'test-agent-a');
    const text = JSON.stringify(payload.messages);
    expect(text).toContain('Line one was folded.');
    expect(text).not.toContain('user line 1');
    expect(text).toContain('user line 2');
    expect(text).toContain('user line 3');
    expect(payload.units.map((u) => u.key.sortId)).toEqual(['message-2', 'message-3']);
  });

  it('ignores a malformed record rather than failing the turn', async () => {
    spy(Messages, 'listByThreadId', async () => [row(1)]);
    spy(AgentActivityLog, 'query', async () => []);
    spy(ThreadSummaries, 'getLatestCompaction', async () => null);
    spy(AgentActivityLog, 'getLatestByTool', async () => ({ toolOutput: { summary: '' } }));
    const payload = await buildReplayPayload(THREAD, 'test-agent-a');
    expect(JSON.stringify(payload.messages)).toContain('user line 1');
  });

  it('replays in full when the compaction lookup fails', async () => {
    spy(Messages, 'listByThreadId', async () => [row(1)]);
    spy(AgentActivityLog, 'query', async () => []);
    spy(AgentActivityLog, 'getLatestByTool', async () => {
      throw new Error('db down');
    });
    const payload = await buildReplayPayload(THREAD, 'test-agent-a');
    expect(JSON.stringify(payload.messages)).toContain('user line 1');
  });
});

describe('replay run cap scales with the window', () => {
  // One earlier run whose single tool result is ~20k tokens (60k chars), then a newer run.
  const big = 'x'.repeat(60_000);
  const activity = (runId: string, output: string): ReplayActivityRow => ({
    id: `activity-${runId}`,
    runId,
    actionType: 'tool_call',
    tool: 'file',
    toolInput: { path: 'a.txt' },
    toolOutput: { content: output },
    createdAt: runId === 'old-run' ? '2026-01-01T00:00:00.000Z' : '2026-01-01T01:00:00.000Z',
  });
  const run = (id: string, startedAt: string) => ({
    id,
    agentId: 'test-agent-a',
    startedAt,
    finishedAt: startedAt,
    status: 'completed' as const,
  });
  const source = () => ({
    perceivingAgentId: 'test-agent-a',
    messages: [],
    runs: [run('old-run', '2026-01-01T00:00:00.000Z'), run('new-run', '2026-01-01T01:00:00.000Z')],
    activityByRun: new Map([
      ['old-run', [activity('old-run', big)]],
      ['new-run', [activity('new-run', 'ok')]],
    ]),
  });
  const text = (messages: unknown) => JSON.stringify(messages);

  it('replays an earlier run whole on a large, mostly empty window', () => {
    const out = assembleWithScaledCap({
      ...source(),
      budget: { tokenThreshold: 112_000, systemPromptTokens: 4_000 },
    });
    expect(text(out)).not.toContain('replay trimmed');
    expect(text(out)).toContain(big);
  });

  it('still trims it on a small window', () => {
    const out = assembleWithScaledCap({
      ...source(),
      budget: { tokenThreshold: 12_000, systemPromptTokens: 2_000 },
    });
    expect(text(out)).toContain('replay trimmed');
  });

  it('tightens the cap as other runs crowd the window', () => {
    const crowded = source();
    // Five more runs of ~25k tokens each: under the empty-window ceiling (28k) one by one,
    // but together past the room below the fold, so each is trimmed a little.
    const huge = 'y'.repeat(100_000);
    for (let i = 0; i < 5; i++) {
      const id = `old-${i}`;
      crowded.runs.unshift(run(id, `2025-12-0${i + 1}T00:00:00.000Z`));
      crowded.activityByRun.set(id, [activity(id, huge)]);
    }
    const out = assembleWithScaledCap({
      ...crowded,
      budget: { tokenThreshold: 112_000, systemPromptTokens: 4_000 },
    });
    expect(text(out)).toContain('replay trimmed');
  });

  it('keeps the fixed cap when no budget is known, and honors an explicit cap', () => {
    expect(text(assembleWithScaledCap({ ...source() }))).toContain('replay trimmed');
    const fixed = assembleWithScaledCap({
      ...source(),
      fixedCap: 100_000,
      budget: { tokenThreshold: 12_000, systemPromptTokens: 2_000 },
    });
    expect(text(fixed)).not.toContain('replay trimmed');
  });

  it('writes unitsOut from the kept assembly only, with no duplicates from the first attempt', () => {
    // Same shape as 'tightens the cap' — many runs crowd the window below the fold, forcing a
    // second, shrunk assembly. If unitsOut were threaded straight through, the first attempt's
    // units would still be in the array and the second call would append on top.
    const crowded = source();
    const huge = 'y'.repeat(100_000);
    for (let i = 0; i < 5; i++) {
      const id = `old-${i}`;
      crowded.runs.unshift(run(id, `2025-12-0${i + 1}T00:00:00.000Z`));
      crowded.activityByRun.set(id, [activity(id, huge)]);
    }
    const unitsOut: ReplayUnitSpan[] = [];
    const messages = assembleWithScaledCap({
      ...crowded,
      budget: { tokenThreshold: 112_000, systemPromptTokens: 4_000 },
      unitsOut,
    });
    // No duplicate sortIds: every run contributes exactly one unit.
    const sortIds = unitsOut.map((u) => u.key.sortId);
    expect(new Set(sortIds).size).toBe(sortIds.length);
    // One unit per run (7 total: 5 'old-N' + 'old-run' + 'new-run').
    expect(sortIds.sort()).toEqual(
      ['new-run', 'old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-run'].sort()
    );
    // Each unit's end index lies within the returned messages, and ends are non-decreasing
    // (the kept assembly, not an interleaving of two attempts).
    for (let i = 0; i < unitsOut.length; i++) {
      expect(unitsOut[i]!.end).toBeGreaterThan(0);
      expect(unitsOut[i]!.end).toBeLessThanOrEqual(messages.length);
      if (i > 0) expect(unitsOut[i]!.end).toBeGreaterThanOrEqual(unitsOut[i - 1]!.end);
    }
    // The last unit's end equals the returned message count: units correspond to the kept assembly.
    expect(unitsOut[unitsOut.length - 1]!.end).toBe(messages.length);
  });
});
