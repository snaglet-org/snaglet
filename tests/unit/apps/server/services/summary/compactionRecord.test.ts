import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Links } from '@snaglet/db/tables/links';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import {
  COMPACTION_SUMMARY_ACTIVITY_TOOL,
  isSummaryBookkeepingActivity,
  loadLatestCompaction,
  parseCompactionRecord,
  parseFoldRow,
  saveCompaction,
  serializeCompactionRecord,
  serializeFoldColumn,
} from '@server/services/summary/compactionRecord';

const record = {
  through: {
    effectiveStart: '2026-06-27T10:00:02.000Z',
    startAt: '2026-06-27T10:00:02.000Z',
    sortId: 'message-2',
  },
  summary: 'The retry budget stays at three.',
  foldedUnits: 2,
};

describe('compaction record', () => {
  it('round-trips through the activity row output', () => {
    const output = serializeCompactionRecord(record, 'anthropic/test-model');
    expect(parseCompactionRecord(output)).toEqual({ ...record, carryForward: null });
    expect(output).toMatchObject({ model_used: 'anthropic/test-model' });
  });

  it('keeps the roster carry-forward taken at the fold', () => {
    const withCarry = { ...record, carryForward: 'Roster: A, B. Mode: all.' };
    expect(
      parseCompactionRecord(serializeCompactionRecord(withCarry, 'anthropic/test-model'))
    ).toEqual(withCarry);
  });

  it.each([
    null,
    undefined,
    'text',
    {},
    { summary: 'x' },
    { through: { sortId: 'a' }, summary: 'x' },
    { through: record.through, summary: '' },
    { through: record.through, summary: 42 },
  ])('rejects a malformed output %j', (output) => {
    expect(parseCompactionRecord(output)).toBeNull();
  });

  it('names its activity tool and marks both summary tools as bookkeeping, not tool calls', () => {
    expect(COMPACTION_SUMMARY_ACTIVITY_TOOL).toBe('compaction_summary');
    expect(isSummaryBookkeepingActivity({ tool: 'compaction_summary' })).toBe(true);
    expect(isSummaryBookkeepingActivity({ tool: 'thread_summary' })).toBe(true);
    expect(isSummaryBookkeepingActivity({ tool: 'file' })).toBe(false);
    expect(isSummaryBookkeepingActivity({ tool: null })).toBe(false);
  });
});

describe('a fold saved as a thread summary', () => {
  const restore: Array<() => void> = [];
  afterEach(() => restore.splice(0).forEach((fn) => fn()));
  const spy = <T extends object, K extends keyof T>(obj: T, key: K, impl: unknown) => {
    const s = jest.spyOn(obj as never, key as never).mockImplementation(impl as never);
    restore.push(() => s.mockRestore());
    return s;
  };
  const withCarry = { ...record, carryForward: 'Roster: A, B.' };

  it('keeps everything but the text in the column, and reads the record back from a row', () => {
    const column = serializeFoldColumn(withCarry);
    expect(column).toEqual({
      through: record.through,
      carry_forward: 'Roster: A, B.',
      folded_units: 2,
    });
    expect(column).not.toHaveProperty('summary');
    expect(parseFoldRow({ summaryText: record.summary, compaction: column })).toEqual(withCarry);
  });

  it.each([null, {}, { through: { sortId: 'a' }, folded_units: 1 }, { folded_units: 1 }])(
    'rejects a row whose column is %j',
    (compaction) => {
      expect(parseFoldRow({ summaryText: 'text', compaction })).toBeNull();
    }
  );

  it('rejects a row with no text', () => {
    expect(
      parseFoldRow({ summaryText: '  ', compaction: serializeFoldColumn(withCarry) })
    ).toBeNull();
  });

  it('saves a new current version carrying the column, and links it to the thread', async () => {
    const insert = spy(ThreadSummaries, 'insertNewVersion', async (input: { id: string }) => ({
      ...input,
      version: 3,
    }));
    const link = spy(Links, 'upsert', async () => undefined);

    const row = await saveCompaction({
      threadId: 'thread-1',
      agentId: 'test-agent-a',
      record: withCarry,
      modelUsed: 'anthropic/test',
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^thread_summary-/),
        threadId: 'thread-1',
        agentId: 'test-agent-a',
        summaryText: record.summary,
        messagesCovered: 2,
        modelUsed: 'anthropic/test',
        compaction: serializeFoldColumn(withCarry),
      })
    );
    expect(insert.mock.calls[0]![0]).not.toHaveProperty('lastMessageId');
    expect(link).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: row.id, targetId: 'thread-1', relation: 'summarizes' })
    );
  });

  it('still saves the summary when the graph link cannot be written', async () => {
    spy(ThreadSummaries, 'insertNewVersion', async (input: { id: string }) => ({ ...input }));
    spy(Links, 'upsert', async () => {
      throw new Error('links down');
    });
    await expect(
      saveCompaction({
        threadId: 'thread-1',
        agentId: 'test-agent-a',
        record,
        modelUsed: 'anthropic/test',
      })
    ).resolves.toMatchObject({ summaryText: record.summary });
  });

  it('loads the newest fold from thread summaries before looking at the activity log', async () => {
    spy(ThreadSummaries, 'getLatestCompaction', async () => ({
      summaryText: record.summary,
      compaction: serializeFoldColumn(record),
    }));
    const legacy = spy(AgentActivityLog, 'getLatestByTool', async () => null);
    expect(await loadLatestCompaction('thread-1', 'test-agent-a')).toEqual({
      ...record,
      carryForward: null,
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it('falls back to a fold saved in the activity log when there is no fold row', async () => {
    spy(ThreadSummaries, 'getLatestCompaction', async () => null);
    spy(AgentActivityLog, 'getLatestByTool', async () => ({
      toolOutput: serializeCompactionRecord(record, 'anthropic/test'),
    }));
    expect(await loadLatestCompaction('thread-1', 'test-agent-a')).toEqual({
      ...record,
      carryForward: null,
    });
  });

  it("never borrows another agent's fold: an agent with none of its own gets null", async () => {
    spy(ThreadSummaries, 'getLatestCompaction', async () => null);
    spy(AgentActivityLog, 'getLatestByTool', async () => null);
    expect(await loadLatestCompaction('thread-1', 'test-agent-new')).toBeNull();
    expect((ThreadSummaries as Record<string, unknown>).getLatestThreadCompaction).toBeUndefined();
  });

  it('keeps the newcomer cut marker through the fold column', () => {
    const cut = { ...record, cut: true, summary: 'Joined after 4 earlier turns; not shown.' };
    const parsed = parseFoldRow({ summaryText: cut.summary, compaction: serializeFoldColumn(cut) });
    expect(parsed).toEqual({ ...cut, carryForward: null });
    const fold = parseFoldRow({
      summaryText: record.summary,
      compaction: serializeFoldColumn(record),
    });
    expect(fold?.cut).toBeUndefined();
  });
});
