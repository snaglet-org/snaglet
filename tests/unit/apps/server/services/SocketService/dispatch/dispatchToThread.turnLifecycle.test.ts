/**
 * Dispatch-level agent-turn lifecycle: timeouts, failed turns, parallel-wave
 * draining, and stale-run teardown ownership.
 *
 * Uses the real ActiveRunTracker and abortStore (they are the state under
 * test) and mocks everything that would reach the DB, the network, or a model;
 * `createRunAgentTurn` is a scripted turn per test. Pins: a per-agent timeout
 * aborts the turn and the lock is held until it settles; timed-out or
 * reply-less turns are dropped for the rest of the dispatch; a parallel wave
 * drains siblings before a hard failure or Stop ends it; Stop is bounded even
 * when a turn ignores its abort; a force-released dispatch never tears down a
 * newer run on the reused session id.
 */

import { randomUUID } from 'crypto';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { sendToClient: jest.fn(), broadcastToChannel: jest.fn() },
}));

jest.mock('@server/services/AgentService', () => ({
  agentService: { get: jest.fn().mockResolvedValue(null) },
}));

const mockSettingsRead = jest.fn();
jest.mock('@server/services/settings', () => ({
  settingsService: { read: (...a: unknown[]) => mockSettingsRead(...a) },
}));

const makeLogsProxy = (): unknown =>
  new Proxy(jest.fn(), {
    get: () => makeLogsProxy(),
    apply: () => undefined,
  });
jest.mock('@server/services/LogsService', () => ({ LogsService: makeLogsProxy() }));

jest.mock('@server/services/SocketService/constants', () => ({
  ...jest.requireActual('@server/services/SocketService/constants'),
  AGENT_ABORT_DRAIN_MS: 150,
}));

jest.mock('@server/services/SocketService/threadEvents', () => ({
  ...jest.requireActual('@server/services/SocketService/threadEvents'),
  emitThreadStartedEvent: jest.fn(async () => undefined),
  emitConversationEndedEvent: jest.fn(async () => undefined),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/midRunMessages', () => ({
  flushAbandonedSessionMessages: jest.fn(async () => []),
  persistStragglers: jest.fn(async () => undefined),
  finishSessionAndPersistStragglers: jest.fn(async () => undefined),
}));

jest.mock('@server/services/SocketService/persistRunErrorMessage', () => ({
  persistRunErrorMessage: jest.fn(async () => undefined),
}));

const mockClearPending = jest.fn();
jest.mock('@server/services/PendingAgentMessageService', () => ({
  pendingAgentMessages: { clearAgent: (...a: unknown[]) => mockClearPending(...a) },
}));

/** Fake ConversationBudget: finite wave limit, no spend limits. */
const MAX_WAVES = 3;
jest.mock('@server/services/SocketService/handlers/chatHandlers/buildConversationBudget', () => ({
  buildConversationBudget: jest.fn(async () => {
    let waves = 0;
    return {
      waveLimitReached: () => waves >= MAX_WAVES,
      exhaustedNonWave: () => false,
      nonWaveExhaustionKind: () => null,
      incrementWave: () => {
        waves += 1;
      },
      currentWave: () => waves,
      waveLimit: () => MAX_WAVES,
      seedSnapshot: () => ({ waves, totalOutputTokens: 0 }),
      recordAgentTurn: jest.fn(),
      summary: () => ({ totalOutputTokens: 0, waves, exhaustedReason: null }),
    };
  }),
}));

/** Every per-agent timeout's expiry hook that actually fired (wraps the real helper). */
const mockTimeoutFired: string[] = [];
jest.mock('@server/services/SocketService/dispatch/pausableAgentTimeout', () => {
  const actual = jest.requireActual('@server/services/SocketService/dispatch/pausableAgentTimeout');
  return {
    createPausableAgentTimeout: <T>(
      promise: Promise<T>,
      timeoutMs: number,
      label: string,
      onTimeout?: () => void
    ) =>
      actual.createPausableAgentTimeout(promise, timeoutMs, label, () => {
        mockTimeoutFired.push(label);
        onTimeout?.();
      }),
  };
});

type ScriptedTurn = (
  agentId: string,
  controller: AbortController,
  ctx: { deps: RunAgentTurnDeps; shared: RunAgentTurnSharedState }
) => Promise<void>;
let mockScriptedTurn: ScriptedTurn = async () => undefined;
jest.mock('@server/services/SocketService/handlers/chatPhases/runAgentTurn', () => ({
  createRunAgentTurn: jest.fn(
    (deps: RunAgentTurnDeps, shared: RunAgentTurnSharedState) =>
      (id: string, controller: AbortController): Promise<void> =>
        mockScriptedTurn(id, controller, { deps, shared })
  ),
}));

