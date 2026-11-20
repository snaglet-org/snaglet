/**
 * summaryHalt — a broken compaction path stops the thread. When a summary
 * that was owed cannot be written, the run stops, the user is notified, a
 * persisted chat line explains the fix, and the thread refuses further work
 * until a working summary model is set. No fallback model is ever chosen.
 *
 * `threadEvents` is deliberately not mocked: the chat line must be a real
 * author-less `thread_event` row (Messages.createEvent) that the shared prefix
 * registry classifies as narration, as ContextWindowService does on replay.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createEvent = jest.fn();
const hasEventOfKind = jest.fn();
const agentFindById = jest.fn();
const broadcastToChannel = jest.fn();
const workSnapshot = jest.fn();
const notificationCreate = jest.fn();
const abortThread = jest.fn();
const resolveUtilityModel = jest.fn();

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    createEvent: (...a: unknown[]) => createEvent(...a),
    hasEventOfKind: (...a: unknown[]) => hasEventOfKind(...a),
  },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...a: unknown[]) => agentFindById(...a) },
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a) },
}));
jest.mock('@server/services/ActiveWorkRegistry', () => ({
  activeWorkRegistry: { snapshot: () => workSnapshot() },
}));
jest.mock('@server/services/NotificationService', () => ({
  notificationService: { create: (...a: unknown[]) => notificationCreate(...a) },
}));
jest.mock('@server/services/SocketService/abortStore', () => ({
  abortThread: (...a: unknown[]) => abortThread(...a),
}));
jest.mock('@server/services/summary/UtilityModelResolver', () => ({
  resolveUtilityModel: (...a: unknown[]) => resolveUtilityModel(...a),
}));

import { THREAD_EVENT_LINE_PREFIXES } from '@server/services/SocketService/threadEvents';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import {
  clearSummaryHaltIfRepaired,
  getSummaryHalt,
  haltOnSummaryFailure,
  isThreadSummaryHalted,
  raiseSummaryHalt,
  resetSummaryHaltsForTests,
  summaryHaltRefusal,
  type SummaryHalt,
} from '@server/services/summary/summaryHalt';
import type { GenerateSummaryOutcome } from '@server/services/SummaryService';

const THREAD = 'thread-halt-1';
const AGENT = 'agent-1';

/**
 * The shape this rule exists for: a model id that resolves fine from the
 * catalog and only dies at call time.
 */
const RETIRED_MODEL = 'claude-3-haiku-20240307';
const NOT_FOUND_404 = `status=404, type=not_found_error, model=${RETIRED_MODEL}`;

/** Every persisted thread_event content string, oldest first. */
function eventLines(): string[] {
  return createEvent.mock.calls.map((c) => (c[0] as { content: string }).content);
}

function onlyEvent(): { content: string; eventKind: string } {
  expect(createEvent).toHaveBeenCalledTimes(1);
  return createEvent.mock.calls[0]![0] as { content: string; eventKind: string };
}

const notConfigured = (): Promise<SummaryHalt> =>
  raiseSummaryHalt({
    threadId: THREAD,
    agentId: AGENT,
    agentName: 'Nova',
    kind: 'not-configured',
    reason: 'no-summary-model-configured',
    detail: 'no summary-model override is set for this agent',
  });

const modelFailing = (): Promise<SummaryHalt> =>
  raiseSummaryHalt({
    threadId: THREAD,
    agentId: AGENT,
    agentName: 'Nova',
    kind: 'model-failing',
    reason: 'generation-failed',
    detail: NOT_FOUND_404,
    providerId: 'anthropic',
    modelId: RETIRED_MODEL,
  });

beforeEach(() => {
  jest.clearAllMocks();
  resetSummaryHaltsForTests();
  pendingAgentMessages.resetForTests();
  createEvent.mockResolvedValue({ id: 'message-evt', createdAt: '2026-08-06T00:00:00.000Z' });
  hasEventOfKind.mockResolvedValue(false);
  agentFindById.mockResolvedValue({ id: AGENT, name: 'Nova' });
  workSnapshot.mockReturnValue([]);
  notificationCreate.mockResolvedValue({ id: 'notif-1' });
  abortThread.mockReturnValue(1);
  resolveUtilityModel.mockResolvedValue({ ok: false, reason: 'no-model-for-agent' });
});

