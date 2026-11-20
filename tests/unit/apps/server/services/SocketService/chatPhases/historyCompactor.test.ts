import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ProviderMessage } from '@server/services/ProviderChatService';
import type { ReplayUnitSpan } from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import type { HistoryFoldState } from '@server/services/contextWindow/historyFold';
import type { ContextBudget } from '@server/services/contextWindow/budget';
import {
  createHistoryCompactor,
  type HistoryCompactorDeps,
} from '@server/services/SocketService/handlers/chatPhases/historyCompactor';
import { COMPACTION_SUMMARY_HEADER } from '@server/services/contextWindow/compactionMessage';

const budget = { usableBudget: 100_000, tokenThreshold: 60_000 } as ContextBudget;
const key = (n: number) => ({ effectiveStart: `t${n}`, startAt: `t${n}`, sortId: `unit-${n}` });
// 3 units: 2 messages, 1 message, 2 messages.
const units = (): ReplayUnitSpan[] => [
  { key: key(1), end: 2 },
  { key: key(2), end: 3 },
  { key: key(3), end: 5 },
];
const messages = (): ProviderMessage[] =>
  Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `m${i}` }) as ProviderMessage);
const text = (m: ProviderMessage) => (typeof m.content === 'string' ? m.content : '');

function setup(overrides: Partial<HistoryCompactorDeps> = {}) {
  const deps = {
    summarize: jest.fn(async (_args: unknown) => ({
      ok: true as const,
      text: 'NEW NOTES',
      modelUsed: 'anthropic/test',
      rolled: true,
    })),
    save: jest.fn(async (_args: unknown) => ({ id: 'summary-1', summaryText: 'NEW NOTES' })),
    embed: jest.fn(async (_row: unknown) => undefined),
    halt: jest.fn(async (_outcome: unknown) => null),
    enabled: () => true,
    ...overrides,
  } as unknown as HistoryCompactorDeps & {
    summarize: jest.Mock;
    save: jest.Mock;
    embed: jest.Mock;
    halt: jest.Mock;
  };
  const compactor = createHistoryCompactor(
    {
      threadId: 'thread-1',
      agentId: 'test-agent-a',
      agentName: 'Test Agent',
      runId: 'run-1',
      abortSignal: new AbortController().signal,
    },
    deps
  );
  return { deps, compactor };
}
const stateOf = (compaction: HistoryFoldState['compaction'] = null): HistoryFoldState => ({
  units: units(),
  compaction,
});