import {
  dispatchToThreadInternal,
  type InternalDispatchDeps,
} from '@server/services/SocketService/dispatch/dispatchToThread';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import {
  abortThread,
  clearAgentAbortController,
  createAbortController,
  createAgentAbortController,
  listActiveAgentRuns,
} from '@server/services/SocketService/abortStore';
import { AgentTurnTimeoutAbort } from '@server/services/SocketService/dispatch/turnTimeoutAbort';
import { agentSettings } from '@server/services/settings/categories/agent';
import { emitThreadStartedEvent } from '@server/services/SocketService/threadEvents';

/** Per-agent timeout used by these tests (seconds → 60ms). */
const TIMEOUT_S = 0.06;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve once `signal` aborts. */
const onAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

function makeDeps(
  agentIds: string[],
  overrides: Partial<InternalDispatchDeps> = {}
): InternalDispatchDeps {
  const sessionId = `session-${randomUUID()}`;
  const threadId = `thread-${randomUUID()}`;
  return {
    session: {
      id: sessionId,
      agentId: 'user-1',
      threadId,
      participantAgentIds: agentIds,
      createdAt: Date.now(),
    },
    sessionId,
    threadName: 'Lifecycle Test Thread',
    isGroup: agentIds.length > 1,
    meta: { clientId: '' },
    message: 'hello',
    triggerMessageId: 'msg-1',
    participantAgentIds: agentIds,
    agentNameMap: new Map(agentIds.map((id) => [id, id])),
    agentRoleMap: new Map(),
    resolveParticipantId: (id: string) => (agentIds.includes(id) ? id : undefined),
    isParticipantMention: (id: string) => agentIds.includes(id),
    mentions: {
      mentionedAgentIds: [],
      hasMentions: false,
      rawMentions: [],
    } as unknown as InternalDispatchDeps['mentions'],
    dispatchSet: new Set(agentIds),
    dispatchRouting: 'all',
    effectiveParallelDispatch: false,
    thread: { id: threadId, dispatchMode: 'all' } as InternalDispatchDeps['thread'],
    threadRuntimeConfig: null,
    ...overrides,
  };
}

/** Acquire the run lock the way the socket/tool entry points do, then dispatch. */
async function runDispatch(deps: InternalDispatchDeps) {
  expect(activeRunTracker.startSession(deps.sessionId, deps.session.threadId)).toBe(true);
  return dispatchToThreadInternal(deps);
}

/** Mirrors a real reply that a peer re-summoned (keeps the agent eligible). */
function replyAndStayWoken(
  agentId: string,
  ctx: { deps: RunAgentTurnDeps; shared: RunAgentTurnSharedState }
): void {
  ctx.shared.currentWaveResults.push({ agentId, passed: false, replyLength: 3 });
  ctx.deps.wokenByMention.add(agentId);
}