describe('no summary model configured', () => {
  it('stops the run, notifies, persists a chat line, and blocks the thread', async () => {
    await notConfigured();

    // 1 — the run stops where it is.
    expect(abortThread).toHaveBeenCalledWith(THREAD);

    // 2 — a real notification, not a log line, carrying the thread to open.
    expect(notificationCreate).toHaveBeenCalledTimes(1);
    const notif = notificationCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(notif).toMatchObject({ type: 'run_failed', threadId: THREAD, agentId: AGENT });
    expect(String(notif.title)).toContain('No summary model');

    // 3 — a persisted author-less thread_event row (not a system-prompt block,
    // not an ephemeral tail).
    const event = onlyEvent();
    expect(event.eventKind).toBe('summary_model_unavailable');
    expect(event.content).toContain('not configured');
    expect(event.content).toContain('run stopped');
    expect(event.content).toContain('blocked until a summary model is set');
    expect(createEvent.mock.calls[0]![0]).toMatchObject({ threadId: THREAD });
    expect(broadcastToChannel).toHaveBeenCalledWith(
      THREAD,
      expect.objectContaining({
        payload: expect.objectContaining({ message_type: 'thread_event' }),
      })
    );

    // 4 — the thread is blocked.
    expect(isThreadSummaryHalted(THREAD)).toBe(true);
    expect(getSummaryHalt(THREAD)).toMatchObject({ kind: 'not-configured', modelId: null });
  });

  it('never names a substitute model — there is nothing to fall back to', async () => {
    const halt = await notConfigured();
    expect(halt.providerId).toBeNull();
    expect(halt.modelId).toBeNull();
    // Raising a halt must not consult the resolver looking for an alternative.
    expect(resolveUtilityModel).not.toHaveBeenCalled();
  });
});

describe('configured but failing (404 on a retired model)', () => {
  it('names the model and the provider error so the fix is obvious from the line', async () => {
    await modelFailing();

    expect(abortThread).toHaveBeenCalledWith(THREAD);
    expect(isThreadSummaryHalted(THREAD)).toBe(true);

    const event = onlyEvent();
    expect(event.eventKind).toBe('summary_model_unavailable');
    expect(event.content).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(event.content).toContain('status=404');
    expect(event.content).toContain('run stopped');

    const notif = notificationCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(notif.title)).toContain(`anthropic/${RETIRED_MODEL}`);
  });

  it('reads differently from the never-configured shape', async () => {
    await modelFailing();
    const failing = summaryHaltRefusal(getSummaryHalt(THREAD)!);

    resetSummaryHaltsForTests();
    jest.clearAllMocks();
    createEvent.mockResolvedValue({ id: 'message-evt', createdAt: '2026-08-06T00:00:00.000Z' });
    await notConfigured();
    const missing = summaryHaltRefusal(getSummaryHalt(THREAD)!);

    expect(failing).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(failing).toContain('is failing');
    expect(missing).toContain('no summary model is available');
    expect(missing).not.toContain(RETIRED_MODEL);
    // Both refuse a fallback in the same breath.
    for (const copy of [failing, missing]) {
      expect(copy).toContain('no fallback model will be chosen for you');
    }
  });
});

describe('the chat line', () => {
  it('is classified as narration by the shared thread-event prefix registry', async () => {
    await modelFailing();
    const [line] = eventLines();
    // The same scan ContextWindowService.isConversationalUserMessage runs on
    // replay. An unregistered prefix would make this line look like a human
    // turn and get it re-pinned above the compaction window.
    expect(THREAD_EVENT_LINE_PREFIXES.some((prefix) => line!.startsWith(prefix))).toBe(true);
  });

  it('survives replay as a persisted row rather than per-turn text', async () => {
    await modelFailing();
    // Persisted through the same author-less path as every other thread event:
    // role/author are set by MessageModel.createEvent, and the emitter passes
    // no system-prompt or ephemeral-tail payload of any kind.
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(Object.keys(createEvent.mock.calls[0]![0] as object).sort()).toEqual([
      'content',
      'eventKind',
      'threadId',
    ]);
  });
});

