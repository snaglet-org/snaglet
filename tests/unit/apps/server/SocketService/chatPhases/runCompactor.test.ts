/**
 * runCompactor — one model attempt's in-run compaction: the summary model
 * call, its fallbacks, the persisted record, the live step and abort.
 */

const resolveUtilityModelMock = jest.fn();
const generateUtilityTextMock = jest.fn();
const logActivityMock = jest.fn();
const loggerInfo = jest.fn();
const logsWarn = jest.fn();

jest.mock('@server/services/summary/UtilityModelResolver', () => ({
  resolveUtilityModel: (...a: unknown[]) => resolveUtilityModelMock(...a),
}));
jest.mock('@server/services/summary/generateUtilityText', () => ({
  generateUtilityText: (...a: unknown[]) => generateUtilityTextMock(...a),
}));
jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { logActivity: (...a: unknown[]) => logActivityMock(...a) },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: (...a: unknown[]) => loggerInfo(...a), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: { warn: (...a: unknown[]) => logsWarn(...a), socket: { event: jest.fn() } },
}));

import type { ContextBudget } from '@server/services/ContextWindowService';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import {
  RELAYED_CLOSE,
  RELAYED_LEGEND,
  RELAYED_OPEN,
} from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import { createRunCompactor } from '@server/services/SocketService/handlers/chatPhases/runCompactor';

const THREAD_ID = 'thread-1111111111111-aaaaaaaa';
const AGENT_ID = 'test-agent-a';
const RUN_ID = 'run-1';
const SUMMARY = [
  'Goal: update the parser in src/parser.ts.',
  'Next step: run pnpm test for the parser.',
  'Files: src/parser.ts — split tokenize() out.',
  'Commands and results: None.',
  'Decisions: None.',
  'Open errors: None.',
  'Instructions received: None.',
].join('\n');

const budget: ContextBudget = {
  provider: 'test-provider',
  modelId: 'test-model',
  contextWindowTokens: 16_000,
  effectiveContextWindowTokens: 16_000,
  safetyMarginPct: 0,
  maxOutputTokens: 2_000,
  systemPromptTokens: 0,
  toolCatalogTokens: 0,
  overheadTokens: 0,
  overheadFloored: false,
  usableBudget: 10_000,
  tokenThreshold: 7_500,
  minMessagesBeforeCompression: 6,
  maxSummaryChars: 3_500,
};

const RESOLVED = {
  ok: true,
  model: {
    providerId: 'test-provider',
    modelId: 'test-summary-model',
    credentialId: null,
    isLocal: false,
    maxInputChars: 60_000,
    timeoutMs: 60_000,
    source: 'own-model',
  },
};

function cycle(id: string): ProviderMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'action',
          input: { tool: 'file_read', params: { path: `src/${id}.ts` } },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(2_000) }],
    },
  ];
}

/** A helper's run: the orchestrator's brief (relayed), the turn-context tail, then tool cycles. */
function helperRun(cycles: number): ProviderMessage[] {
  return [
    {
      role: 'assistant',
      content: `${RELAYED_LEGEND}\n${RELAYED_OPEN}\nBrief: update the parser in src/parser.ts.\n${RELAYED_CLOSE}`,
    },
    { role: 'user', content: '[turn context] coordinates', ephemeral: true },
    ...Array.from({ length: cycles }, (_, i) => cycle(`call-${i}`)).flat(),
  ];
}

const RUN_START = 2;
type Broadcast = { type: string; payload: Record<string, unknown> };

function makeCompactor(abortController = new AbortController()) {
  const broadcasts: Broadcast[] = [];
  const compactor = createRunCompactor({
    threadId: THREAD_ID,
    agentId: AGENT_ID,
    agentName: 'Test Agent',
    runId: RUN_ID,
    sessionId: 'session-1',
    currentRunBoundary: 0,
    runStartIndex: RUN_START,
    abortSignal: abortController.signal,
    broadcast: (message) => broadcasts.push(message),
  });
  return { compactor, broadcasts, abortController };
}

const OVER = budget.tokenThreshold + 1;

beforeEach(() => {
  delete process.env.COMPACT_CONVERSATIONS;
  resolveUtilityModelMock.mockReset().mockResolvedValue(RESOLVED);
  generateUtilityTextMock.mockReset().mockResolvedValue(SUMMARY);
  logActivityMock.mockReset().mockResolvedValue({});
  loggerInfo.mockReset();
  logsWarn.mockReset();
});