describe('dispatchToThreadInternal — agent turn lifecycle', () => {
  let events: string[];
  let finishSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    events = [];
    mockSettingsRead.mockImplementation(async (def: unknown) =>
      def === agentSettings.timeoutSeconds ? TIMEOUT_S : 5
    );
    const realFinish = activeRunTracker.finishSession.bind(activeRunTracker);
    finishSpy = jest
      .spyOn(activeRunTracker, 'finishSession')
      .mockImplementation((sessionId: string, runToken?: number) => {
        events.push('lock-released');
        return realFinish(sessionId, runToken);
      });
  });

  afterEach(() => {
    finishSpy.mockRestore();
  });

  it('aborts a timed-out turn with a timeout reason and releases the lock only after it settles', async () => {
    let seenController: AbortController | null = null;
    mockScriptedTurn = async (_id, controller) => {
      seenController = controller;
      // A tool that honors its signal but takes a moment to unwind.
      await onAbort(controller.signal);
      await sleep(30);
      events.push('turn-settled');
    };

    const deps = makeDeps(['agent-a']);
    await runDispatch(deps);

    expect(seenController).not.toBeNull();
    const signal = (seenController as unknown as AbortController).signal;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(AgentTurnTimeoutAbort);
    expect(events).toEqual(['turn-settled', 'lock-released']);
    expect(activeRunTracker.hasActiveSession(deps.sessionId)).toBe(false);
    expect(listActiveAgentRuns(deps.session.threadId)).toEqual([]);
  });

  it('bounds the wait for a turn that ignores its abort, and cleans up its dispatch-local state', async () => {
    let release: () => void = () => undefined;
    mockScriptedTurn = async (id, _controller, ctx) => {
      ctx.shared.runningAgents.add(id);
      // Ignores the abort entirely until the test lets it go.
      await new Promise<void>((r) => (release = r));
      events.push('turn-settled');
    };

    const deps = makeDeps(['agent-a']);
    const started = Date.now();
    await runDispatch(deps);

    // Released after timeout (60ms) + drain bound (150ms), not after the turn.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events).toEqual(['lock-released']);
    expect(mockClearPending).toHaveBeenCalledWith(deps.session.threadId, 'agent-a');
    release();
  });

  it('retires a timed-out agent for the rest of a group dispatch instead of re-dispatching it every wave', async () => {
    const calls: string[] = [];
    mockScriptedTurn = async (id, controller, ctx) => {
      calls.push(id);
      if (id === 'agent-slow') {
        await onAbort(controller.signal);
        return;
      }
      replyAndStayWoken(id, ctx);
    };

    const result = await runDispatch(makeDeps(['agent-slow', 'agent-ok']));

    expect(calls.filter((id) => id === 'agent-slow')).toHaveLength(1);
    expect(calls.filter((id) => id === 'agent-ok')).toHaveLength(MAX_WAVES);
    expect(result.ok).toBe(true);
  });

  it('retires an agent whose turn ended without a reply (no model / terminal failure)', async () => {
    const calls: string[] = [];
    mockScriptedTurn = async (id, _controller, ctx) => {
      calls.push(id);
      if (id === 'agent-broken') return; // early return, no wave result
      replyAndStayWoken(id, ctx);
    };

    await runDispatch(makeDeps(['agent-broken', 'agent-ok']));

    expect(calls.filter((id) => id === 'agent-broken')).toHaveLength(1);
    expect(calls.filter((id) => id === 'agent-ok')).toHaveLength(MAX_WAVES);
  });

  it('parallel wave: a hard failure waits for sibling turns before ending the dispatch', async () => {
    mockScriptedTurn = async (id) => {
      if (id === 'agent-crash') throw new Error('context assembly exploded');
      await sleep(40);
      events.push(`settled:${id}`);
    };

    const deps = makeDeps(['agent-crash', 'agent-sibling'], { effectiveParallelDispatch: true });
    await expect(runDispatch(deps)).rejects.toThrow('context assembly exploded');

    expect(events).toEqual(['settled:agent-sibling', 'lock-released']);
  });

  it('parallel wave: a Stop drains in-flight turns before releasing the lock', async () => {
    mockScriptedTurn = async (id, controller) => {
      if (id === 'agent-a') {
        // Simulate the user pressing Stop mid-wave.
        setTimeout(() => abortThread(deps.session.threadId), 5);
      }
      await onAbort(controller.signal);
      await sleep(25);
      events.push(`settled:${id}`);
    };

    const deps = makeDeps(['agent-a', 'agent-b'], { effectiveParallelDispatch: true });
    const result = await runDispatch(deps);

    expect(result.ok && result.reason).toBe('cancelled');
    expect(events.slice(-1)).toEqual(['lock-released']);
    expect(events).toEqual(
      expect.arrayContaining(['settled:agent-a', 'settled:agent-b', 'lock-released'])
    );
  });

  describe('Stop with a turn that ignores its abort', () => {
    /** Long enough that only the drain bound (150ms here) can explain a fast release. */
    const LONG_TIMEOUT_S = 30;

    beforeEach(() => {
      mockSettingsRead.mockImplementation(async (def: unknown) =>
        def === agentSettings.timeoutSeconds ? LONG_TIMEOUT_S : 5
      );
    });

    /** A turn that never checks its signal: only the test can end it. */
    function ignoreAbortUntilReleased(releases: Array<() => void>): ScriptedTurn {
      return async (id, _controller, ctx) => {
        ctx.shared.runningAgents.add(id);
        await new Promise<void>((resolve) => releases.push(resolve));
        events.push(`settled:${id}`);
      };
    }

    it('sequential: releases the lock within the drain bound, not at the per-agent timeout', async () => {
      const releases: Array<() => void> = [];
      mockScriptedTurn = ignoreAbortUntilReleased(releases);
      const deps = makeDeps(['agent-a']);
      setTimeout(() => abortThread(deps.session.threadId), 20);

      const started = Date.now();
      const result = await runDispatch(deps);

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.ok && result.reason).toBe('cancelled');
      expect(events).toEqual(['lock-released']);
      expect(mockClearPending).toHaveBeenCalledWith(deps.session.threadId, 'agent-a');
      releases.forEach((release) => release());
    });

    it('parallel: wakes on Stop while every turn ignores it, and releases within the drain bound', async () => {
      const releases: Array<() => void> = [];
      mockScriptedTurn = ignoreAbortUntilReleased(releases);
      const deps = makeDeps(['agent-a', 'agent-b'], { effectiveParallelDispatch: true });
      setTimeout(() => abortThread(deps.session.threadId), 20);

      const started = Date.now();
      const result = await runDispatch(deps);

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.ok && result.reason).toBe('cancelled');
      expect(events).toEqual(['lock-released']);
      releases.forEach((release) => release());
    });

    it('disarms the abandoned turn’s per-agent timeout instead of leaving it armed', async () => {
      mockSettingsRead.mockImplementation(async (def: unknown) =>
        def === agentSettings.timeoutSeconds ? 0.4 : 5
      );
      mockTimeoutFired.length = 0;
      const releases: Array<() => void> = [];
      mockScriptedTurn = ignoreAbortUntilReleased(releases);
      const deps = makeDeps(['agent-a']);
      setTimeout(() => abortThread(deps.session.threadId), 20);

      await runDispatch(deps);
      // Past the 400ms timeout: an armed timer would have fired by now.
      await sleep(500);

      expect(mockTimeoutFired).toEqual([]);
      releases.forEach((release) => release());
    });

    it('leaves the thread-wide pending queue alone when a newer turn took the agent slot during the drain', async () => {
      const releases: Array<() => void> = [];
      mockScriptedTurn = ignoreAbortUntilReleased(releases);
      const deps = makeDeps(['agent-a']);
      const newerParent = new AbortController();
      let newerTurn: AbortController | null = null;
      setTimeout(() => abortThread(deps.session.threadId), 20);
      // Mid-drain (drain bound is 150ms): a newer run's turn registers for the agent.
      setTimeout(() => {
        newerTurn = createAgentAbortController(
          'session-newer',
          deps.session.threadId,
          'agent-a',
          newerParent.signal
        );
      }, 60);

      await runDispatch(deps);

      expect(newerTurn).not.toBeNull();
      expect(mockClearPending).not.toHaveBeenCalledWith(deps.session.threadId, 'agent-a');
      expect(listActiveAgentRuns(deps.session.threadId)).toEqual([
        { agentId: 'agent-a', sessionId: 'session-newer' },
      ]);
      clearAgentAbortController(
        deps.session.threadId,
        'agent-a',
        newerTurn as unknown as AbortController
      );
      releases.forEach((release) => release());
    });

    it('a turn that does honor Stop still settles before the lock is released', async () => {
      mockScriptedTurn = async (id, controller) => {
        await onAbort(controller.signal);
        await sleep(20);
        events.push(`settled:${id}`);
      };
      const deps = makeDeps(['agent-a']);
      setTimeout(() => abortThread(deps.session.threadId), 10);

      await runDispatch(deps);

      expect(events).toEqual(['settled:agent-a', 'lock-released']);
    });
  });

  it('a dispatch whose lock was reaped does not tear down a newer run on the same session id', async () => {
    const deps = makeDeps(['agent-a']);
    let newRunController: AbortController | null = null;
    mockScriptedTurn = async (id, _controller, ctx) => {
      // Reaper: abort + force-release the (supposedly wedged) run…
      abortThread(deps.session.threadId);
      activeRunTracker.finishSession(deps.sessionId);
      // …and the user's next send starts a new run on the reused session id.
      expect(activeRunTracker.startSession(deps.sessionId, deps.session.threadId)).toBe(true);
      activeRunTracker.enqueueMessageForThread(
        deps.session.threadId,
        'msg-new',
        'next',
        undefined,
        true
      );
      newRunController = createAbortController(deps.sessionId, deps.session.threadId);
      replyAndStayWoken(id, ctx);
    };

    await runDispatch(deps);

    // The newer run still holds the lock, its queue, and a stoppable controller.
    expect(activeRunTracker.getActiveSessionForThread(deps.session.threadId)).toBe(deps.sessionId);
    expect(activeRunTracker.drainMessages(deps.sessionId).map((m) => m.id)).toEqual(['msg-new']);
    expect(abortThread(deps.session.threadId)).toBe(1);
    expect((newRunController as unknown as AbortController).signal.aborted).toBe(true);
    activeRunTracker.finishSession(deps.sessionId);
  });

  it('a DM / home thread names no routing mode and flags the turn as a DM', async () => {
    let seen: RunAgentTurnDeps | null = null;
    mockScriptedTurn = async (_id, _controller, ctx) => {
      seen = ctx.deps;
    };
    const dm = makeDeps(['agent-a'], {
      thread: { dispatchMode: 'mentioned', kind: 'dm' } as InternalDispatchDeps['thread'],
    });
    await runDispatch(dm);
    expect(jest.mocked(emitThreadStartedEvent).mock.calls.at(-1)![1].dispatchMode).toBeNull();
    expect((seen as RunAgentTurnDeps | null)?.isDm).toBe(true);

    const chat = makeDeps(['agent-a']);
    await runDispatch(chat);
    expect(jest.mocked(emitThreadStartedEvent).mock.calls.at(-1)![1].dispatchMode).toBe('all');
    expect((seen as RunAgentTurnDeps | null)?.isDm).toBe(false);
  });
});