describe('the chat line names the actual cause', () => {
  const halt = (reason: string, model?: { providerId: string; modelId: string }) =>
    raiseSummaryHalt({
      threadId: THREAD,
      agentId: AGENT,
      agentName: 'Nova',
      kind: 'not-configured',
      reason,
      detail: 'why it stopped',
      providerId: model?.providerId ?? null,
      modelId: model?.modelId ?? null,
    });

  it.each([
    ['no-summary-model-configured', '[summary model not configured', 'a summary model is set'],
    ['no-model-for-agent', '[summary model not configured', 'a summary model is set'],
    [
      'no-credentials',
      '[summary model credential unavailable',
      'its credential is reconnected or another one is chosen',
    ],
    [
      'unsupported-provider',
      '[summary model provider unsupported',
      'a summary model on a supported provider is set',
    ],
    ['resolution-failed', '[summary model could not be resolved', 'a working summary model is set'],
  ])('%s', async (reason, start, until) => {
    await halt(reason);

    const line = onlyEvent().content;
    expect(line.startsWith(`${start} · Nova · why it stopped`)).toBe(true);
    expect(line.endsWith(`run stopped and this thread is blocked until ${until}]`)).toBe(true);
    // The detail follows the cause; the machine reason code is not repeated.
    expect(line).not.toContain(`${reason}:`);
    expect(THREAD_EVENT_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))).toBe(true);
  });

  it('names the model whose credential is missing when the halt knows it', async () => {
    await halt('no-credentials', { providerId: 'anthropic', modelId: 'test-model-a' });

    expect(onlyEvent().content).toContain(
      '[summary model credential unavailable · Nova · anthropic/test-model-a · why it stopped'
    );
  });

  it('keeps the failing-model line naming the model and its error', async () => {
    await modelFailing();

    expect(onlyEvent().content).toBe(
      `[summary model failed · Nova · anthropic/${RETIRED_MODEL} · ${NOT_FOUND_404}` +
        ' · run stopped and this thread is blocked until a working summary model is set]'
    );
  });
});

describe('idempotency', () => {
  it('narrates and notifies once while the same failure repeats', async () => {
    await modelFailing();
    await modelFailing();
    await modelFailing();

    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(notificationCreate).toHaveBeenCalledTimes(1);
    expect(abortThread).toHaveBeenCalledTimes(1);
  });

  it('re-narrates when a different model starts failing', async () => {
    await modelFailing();
    await raiseSummaryHalt({
      threadId: THREAD,
      agentId: 'agent-2',
      kind: 'model-failing',
      reason: 'generation-failed',
      detail: 'connection refused',
      providerId: 'ollama',
      modelId: 'qwen2.5:3b',
    });

    expect(createEvent).toHaveBeenCalledTimes(2);
    expect(eventLines()[1]).toContain('ollama/qwen2.5:3b');
    expect(getSummaryHalt(THREAD)).toMatchObject({ modelId: 'qwen2.5:3b' });
  });
});

