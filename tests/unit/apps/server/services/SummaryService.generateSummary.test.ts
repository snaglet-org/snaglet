/**
 * SummaryService.generateSummary — the provider-agnostic thread-summary
 * pass: resolution outcomes propagate, the quality floor discards
 * garbage (one simplified-prompt retry, then a visible skip), provenance is
 * provider-qualified, the message window is budgeted against the resolved
 * model, and concurrent passes for one thread+agent are single-flighted.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listByThreadId = jest.fn(async (): Promise<unknown[]> => []);
const listRunsByThreadId = jest.fn(async (): Promise<unknown[]> => []);
const getActivityByThreadId = jest.fn(async (): Promise<unknown[]> => []);
const getByThreadAndAgent = jest.fn(async (): Promise<unknown> => null);
const getByThread = jest.fn(async (): Promise<unknown> => null);
const insertNewVersion = jest.fn(async (input: Record<string, unknown>) => ({
  id: 'summary-1',
  summaryText: String(input.summaryText ?? ''),
}));
const linksUpsert = jest.fn(async () => undefined);
const logActivity = jest.fn(async () => undefined);
const sumToolChars = jest.fn(async (..._args: unknown[]): Promise<number> => 0);
const broadcastToChannel = jest.fn();
const generateDocumentEmbedding = jest.fn(async () => ({ embedding: null, modelRowId: null }));
const getEffectiveModel = jest.fn(async (): Promise<unknown> => null);
const resolveModelMetadata = jest.fn(async () => ({}));
const resolveUtilityModel = jest.fn(
  async (): Promise<unknown> => ({
    ok: true,
    model: resolvedOllama,
  })
);
const generateUtilityText = jest.fn(async (): Promise<string> => GOOD_SUMMARY);

const resolvedOllama = {
  providerId: 'ollama',
  modelId: 'qwen2.5:3b',
  credentialId: null,
  isLocal: true,
  maxInputChars: 10_000,
  timeoutMs: 300_000,
  source: 'own-model',
};

const GOOD_SUMMARY =
  'The user asked for a refactor plan; the agent proposed three steps and completed the first. ' +
  'Next step is adding tests for the resolver module.';

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { listByThreadId: (...a: unknown[]) => listByThreadId(...(a as [])) },
}));
jest.mock('@snaglet/db/tables/runs', () => ({
  Runs: { listByThreadId: (...a: unknown[]) => listRunsByThreadId(...(a as [])) },
}));
jest.mock('@snaglet/db/tables/embeddings', () => ({
  Embeddings: { listByNode: jest.fn(async () => []), create: jest.fn(async () => undefined) },
}));
jest.mock('@snaglet/db/tables/thread_summaries', () => ({
  ThreadSummaries: {
    getByThreadAndAgent: (...a: unknown[]) => getByThreadAndAgent(...(a as [])),
    getByThread: (...a: unknown[]) => getByThread(...(a as [])),
    insertNewVersion: (...a: unknown[]) => insertNewVersion(...(a as [Record<string, unknown>])),
  },
}));
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { getEffectiveModel: (...a: unknown[]) => getEffectiveModel(...(a as [])) },
}));
jest.mock('@snaglet/db/tables/links', () => ({
  Links: { upsert: (...a: unknown[]) => linksUpsert(...(a as [])) },
}));
jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: {
    getByThreadId: (...a: unknown[]) => getActivityByThreadId(...(a as [])),
    sumToolChars: (...a: unknown[]) => sumToolChars(...a),
    logActivity: (...a: unknown[]) => logActivity(...(a as [])),
  },
}));
jest.mock('@server/services/EmbeddingService', () => ({
  generateDocumentEmbedding: (...a: unknown[]) => generateDocumentEmbedding(...(a as [])),
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...(a as [])) },
}));
jest.mock('@server/services/metadataResolver', () => ({
  resolveModelMetadata: (...a: unknown[]) => resolveModelMetadata(...(a as [])),
}));
jest.mock('@server/services/summary/UtilityModelResolver', () => ({
  resolveUtilityModel: (...a: unknown[]) => resolveUtilityModel(...(a as [])),
}));
jest.mock('@server/services/summary/generateUtilityText', () => ({
  generateUtilityText: (...a: unknown[]) => generateUtilityText(...(a as [])),
}));

import {
  packMessagesForSummary,
  summaryService,
  SUMMARY_MAX_OUTPUT_TOKENS,
} from '@server/services/SummaryService';
import {
  SIMPLE_THREAD_SUMMARY_INSTRUCTIONS,
  THREAD_SUMMARY_INSTRUCTIONS,
} from '@server/services/summary/threadSummaryPrompts';
import { resetUtilityConcurrencyForTests } from '@server/services/summary/utilityConcurrency';

function msg(id: string, content: string, role = 'user'): Record<string, unknown> {
  const sequence = Number.parseInt(id.replace(/\D/g, ''), 10) || 1;
  return {
    id,
    threadId: 't1',
    content,
    role,
    messageType: 'text',
    agentId: role === 'assistant' ? 'agent-1' : null,
    userId: role === 'user' ? 'user-1' : null,
    createdAt: `2026-08-11T10:00:${String(sequence).padStart(2, '0')}.000Z`,
    injectedDuringRun: false,
    runId: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetUtilityConcurrencyForTests();
  delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
  delete process.env.COMPACT_CONVERSATIONS;
  listByThreadId.mockImplementation(async () => [
    msg('m1', 'Please refactor the search module.'),
    msg('m2', 'Here is a three-step plan.', 'assistant'),
  ]);
  listRunsByThreadId.mockImplementation(async () => []);
  getActivityByThreadId.mockImplementation(async () => []);
  sumToolChars.mockImplementation(async () => 0);
  getEffectiveModel.mockImplementation(async () => null);
  resolveModelMetadata.mockImplementation(async () => ({}));
  getByThreadAndAgent.mockImplementation(async () => null);
  getByThread.mockImplementation(async () => null);
  resolveUtilityModel.mockImplementation(async () => ({ ok: true, model: resolvedOllama }));
  generateUtilityText.mockImplementation(async () => GOOD_SUMMARY);
});

describe('generateSummary outcomes', () => {
  it('performs no summary work when conversation compaction is disabled', async () => {
    process.env.COMPACT_CONVERSATIONS = 'false';

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'compact-conversations-disabled',
    });
    expect(listByThreadId).not.toHaveBeenCalled();
    expect(resolveUtilityModel).not.toHaveBeenCalled();
    expect(generateUtilityText).not.toHaveBeenCalled();
    expect(insertNewVersion).not.toHaveBeenCalled();
  });

  it('generates and stamps provider-qualified provenance', async () => {
    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toEqual({
      status: 'generated',
      providerId: 'ollama',
      modelId: 'qwen2.5:3b',
      summaryId: 'summary-1',
    });
    expect(insertNewVersion).toHaveBeenCalledWith(
      expect.objectContaining({ modelUsed: 'ollama/qwen2.5:3b', summaryText: GOOD_SUMMARY })
    );
    const [call] = generateUtilityText.mock.calls[0] as unknown[];
    expect(call).toBe(resolvedOllama);
  });

  it('summarizes the perceiving agent payload with bounded own tool traces and peer utterances only', async () => {
    listByThreadId.mockImplementation(async () => [
      msg('m1', 'Inspect the release configuration.'),
      {
        ...msg('m5', 'Own interim utterance: I found the config.', 'assistant'),
        agentId: 'agent-1',
        runId: 'run-own',
      },
      {
        ...msg('m9', 'Peer utterance: the deploy check passed.', 'assistant'),
        agentId: 'agent-2',
        runId: 'run-peer',
      },
    ]);
    listRunsByThreadId.mockImplementation(async () => [
      {
        id: 'run-own',
        agentId: 'agent-1',
        startedAt: '2026-08-11T10:00:02.000Z',
        finishedAt: '2026-08-11T10:00:05.000Z',
        status: 'completed',
        error: null,
      },
      {
        id: 'run-peer',
        agentId: 'agent-2',
        startedAt: '2026-08-11T10:00:06.000Z',
        finishedAt: '2026-08-11T10:00:09.000Z',
        status: 'completed',
        error: null,
      },
    ]);
    getActivityByThreadId.mockImplementation(async () => [
      {
        id: 'a-own-thought',
        runId: 'run-own',
        actionType: 'thinking',
        content: 'OWN_REASONING: compare the packaged and source configs.',
        tool: null,
        toolInput: null,
        toolOutput: null,
        createdAt: '2026-08-11T10:00:03.000Z',
      },
      {
        id: 'a-own-tool',
        runId: 'run-own',
        actionType: 'tool_call',
        content: null,
        tool: 'file_read',
        toolInput: { path: `/tmp/${'very-long-path/'.repeat(20)}config.ts` },
        toolOutput: `HEAD_SENTINEL\n${'middle-payload-'.repeat(200)}\nTAIL_SENTINEL`,
        createdAt: '2026-08-11T10:00:04.000Z',
      },
      {
        id: 'a-peer-thought',
        runId: 'run-peer',
        actionType: 'thinking',
        content: 'PEER_PRIVATE_REASONING',
        tool: null,
        toolInput: null,
        toolOutput: null,
        createdAt: '2026-08-11T10:00:07.000Z',
      },
      {
        id: 'a-peer-tool',
        runId: 'run-peer',
        actionType: 'tool_call',
        content: null,
        tool: 'peer_private_tool',
        toolInput: { secret: true },
        toolOutput: 'PEER_PRIVATE_RESULT',
        createdAt: '2026-08-11T10:00:08.000Z',
      },
    ]);

    await expect(
      summaryService.generateSummary({
        threadId: 't1',
        agentId: 'agent-1',
        agentNameMap: new Map([
          ['agent-1', 'Builder'],
          ['agent-2', 'Reviewer'],
        ]),
        force: true,
      })
    ).resolves.toMatchObject({ status: 'generated' });

    const prompt = (generateUtilityText.mock.calls[0]?.[1] as { userMessage: string }).userMessage;
    expect(prompt).toContain('OWN_REASONING');
    expect(prompt).toContain('file_read');
    // Bulky read output is dropped to something that re-fetches it, not cut to a head and tail.
    expect(prompt).toMatch(/chars omitted; re-fetch: \/tmp\/very-long-path/);
    expect(prompt).not.toContain('HEAD_SENTINEL');
    expect(prompt).not.toContain('middle-payload-'.repeat(100));
    expect(prompt).toContain('[Builder]: Own interim utterance');
    expect(prompt).toContain('[Reviewer]: Peer utterance');
    expect(prompt).not.toContain('PEER_PRIVATE_REASONING');
    expect(prompt).not.toContain('peer_private_tool');
    expect(prompt).not.toContain('PEER_PRIVATE_RESULT');
  });

  it('incorporates only activity after the prior summary message boundary', async () => {
    listByThreadId.mockImplementation(async () => [
      msg('m1', 'Old user request.'),
      { ...msg('m4', 'Old agent utterance.', 'assistant'), runId: 'run-1' },
      msg('m5', 'New user follow-up.'),
      { ...msg('m8', 'New agent utterance.', 'assistant'), runId: 'run-1' },
    ]);
    listRunsByThreadId.mockImplementation(async () => [
      {
        id: 'run-1',
        agentId: 'agent-1',
        startedAt: '2026-08-11T10:00:02.000Z',
        finishedAt: '2026-08-11T10:00:08.000Z',
        status: 'completed',
        error: null,
      },
    ]);
    getActivityByThreadId.mockImplementation(async () => [
      {
        id: 'old-thought',
        runId: 'run-1',
        actionType: 'thinking',
        content: 'OLD_REASONING_ALREADY_SUMMARIZED',
        tool: null,
        toolInput: null,
        toolOutput: null,
        createdAt: '2026-08-11T10:00:03.000Z',
      },
      {
        id: 'new-thought',
        runId: 'run-1',
        actionType: 'thinking',
        content: 'NEW_REASONING_TO_INCORPORATE',
        tool: null,
        toolInput: null,
        toolOutput: null,
        createdAt: '2026-08-11T10:00:07.000Z',
      },
    ]);
    getByThreadAndAgent.mockImplementation(async () => ({
      summaryText: 'Existing summary text.',
      messagesCovered: 2,
      lastMessageId: 'm4',
    }));

    await expect(
      summaryService.generateSummary({
        threadId: 't1',
        agentId: 'agent-1',
        force: true,
      })
    ).resolves.toMatchObject({ status: 'generated' });

    const prompt = (generateUtilityText.mock.calls[0]?.[1] as { userMessage: string }).userMessage;
    // A prior summary is never summarizer input; the new section is appended to it.
    expect(prompt).not.toContain('Existing summary text.');
    expect(prompt).toContain('NEW_REASONING_TO_INCORPORATE');
    expect(prompt).toContain('New agent utterance.');
    expect(prompt).not.toContain('OLD_REASONING_ALREADY_SUMMARIZED');
    expect(prompt).not.toContain('Old agent utterance.');
    expect(insertNewVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        messagesCovered: 4,
        lastMessageId: 'm8',
        summaryText: `Existing summary text.\n\n${GOOD_SUMMARY}`,
      })
    );
  });

  it('propagates resolver skips instead of silent null', async () => {
    resolveUtilityModel.mockImplementation(async () => ({
      ok: false,
      reason: 'no-credentials',
      detail: 'no usable credentials for mistral',
    }));

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'no-credentials',
      detail: 'no usable credentials for mistral',
    });
    expect(generateUtilityText).not.toHaveBeenCalled();
  });

  it('quality floor: one retry with the simplified template, then success', async () => {
    generateUtilityText
      .mockImplementationOnce(async () => 'I cannot summarize this conversation right now.')
      .mockImplementationOnce(async () => GOOD_SUMMARY);

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toMatchObject({ status: 'generated' });
    expect(generateUtilityText).toHaveBeenCalledTimes(2);
    const firstArgs = generateUtilityText.mock.calls[0]?.[1] as { system: string };
    const secondArgs = generateUtilityText.mock.calls[1]?.[1] as { system: string };
    expect(firstArgs.system).toContain(THREAD_SUMMARY_INSTRUCTIONS);
    expect(secondArgs.system).toContain(SIMPLE_THREAD_SUMMARY_INSTRUCTIONS);
  });

  // A summary cut at the output-token cap must never be
  // stored, even when its last character looks like a clean ending.
  type UtilityArgs = { onResult?: (m: { stopReason: string; truncated: boolean }) => void };
  const reply =
    (text: string, stopReason?: string) =>
    async (...a: unknown[]): Promise<string> => {
      const args = a[1] as UtilityArgs;
      if (stopReason) args.onResult?.({ stopReason, truncated: stopReason === 'max_tokens' });
      return text;
    };

  it('cap hit: a max_tokens stop is discarded and retried, then the retry is stored', async () => {
    (generateUtilityText as jest.Mock)
      .mockImplementationOnce(
        reply('Work continued on the summary bug. All checks passed.', 'max_tokens')
      )
      .mockImplementationOnce(reply(GOOD_SUMMARY, 'end_turn'));

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toMatchObject({ status: 'generated' });
    expect(generateUtilityText).toHaveBeenCalledTimes(2);
    expect(
      (generateUtilityText.mock.calls[0]?.[1] as { maxOutputTokens: number }).maxOutputTokens
    ).toBe(SUMMARY_MAX_OUTPUT_TOKENS);
    expect(SUMMARY_MAX_OUTPUT_TOKENS).toBe(2048);
    expect(insertNewVersion).toHaveBeenCalledWith(
      expect.objectContaining({ summaryText: GOOD_SUMMARY })
    );
  });

  it('cap hit twice: visible skip, nothing stored (previous summary kept)', async () => {
    (generateUtilityText as jest.Mock).mockImplementation(
      reply('A complete-looking sentence that still hit the cap.', 'max_tokens')
    );

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: 'quality-floor',
      detail: expect.stringContaining('output token cap'),
    });
    expect(insertNewVersion).not.toHaveBeenCalled();
  });

  it('no stop reason (local runtime): the ending check alone catches a backtick cut', async () => {
    (generateUtilityText as jest.Mock).mockImplementation(
      reply('The agent timeout work was restructured. Backlog row `')
    );

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'quality-floor' });
    expect(insertNewVersion).not.toHaveBeenCalled();
  });

  it('no stop reason (local runtime): a clean summary still stores', async () => {
    (generateUtilityText as jest.Mock).mockImplementation(reply(GOOD_SUMMARY));

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toMatchObject({ status: 'generated' });
    expect(generateUtilityText).toHaveBeenCalledTimes(1);
  });

  it('quality floor: second failure is a visible skip and nothing is written', async () => {
    generateUtilityText.mockImplementation(async () => 'Too short.');

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: 'quality-floor',
      detail: expect.stringContaining('ollama/qwen2.5:3b'),
    });
    expect(generateUtilityText).toHaveBeenCalledTimes(2);
    expect(insertNewVersion).not.toHaveBeenCalled();
  });

  it('generation errors surface as generation-failed, never a throw', async () => {
    generateUtilityText.mockImplementation(async () => {
      throw new Error('ollama daemon not reachable');
    });

    const outcome = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'generation-failed',
      detail: 'ollama daemon not reachable',
      // The failing model rides the outcome: callers name it in the user-facing
      // stop copy, and the detail string alone does not carry it.
      providerId: 'ollama',
      modelId: 'qwen2.5:3b',
    });
    expect(insertNewVersion).not.toHaveBeenCalled();
  });

  it('leaves a thread whose summary is a fold alone, even when forced', async () => {
    // The fold is the thread's summary once one exists and the folds keep it up to date; a digest
    // beside it would summarize the same messages a second time.
    resolveUtilityModel.mockClear();
    getByThreadAndAgent.mockImplementationOnce(async () => ({
      id: 'summary-fold-1',
      summaryText: 'Folded notes.',
      lastMessageId: null,
      messagesCovered: 4,
      compaction: { folded_units: 4 },
    }));
    const outcome = await summaryService.generateSummary({
      threadId: 't-folded',
      agentId: 'agent-1',
      force: true,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'folded' });
    expect(resolveUtilityModel).not.toHaveBeenCalled();
    expect(insertNewVersion).not.toHaveBeenCalled();
  });

  it('a pass that is not due reports not-due without consulting the resolver', async () => {
    // Due-ness is settled before resolution on purpose: an unavailable summary
    // model stops the run, and a young thread owes no summary yet. The
    // threshold defaults to 20,000 tokens of new conversation; this thread has two short lines.
    resolveUtilityModel.mockImplementation(async () => ({
      ok: false,
      reason: 'no-credentials',
      detail: 'no usable credentials for anthropic',
    }));

    // A thread of its own: the debounce guardrail is keyed by thread+agent and
    // the generating tests above would otherwise report 'debounced' first.
    const outcome = await summaryService.generateSummary({
      threadId: 't-not-due',
      agentId: 'agent-1',
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not-due' });
    expect(resolveUtilityModel).not.toHaveBeenCalled();
  });

  it('thirty short messages do not make a digest due', async () => {
    listByThreadId.mockImplementation(async () =>
      Array.from({ length: 30 }, (_, i) => msg(`m${i + 1}`, `ok, step ${i + 1} done`))
    );
    const outcome = await summaryService.generateSummary({
      threadId: 't-thirty-short',
      agentId: 'agent-1',
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'not-due' });
    expect(resolveUtilityModel).not.toHaveBeenCalled();
  });

  it('one tool-heavy run makes it due, counting only tool work after the last digest', async () => {
    getByThreadAndAgent.mockImplementation(async () => ({
      summaryText: 'Earlier digest.',
      messagesCovered: 1,
      lastMessageId: 'm1',
    }));
    sumToolChars.mockImplementation(async () => 100_000);
    const outcome = await summaryService.generateSummary({
      threadId: 't-tool-heavy',
      agentId: 'agent-1',
    });
    expect(outcome).toMatchObject({ status: 'generated' });
    // The aggregate was asked about this thread and agent, from the end of the covered messages.
    expect(sumToolChars).toHaveBeenCalledWith(
      't-tool-heavy',
      'agent-1',
      '2026-08-11T10:00:01.000Z'
    );
  });

  it('takes the threshold from the model metadata (summary.tokenThreshold)', async () => {
    getEffectiveModel.mockImplementation(async () => ({
      providerId: 'anthropic',
      modelId: 'claude-test',
    }));
    resolveModelMetadata.mockImplementation(async () => ({ summary: { tokenThreshold: 10 } }));
    const outcome = await summaryService.generateSummary({
      threadId: 't-override',
      agentId: 'agent-1',
    });
    expect(outcome).toMatchObject({ status: 'generated' });
  });

  it('summarizes only the new messages and appends the section to the stored digest', async () => {
    listByThreadId.mockImplementation(async () => [
      msg('m1', 'An old message.'),
      msg('m2', 'A new message.'),
    ]);
    getByThreadAndAgent.mockImplementation(async () => ({
      summaryText: 'Section one.',
      messagesCovered: 1,
      lastMessageId: 'm1',
    }));
    await summaryService.generateSummary({ threadId: 't1', agentId: 'agent-1', force: true });
    const prompt = (generateUtilityText.mock.calls[0]?.[1] as { userMessage: string }).userMessage;
    expect(prompt).toContain('A new message.');
    expect(prompt).not.toContain('Section one.');
    expect(prompt).not.toContain('PREVIOUS SUMMARY');
    expect(insertNewVersion).toHaveBeenCalledWith(
      expect.objectContaining({ summaryText: `Section one.\n\n${GOOD_SUMMARY}` })
    );
  });

  it('gives the summarizer each message whole, not cut to a preview', async () => {
    const long = 'A long decision that must reach the summarizer intact. '.repeat(40).trim();
    listByThreadId.mockImplementation(async () => [msg('m1', long), msg('m2', long, 'assistant')]);
    await summaryService.generateSummary({ threadId: 't1', agentId: 'agent-1', force: true });
    const prompt = (generateUtilityText.mock.calls[0]?.[1] as { userMessage: string }).userMessage;
    expect(prompt.split(long).length - 1).toBe(2);
  });

  it('single-flight: a concurrent pass for the same thread+agent reports in-flight', async () => {
    let release: (v: string) => void = () => undefined;
    generateUtilityText.mockImplementation(
      () => new Promise<string>((resolve) => (release = resolve))
    );

    const first = summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });
    // Give the first call a tick to enter the critical section.
    await new Promise((r) => setTimeout(r, 10));
    const second = await summaryService.generateSummary({
      threadId: 't1',
      agentId: 'agent-1',
      force: true,
    });
    expect(second).toEqual({ status: 'skipped', reason: 'in-flight' });

    release(GOOD_SUMMARY);
    await expect(first).resolves.toMatchObject({ status: 'generated' });
  });
});

describe('packMessagesForSummary budgeting', () => {
  const mkMsg = (id: number, chars: number) => msg(`m${id}`, 'x'.repeat(chars)) as never;

  it('keeps everything when it fits, in order', () => {
    const { formatted, omitted } = packMessagesForSummary(
      [
        msg('m1', 'the first message content') as never,
        msg('m2', 'the second message content') as never,
      ],
      undefined,
      10_000
    );
    expect(omitted).toBe(0);
    expect(formatted.indexOf('the first message')).toBeLessThan(
      formatted.indexOf('the second message')
    );
  });

  it('keeps an oldest contiguous prefix and defers the suffix', () => {
    const { formatted, omitted, included } = packMessagesForSummary(
      [
        msg('m1', 'first-' + 'x'.repeat(390)) as never,
        msg('m2', 'second-' + 'x'.repeat(390)) as never,
        msg('m3', 'third-' + 'x'.repeat(390)) as never,
      ],
      undefined,
      900
    );
    expect({ omitted, included }).toEqual({ omitted: 1, included: 2 });
    expect(formatted).toContain('first-');
    expect(formatted).toContain('second-');
    expect(formatted).not.toContain('third-');
    expect(formatted).toContain('later messages deferred');
  });

  it('always includes the oldest uncovered message even when over budget alone', () => {
    const { formatted, omitted, included } = packMessagesForSummary(
      [mkMsg(1, 400), mkMsg(2, 400)],
      undefined,
      10
    );
    expect(included).toBe(1);
    expect(omitted).toBe(1);
    expect(formatted).toContain('[User]');
  });

  it('advances persisted coverage only through the packed prefix', async () => {
    listByThreadId.mockImplementation(async () =>
      Array.from({ length: 10 }, (_, index) =>
        msg(`m${index + 1}`, `message-${index + 1}-` + 'x'.repeat(500))
      )
    );
    resolveUtilityModel.mockImplementation(async () => ({
      ok: true,
      model: { ...resolvedOllama, maxInputChars: 2_300 },
    }));

    await expect(
      summaryService.generateSummary({ threadId: 't1', agentId: 'agent-1', force: true })
    ).resolves.toMatchObject({ status: 'generated' });

    expect(insertNewVersion).toHaveBeenCalledWith(
      expect.objectContaining({ messagesCovered: 3, lastMessageId: 'm3' })
    );
    expect(linksUpsert).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'm1' }));
    expect(linksUpsert).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'm3' }));
    expect(linksUpsert).not.toHaveBeenCalledWith(expect.objectContaining({ targetId: 'm4' }));
    expect(linksUpsert).not.toHaveBeenCalledWith(expect.objectContaining({ targetId: 'm10' }));
  });
});
