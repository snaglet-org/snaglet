/**
 * promptBuilder — a history fold end to end: the real compressMessages decides where to cut, the
 * real history compactor folds whole replay units into a persisted compaction (summarizer and
 * store stubbed), and the payload that goes to the model is built from the rewritten list.
 */

jest.mock('@server/services/settings', () => ({
  settingsService: { read: jest.fn(async () => 1_500) },
}));
jest.mock('@server/services/SocketService/handlers/chatHelpers', () => {
  const actual = jest.requireActual(
    '@server/services/SocketService/handlers/chatHelpers/toolResultCondense'
  );
  return {
    condenseProcessedToolResults: actual.condenseProcessedToolResults,
    logLlmPayload: jest.fn(),
  };
});
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import type { ContextBudget } from '@server/services/ContextWindowService';
import type { ProviderMessage } from '@server/services/ProviderChatService';
import type { ReplayUnitSpan } from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import type { HistoryFoldState } from '@server/services/contextWindow/historyFold';
import { COMPACTION_SUMMARY_HEADER } from '@server/services/contextWindow/compactionMessage';
import { buildPromptMessagesForIteration } from '@server/services/SocketService/handlers/chatPhases/promptBuilder';
import {
  createHistoryCompactor,
  type HistoryCompactorDeps,
} from '@server/services/SocketService/handlers/chatPhases/historyCompactor';

const text = (m: ProviderMessage) => (typeof m.content === 'string' ? m.content : '');
// 14 one-message units, each about 100 tokens.
const LINE = 'word '.repeat(80);
const history = (): ProviderMessage[] =>
  Array.from({ length: 14 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `line ${i} ${LINE}`,
  })) as ProviderMessage[];
const spans = (): ReplayUnitSpan[] =>
  Array.from({ length: 14 }, (_, i) => ({
    key: { effectiveStart: `t${i}`, startAt: `t${i}`, sortId: `unit-${i}` },
    end: i + 1,
  }));

const budget = {
  provider: 'anthropic',
  modelId: 'test-model',
  usableBudget: 4_000,
  tokenThreshold: 800,
  minMessagesBeforeCompression: 4,
  maxSummaryChars: 3_500,
  tailMessages: 4,
} as unknown as ContextBudget;

function deps(overrides: Partial<HistoryCompactorDeps> = {}) {
  return {
    summarize: jest.fn(async () => ({
      ok: true as const,
      text: 'MODEL NOTES about the folded lines.',
      modelUsed: 'anthropic/test',
    })),
    save: jest.fn(async () => undefined),
    halt: jest.fn(async () => null),
    enabled: () => true,
    ...overrides,
  } as unknown as HistoryCompactorDeps & { summarize: jest.Mock; save: jest.Mock; halt: jest.Mock };
}

async function build(opts: {
  list: ProviderMessage[];
  state: HistoryFoldState;
  compactor?: ReturnType<typeof createHistoryCompactor>;
  onHistoryFolded?: jest.Mock;
}) {
  const agent = {
    id: 'test-agent-a',
    name: 'Test Agent',
    systemPrompt: 'You help.',
  } as SnagletAgent;
  return buildPromptMessagesForIteration({
    agent,
    runtimeAgent: agent,
    agentMessages: opts.list as never,
    budget,
    isGroup: false,
    threadName: 'Test thread',
    threadId: 'thread-1',
    systemBlocks: [],
    toolRows: [],
    iteration: 0,
    compactionCarryForward: '[current roster: Test Agent · dispatch mode: solo]',
    currentRunBoundary: opts.list.length,
    historyCompactor: opts.compactor,
    historyFold: opts.compactor ? opts.state : undefined,
    onHistoryFolded: opts.onHistoryFolded,
  });
}

const compactorWith = (d: ReturnType<typeof deps>) =>
  createHistoryCompactor(
    {
      threadId: 'thread-1',
      agentId: 'test-agent-a',
      agentName: 'Test Agent',
      runId: 'run-1',
      abortSignal: new AbortController().signal,
    },
    d
  );

describe('buildPromptMessagesForIteration with a history compactor', () => {
  it('folds whole units, saves the cut, and sends the model summary instead of the folded lines', async () => {
    const d = deps();
    const list = history();
    const state: HistoryFoldState = { units: spans(), compaction: null };
    const onHistoryFolded = jest.fn();

    const payload = await build({ list, state, compactor: compactorWith(d), onHistoryFolded });

    // The saved cut names a whole unit, and the summarizer read exactly the units it covers.
    const saved = d.save.mock.calls[0]![0] as {
      record: { through: { sortId: string }; foldedUnits: number };
    };
    const folded = (d.summarize.mock.calls[0]![0] as { folded: ProviderMessage[] }).folded;
    expect(saved.record.foldedUnits).toBe(folded.length);
    expect(saved.record.through.sortId).toBe(`unit-${folded.length - 1}`);

    // The model gets the model-written summary first, then the kept units: no gap, no overlap.
    expect(text(payload[0]!)).toContain(COMPACTION_SUMMARY_HEADER);
    expect(text(payload[0]!)).toContain('MODEL NOTES about the folded lines.');
    expect(text(payload[0]!)).toContain('[current roster: Test Agent · dispatch mode: solo]');
    const firstKept = folded.length;
    expect(text(payload[1]!).startsWith(`line ${firstKept} `)).toBe(true);
    expect(payload.map(text).join('\n')).not.toContain(`line ${firstKept - 1} `);

    // The list the run keeps is the rewritten one, and the caller is told how far it moved.
    expect(text(list[0]!)).toContain(COMPACTION_SUMMARY_HEADER);
    expect(list).toHaveLength(14 - folded.length + 1);
    expect(onHistoryFolded).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'compacted', foldedUnits: folded.length }),
      folded.length - 1
    );
  });

  it('falls back to the synthesized digest, and still sends, when the summarizer fails', async () => {
    const d = deps({
      summarize: jest.fn(async () => ({
        ok: false as const,
        reason: 'generation-failed' as const,
        detail: 'down',
        providerId: 'anthropic',
        modelId: 'test',
      })),
    } as never);
    const list = history();
    const state: HistoryFoldState = { units: spans(), compaction: null };

    const payload = await build({ list, state, compactor: compactorWith(d) });

    expect(d.save).not.toHaveBeenCalled();
    expect(d.halt).toHaveBeenCalledTimes(1);
    expect(list).toHaveLength(14); // untouched
    expect(text(payload[0]!)).toContain('Historical context summary');
    expect(text(payload[0]!)).not.toContain('MODEL NOTES');
  });

  it('without a compactor it uses the synthesized digest, never the thread digest', async () => {
    const list = history();
    const payload = await build({ list, state: { units: [], compaction: null } });
    expect(text(payload[0]!)).toContain('Historical context summary');
    expect(list).toHaveLength(14);
  });
});