afterAll(() => {
  delete process.env.COMPACT_CONVERSATIONS;
});

describe('runCompactor', () => {
  it('under the threshold the array is left alone (same reference, same content)', async () => {
    const { compactor } = makeCompactor();
    const messages = helperRun(10);
    const before = [...messages];
    await expect(compactor.compact(messages, budget, budget.tokenThreshold)).resolves.toBeNull();
    expect(messages).toEqual(before);
    for (let i = 0; i < before.length; i++) expect(messages[i]).toBe(before[i]);
    expect(resolveUtilityModelMock).not.toHaveBeenCalled();
    expect(compactor.count()).toBe(0);
  });

  it('summarizes the span with the agent summary model and records it on the run', async () => {
    const { compactor, broadcasts } = makeCompactor();
    const messages = helperRun(10);
    const brief = messages[0];

    const outcome = await compactor.compact(messages, budget, OVER);
    expect(outcome).not.toBeNull();
    expect(resolveUtilityModelMock).toHaveBeenCalledWith({
      purpose: 'thread-summary',
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });
    const args = generateUtilityTextMock.mock.calls[0]![1] as {
      system: string;
      userMessage: string;
      maxOutputTokens: number;
      signal: AbortSignal;
    };
    expect(args.system).toContain('Next step:');
    expect(args.maxOutputTokens).toBe(800);
    // The goal is the brief, unwrapped; the ephemeral tail is not part of it.
    expect(args.userMessage).toContain(
      'TASK (the request that started this run):\nBrief: update the parser in src/parser.ts.'
    );
    expect(args.userMessage).not.toContain(RELAYED_LEGEND);
    expect(args.userMessage).not.toContain('[turn context]');
    expect(args.userMessage).toContain('[call] file_read path=src/call-0.ts');

    // Brief + tail untouched, then the summary, then the four newest cycles.
    expect(messages[0]).toBe(brief);
    expect(String(messages[RUN_START]!.content)).toContain('[Earlier in this run, summarized]');
    expect(String(messages[RUN_START]!.content)).toContain(SUMMARY);
    expect(messages).toHaveLength(RUN_START + 1 + 8);
    expect(compactor.count()).toBe(1);

    await compactor.record(outcome!, 3_100, budget);
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    const line = String(loggerInfo.mock.calls[0]![0]);
    expect(line).toContain('[context] run compacted');
    expect(line).toContain('folded 12 messages (6 tool cycles)');
    expect(line).toContain(`est. tokens ${OVER} → 3100`);
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        runId: RUN_ID,
        actionType: 'tool_call',
        tool: 'run_compaction',
        toolInput: expect.objectContaining({
          compaction: 1,
          folded_messages: 12,
          kept_messages: 8,
          tokens_before: OVER,
          tokens_after: 3_100,
        }),
        toolOutput: {
          output: SUMMARY,
          source: 'model',
          model_used: 'test-provider/test-summary-model',
          fallback_reason: null,
        },
      })
    );
    // Shown live like a tool step: call when it starts, result when it lands.
    expect(broadcasts.map((b) => b.type)).toEqual(['socket:tool:call', 'socket:tool:result']);
    expect(broadcasts[0]!.payload).toMatchObject({
      agentId: AGENT_ID,
      runId: RUN_ID,
      toolName: 'run_compaction',
    });
    expect(broadcasts[1]!.payload).toMatchObject({
      callId: broadcasts[0]!.payload.callId,
      success: true,
      output: SUMMARY,
    });
  });

  it('falls back to a digest with a warning when the summary call fails', async () => {
    generateUtilityTextMock.mockRejectedValue(new Error('503 overloaded'));
    const { compactor } = makeCompactor();
    const messages = helperRun(10);

    const outcome = await compactor.compact(messages, budget, OVER);
    expect(outcome?.source).toBe('digest');
    expect(String(messages[RUN_START]!.content)).toContain('Machine digest of 12 folded messages');
    expect(logsWarn).toHaveBeenCalledWith(
      'run compaction fell back to a digest',
      expect.objectContaining({ reason: 'test-provider/test-summary-model: 503 overloaded' })
    );
    await compactor.record(outcome!, 3_000, budget);
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolOutput: expect.objectContaining({
          source: 'digest',
          fallback_reason: 'test-provider/test-summary-model: 503 overloaded',
        }),
      })
    );
  });

  it('falls back when no summary model may be used, without calling one', async () => {
    resolveUtilityModelMock.mockResolvedValue({
      ok: false,
      reason: 'no-summary-model-configured',
    });
    const { compactor } = makeCompactor();
    const outcome = await compactor.compact(helperRun(10), budget, OVER);
    expect(outcome?.source).toBe('digest');
    expect(outcome?.fallbackReason).toBe('no summary model: no-summary-model-configured');
    expect(generateUtilityTextMock).not.toHaveBeenCalled();
  });

  it('falls back when the reply fails the quality floor', async () => {
    generateUtilityTextMock.mockResolvedValue('I cannot summarize this conversation, sorry.');
    const { compactor } = makeCompactor();
    const outcome = await compactor.compact(helperRun(10), budget, OVER);
    expect(outcome?.source).toBe('digest');
    expect(outcome?.fallbackReason).toContain('refusal');
  });

  it('keeps a model summary whose last section ends on a path (structured notes)', async () => {
    generateUtilityTextMock.mockResolvedValue(
      'Goal: read ten files and describe each.\nNext step: read turnLoop.ts\n' +
        'Files:\n- read compression.ts\n- read SubagentService.ts\n' +
        'Facts:\n- base folder apps/server/src/services'
    );
    const { compactor } = makeCompactor();
    const outcome = await compactor.compact(helperRun(10), budget, OVER);
    expect(outcome?.source).toBe('model');
    expect(outcome?.summary).toContain('Next step: read turnLoop.ts');
  });

  it('falls back when the summary does not arrive in time', async () => {
    jest.useFakeTimers();
    try {
      generateUtilityTextMock.mockImplementation(() => new Promise(() => {}));
      resolveUtilityModelMock.mockResolvedValue({
        ...RESOLVED,
        model: { ...RESOLVED.model, timeoutMs: 1_000 },
      });
      const { compactor } = makeCompactor();
      const pending = compactor.compact(helperRun(10), budget, OVER);
      await jest.advanceTimersByTimeAsync(31_001);
      const outcome = await pending;
      expect(outcome?.source).toBe('digest');
      expect(outcome?.fallbackReason).toContain('no summary within 31000ms');
    } finally {
      jest.useRealTimers();
    }
  });

  it('with COMPACT_CONVERSATIONS=false: a digest, no model call, nothing persisted', async () => {
    process.env.COMPACT_CONVERSATIONS = 'false';
    const { compactor } = makeCompactor();
    const messages = helperRun(10);
    const outcome = await compactor.compact(messages, budget, OVER);
    expect(outcome?.source).toBe('digest');
    expect(outcome?.persist).toBe(false);
    expect(resolveUtilityModelMock).not.toHaveBeenCalled();
    expect(generateUtilityTextMock).not.toHaveBeenCalled();
    expect(logsWarn).not.toHaveBeenCalled();
    await compactor.record(outcome!, 3_000, budget);
    expect(logActivityMock).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledTimes(1);
  });

  it('a Stop during the summary call aborts: rejects, folds nothing, saves nothing', async () => {
    const { compactor, broadcasts, abortController } = makeCompactor();
    generateUtilityTextMock.mockImplementation(() => {
      abortController.abort();
      return new Promise(() => {});
    });
    const messages = helperRun(10);
    const before = [...messages];
    await expect(compactor.compact(messages, budget, OVER)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(messages).toEqual(before);
    expect(compactor.count()).toBe(0);
    expect(logActivityMock).not.toHaveBeenCalled();
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'socket:tool:result',
      payload: { success: false },
    });
  });

  it('a second compaction hands the first summary to the summarizer to fold in', async () => {
    const { compactor } = makeCompactor();
    const messages = helperRun(10);
    await compactor.compact(messages, budget, OVER);
    for (let i = 10; i < 18; i++) messages.push(...cycle(`call-${i}`));
    generateUtilityTextMock.mockResolvedValue(SUMMARY.replace('split tokenize()', 'done'));

    const second = await compactor.compact(messages, budget, OVER);
    expect(second?.compaction).toBe(2);
    const prompt = (generateUtilityTextMock.mock.calls[1]![1] as { userMessage: string })
      .userMessage;
    expect(prompt).toContain(`EARLIER SUMMARY OF THIS RUN:\n${SUMMARY}`);
    const summaries = messages.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[Earlier in this run')
    );
    expect(summaries).toHaveLength(1);
    expect(compactor.count()).toBe(2);
  });
});