describe('haltOnSummaryFailure — which outcomes are fatal', () => {
  const ctx = { threadId: THREAD, agentId: AGENT, agentName: 'Nova' };

  it.each([
    'not-due',
    'no-new-messages',
    'in-flight',
    'debounced',
    'daily-cap-reached',
    'quality-floor',
    'compact-conversations-disabled',
  ])('%s is a normal outcome and never halts the thread', async (reason) => {
    const outcome = { status: 'skipped', reason } as GenerateSummaryOutcome;
    await expect(haltOnSummaryFailure(outcome, ctx)).resolves.toBeNull();
    expect(isThreadSummaryHalted(THREAD)).toBe(false);
    expect(abortThread).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('a generated summary never halts', async () => {
    const outcome: GenerateSummaryOutcome = {
      status: 'generated',
      providerId: 'ollama',
      modelId: 'qwen2.5:3b',
      summaryId: 's1',
    };
    await expect(haltOnSummaryFailure(outcome, ctx)).resolves.toBeNull();
    expect(isThreadSummaryHalted(THREAD)).toBe(false);
  });

  it.each(['no-model-for-agent', 'unsupported-provider', 'no-credentials', 'resolution-failed'])(
    '%s halts as never-configured',
    async (reason) => {
      const outcome = { status: 'skipped', reason, detail: 'why' } as GenerateSummaryOutcome;
      await expect(haltOnSummaryFailure(outcome, ctx)).resolves.toMatchObject({
        kind: 'not-configured',
      });
      expect(isThreadSummaryHalted(THREAD)).toBe(true);
    }
  );

  it('a retryable resolution-failed (the database was unreachable) never halts', async () => {
    const outcome: GenerateSummaryOutcome = {
      status: 'skipped',
      reason: 'resolution-failed',
      detail: 'could not read credential cred-1: connection terminated',
      retryable: true,
    };
    await expect(haltOnSummaryFailure(outcome, ctx)).resolves.toBeNull();
    expect(isThreadSummaryHalted(THREAD)).toBe(false);
    expect(abortThread).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('a missing pinned credential halts with copy that names it, not "no summary model"', async () => {
    const detail =
      "the anthropic credential selected for this agent's summary model (cred-deleted) no " +
      'longer exists — it was deleted. Choose another credential for it';
    const outcome: GenerateSummaryOutcome = { status: 'skipped', reason: 'no-credentials', detail };
    const halt = await haltOnSummaryFailure(outcome, ctx);
    expect(halt).not.toBeNull();
    const refusal = summaryHaltRefusal(halt as SummaryHalt);
    expect(refusal).toContain('credential is unavailable');
    expect(refusal).toContain('cred-deleted');
    expect(refusal).not.toContain('no summary model is available');
    expect(notificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Summary model credential missing — run stopped' })
    );
    const line = onlyEvent().content;
    expect(line.startsWith('[summary model credential unavailable')).toBe(true);
    expect(line).not.toContain('not configured');
    expect(line).toContain('cred-deleted');
    expect(line).toContain('blocked until its credential is reconnected or another one is chosen');
  });

  it('generation-failed halts as model-failing and carries the model through', async () => {
    const outcome: GenerateSummaryOutcome = {
      status: 'skipped',
      reason: 'generation-failed',
      detail: NOT_FOUND_404,
      providerId: 'anthropic',
      modelId: RETIRED_MODEL,
    };
    await expect(haltOnSummaryFailure(outcome, ctx)).resolves.toMatchObject({
      kind: 'model-failing',
      providerId: 'anthropic',
      modelId: RETIRED_MODEL,
    });
    expect(eventLines()[0]).toContain(`anthropic/${RETIRED_MODEL}`);
  });
});

describe('unblocking', () => {
  it('an unhalted thread proceeds without touching the resolver', async () => {
    await expect(clearSummaryHaltIfRepaired(THREAD)).resolves.toBe(true);
    expect(resolveUtilityModel).not.toHaveBeenCalled();
  });

  it('stays blocked while resolution still produces nothing', async () => {
    await notConfigured();
    resolveUtilityModel.mockResolvedValue({ ok: false, reason: 'no-model-for-agent' });

    await expect(clearSummaryHaltIfRepaired(THREAD)).resolves.toBe(false);
    expect(isThreadSummaryHalted(THREAD)).toBe(true);
  });

  it('stays blocked when the same dead model resolves again', async () => {
    await modelFailing();
    resolveUtilityModel.mockResolvedValue({
      ok: true,
      model: { providerId: 'anthropic', modelId: RETIRED_MODEL },
    });

    // Resolvable is not the same as working. Re-resolving to the model that
    // just 404'd is not evidence of a repair, and treating it as one would be
    // exactly the silent degradation this rule forbids.
    await expect(clearSummaryHaltIfRepaired(THREAD)).resolves.toBe(false);
    expect(isThreadSummaryHalted(THREAD)).toBe(true);
  });

  it('unblocks when a working summary model is set, and says so in the thread', async () => {
    await modelFailing();
    createEvent.mockClear();
    resolveUtilityModel.mockResolvedValue({
      ok: true,
      model: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
    });

    await expect(clearSummaryHaltIfRepaired(THREAD)).resolves.toBe(true);
    expect(isThreadSummaryHalted(THREAD)).toBe(false);
    expect(getSummaryHalt(THREAD)).toBeNull();
    const restored = onlyEvent();
    expect(restored.content).toContain('restored');
    expect(restored.content).toContain('anthropic/claude-haiku-4-5');
    expect(THREAD_EVENT_LINE_PREFIXES.some((p) => restored.content.startsWith(p))).toBe(true);
  });

  it('unblocks a never-configured thread as soon as anything resolves', async () => {
    await notConfigured();
    resolveUtilityModel.mockResolvedValue({
      ok: true,
      model: { providerId: 'ollama', modelId: 'qwen2.5:3b' },
    });

    await expect(clearSummaryHaltIfRepaired(THREAD)).resolves.toBe(true);
    expect(isThreadSummaryHalted(THREAD)).toBe(false);
  });

  it('re-checks against the agent whose pass failed, not an arbitrary one', async () => {
    await notConfigured();
    await clearSummaryHaltIfRepaired(THREAD);
    expect(resolveUtilityModel).toHaveBeenCalledWith({
      purpose: 'thread-summary',
      threadId: THREAD,
      agentId: AGENT,
    });
  });
});

describe('failure of the halt machinery itself', () => {
  it('keeps the thread blocked when the notification cannot be created', async () => {
    notificationCreate.mockRejectedValue(new Error('notifications table is gone'));

    await expect(notConfigured()).resolves.toMatchObject({ kind: 'not-configured' });
    expect(isThreadSummaryHalted(THREAD)).toBe(true);
    // The chat line still lands — the block must never depend on a surface
    // that failed.
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps the thread blocked when the chat line cannot be persisted', async () => {
    createEvent.mockRejectedValue(new Error('database is on fire'));

    await expect(modelFailing()).resolves.toMatchObject({ kind: 'model-failing' });
    expect(isThreadSummaryHalted(THREAD)).toBe(true);
    expect(abortThread).toHaveBeenCalledWith(THREAD);
  });
});