describe('createHistoryCompactor.compact', () => {
  beforeEach(() => jest.clearAllMocks());

  it('summarizes exactly the folded units, saves the cut, and rewrites the list', async () => {
    const { deps, compactor } = setup();
    const list = messages();
    const state = stateOf();

    const result = await compactor.compact({
      messages: list,
      state,
      splitIndex: 3,
      budget,
      carryForward: 'Roster: A, B.',
    });

    expect(result.kind).toBe('compacted');
    expect(deps.summarize.mock.calls[0]![0]).toMatchObject({
      threadId: 'thread-1',
      agentId: 'test-agent-a',
    });
    const folded = (deps.summarize.mock.calls[0]![0] as { folded: ProviderMessage[] }).folded;
    expect(folded.map(text)).toEqual(['m0', 'm1', 'm2']);

    expect(deps.save).toHaveBeenCalledTimes(1);
    // The saved summary is handed to search to embed, after the save.
    expect(deps.embed).toHaveBeenCalledWith(expect.objectContaining({ id: 'summary-1' }));
    expect(deps.save.mock.calls[0]![0]).toMatchObject({
      threadId: 'thread-1',
      agentId: 'test-agent-a',
      modelUsed: 'anthropic/test',
      record: {
        through: key(2),
        summary: 'NEW NOTES',
        foldedUnits: 2,
        carryForward: 'Roster: A, B.',
      },
    });

    expect(text(list[0]!)).toContain(COMPACTION_SUMMARY_HEADER);
    expect(text(list[0]!)).toContain('NEW NOTES');
    expect(text(list[0]!)).toContain('Roster: A, B.');
    expect(list.slice(1).map(text)).toEqual(['m3', 'm4']);
    expect(state.units.map((u) => [u.key.sortId, u.end])).toEqual([['unit-3', 3]]);
    if (result.kind === 'compacted') {
      expect(result.foldedUnitIds).toEqual(['unit-1', 'unit-2']);
    }
  });

  it('hands the summarizer the earlier summary with only the new span, and saves its rewrite whole', async () => {
    const { deps, compactor } = setup();
    const prior = { through: key(0), summary: '## Fold 1\nEARLIER NOTES', foldedUnits: 4 };
    // The replay's first message is the earlier summary; spans already include it.
    const list: ProviderMessage[] = [
      { role: 'user', content: `${COMPACTION_SUMMARY_HEADER}\nEARLIER NOTES` },
      ...messages().slice(0, 4),
    ];
    const state: HistoryFoldState = {
      compaction: prior,
      units: [
        { key: key(1), end: 3 },
        { key: key(2), end: 5 },
      ],
    };

    const result = await compactor.compact({ messages: list, state, splitIndex: 3, budget });

    expect(result.kind).toBe('compacted');
    const args = deps.summarize.mock.calls[0]![0] as {
      folded: ProviderMessage[];
      priorSummary: string;
    };
    expect(args.folded.map(text)).toEqual(['m0', 'm1']);
    expect(args.priorSummary).toBe('## Fold 1\nEARLIER NOTES');
    // The rewrite replaces the earlier summary: nothing is stuck on to it.
    expect(deps.save.mock.calls[0]![0]).toMatchObject({
      record: { summary: 'NEW NOTES', foldedUnits: 5, through: key(1) },
    });
  });

  it('appends the new notes as a fold section when the summarizer could not read the earlier summary', async () => {
    const { deps, compactor } = setup({
      summarize: jest.fn(async (_args: unknown) => ({
        ok: true as const,
        text: 'NEW NOTES',
        modelUsed: 'anthropic/test',
        rolled: false,
      })),
    } as Partial<HistoryCompactorDeps>);
    const prior = { through: key(0), summary: '## Fold 1\nEARLIER NOTES', foldedUnits: 4 };
    const list: ProviderMessage[] = [
      { role: 'user', content: `${COMPACTION_SUMMARY_HEADER}\nEARLIER NOTES` },
      ...messages().slice(0, 4),
    ];
    const state: HistoryFoldState = {
      compaction: prior,
      units: [
        { key: key(1), end: 3 },
        { key: key(2), end: 5 },
      ],
    };

    await compactor.compact({ messages: list, state, splitIndex: 3, budget });

    expect(deps.save.mock.calls[0]![0]).toMatchObject({
      record: { summary: '## Fold 1\nEARLIER NOTES\n\n## Fold 2\nNEW NOTES' },
    });
  });

  it('reports a standalone unit by its message id, without the replay prefix', async () => {
    const { compactor } = setup();
    const state: HistoryFoldState = {
      compaction: null,
      units: [
        { key: { ...key(1), sortId: 'run-1' }, end: 2 },
        { key: { ...key(2), sortId: '__standalone:message-hook-post' }, end: 3 },
        { key: key(3), end: 5 },
      ],
    };
    const result = await compactor.compact({ messages: messages(), state, splitIndex: 3, budget });
    expect(result.kind).toBe('compacted');
    if (result.kind === 'compacted') {
      expect(result.foldedUnitIds).toEqual(['run-1', 'message-hook-post']);
    }
  });

  it('does nothing when no whole unit sits before the split', async () => {
    const { deps, compactor } = setup();
    const list = messages();
    const result = await compactor.compact({
      messages: list,
      state: stateOf(),
      splitIndex: 1,
      budget,
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no whole unit to fold' });
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(list).toHaveLength(5);
  });

  it('does nothing when conversation compaction is turned off', async () => {
    const { deps, compactor } = setup({ enabled: () => false });
    const result = await compactor.compact({
      messages: messages(),
      state: stateOf(),
      splitIndex: 3,
      budget,
    });
    expect(result.kind).toBe('skipped');
    expect(deps.summarize).not.toHaveBeenCalled();
  });

  it('leaves everything as it was and raises the halt when the summarizer fails', async () => {
    const { deps, compactor } = setup({
      summarize: jest.fn(async () => ({
        ok: false as const,
        reason: 'generation-failed' as const,
        detail: '404 model not found',
        providerId: 'anthropic',
        modelId: 'claude-test',
      })),
    } as never);
    const list = messages();
    const state = stateOf();
    const result = await compactor.compact({ messages: list, state, splitIndex: 3, budget });

    expect(result).toMatchObject({ kind: 'failed', reason: 'generation-failed' });
    expect(deps.save).not.toHaveBeenCalled();
    expect(list.map(text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(state.units).toHaveLength(3);
    expect((deps.halt as jest.Mock).mock.calls[0]![0]).toEqual({
      status: 'skipped',
      reason: 'generation-failed',
      detail: '404 model not found',
      providerId: 'anthropic',
      modelId: 'claude-test',
    });
  });

  it('still folds when embedding the saved summary fails', async () => {
    const { deps, compactor } = setup({
      embed: jest.fn(async (_row: unknown) => {
        throw new Error('embedder down');
      }),
    } as Partial<HistoryCompactorDeps>);
    const list = messages();
    const result = await compactor.compact({
      messages: list,
      state: stateOf(),
      splitIndex: 3,
      budget,
    });
    expect(result.kind).toBe('compacted');
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(text(list[0]!)).toContain('NEW NOTES');
  });

  it('does not try to embed when the save returned nothing', async () => {
    const embed = jest.fn(async (_row: unknown) => undefined);
    const { compactor } = setup({
      save: jest.fn(async (_args: unknown) => undefined),
      embed,
    } as unknown as Partial<HistoryCompactorDeps>);
    const result = await compactor.compact({
      messages: messages(),
      state: stateOf(),
      splitIndex: 3,
      budget,
    });
    expect(result.kind).toBe('compacted');
    expect(embed).not.toHaveBeenCalled();
  });

  it('does not persist an empty summary', async () => {
    const { deps, compactor } = setup({
      summarize: jest.fn(async () => ({ ok: true as const, text: '', modelUsed: 'x/y' })),
    } as never);
    const result = await compactor.compact({
      messages: messages(),
      state: stateOf(),
      splitIndex: 3,
      budget,
    });
    expect(result.kind).toBe('skipped');
    expect(deps.save).not.toHaveBeenCalled();
  });

  it('lets a stopped run through', async () => {
    const controller = new AbortController();
    const deps = setup().deps;
    const compactor = createHistoryCompactor(
      {
        threadId: 'thread-1',
        agentId: 'test-agent-a',
        agentName: 'Test Agent',
        runId: 'run-1',
        abortSignal: controller.signal,
      },
      deps
    );
    controller.abort();
    await expect(
      compactor.compact({ messages: messages(), state: stateOf(), splitIndex: 3, budget })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
