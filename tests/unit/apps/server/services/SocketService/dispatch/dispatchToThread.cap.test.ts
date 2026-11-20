/**
 * Dispatch-level wave-cap test: when the wave loop hits the ConversationBudget
 * wave limit, `dispatchToThreadInternal` returns
 * `{ok: true, capHit: true, reason: 'cap_hit'}` (the budget math itself is
 * covered by ConversationBudget.test.ts and buildConversationBudget.test.ts).
 * A persisted `thread.maxAgentDispatches` value (0, null, or a positive
 * number) does not affect the soft/hard dispatch thresholds, which always come
 * from the settings registry; the wave cap already bounds every agent.
 *
 * Every direct import of `dispatchToThread.ts` is mocked so only the wave-loop
 * control flow runs; `createRunAgentTurn` is a no-op so each wave completes
 * instantly.
 */

import { randomUUID } from 'crypto';

// Direct imports of dispatchToThread.ts (mock each)

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { sendToClient: jest.fn(), broadcastToChannel: jest.fn() },
}));

jest.mock('@server/services/AgentService', () => ({
  agentService: { get: jest.fn().mockResolvedValue(null) },
}));

jest.mock('@server/services/settings', () => ({
  settingsService: {
    // Used for dispatch soft threshold (5) and agent timeout seconds (5 → 5s).
    read: jest.fn().mockResolvedValue(5),
  },
}));

jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    add: jest.fn(),
    finish: jest.fn(),
    // finishSession drains-and-returns any messages that raced the run-end
    // flush; the dispatch finally reads its .length, so return an empty array.
    finishSession: jest.fn().mockReturnValue([]),
    // takeSkippedSeeds hands back tool wakes skipped during the run so the
    // finally can re-dispatch them; no seeds skipped in this cap test.
    takeSkippedSeeds: jest.fn().mockReturnValue([]),
    snapshot: jest.fn().mockReturnValue({ activeThreadCount: 0, activeRunCount: 0 }),
    // No tracker session in this test → no run token → tokenless teardown.
    sessionRunToken: jest.fn().mockReturnValue(undefined),
  },
}));

const makeLogsProxy = (): unknown =>
  new Proxy(jest.fn(), {
    get: () => makeLogsProxy(),
    apply: () => undefined,
  });
jest.mock('@server/services/LogsService', () => ({ LogsService: makeLogsProxy() }));

/** Stateful fake ConversationBudget: finite wave limit, no spend limits. */
// Mutable so individual tests can pin a specific `maxWaves` (the
// round-robin wave-cap cases below set it to 1 and 2). The mock factory reads
// it lazily at dispatch time, so a per-test assignment in the test body takes
// effect for that dispatch.
let FAKE_MAX_WAVES = 3;
const makeFakeBudget = (maxWaves: number) => {
  let waves = 0;
  return {
    canContinue: () => waves < maxWaves,
    waveLimitReached: () => waves >= maxWaves,
    exhaustedNonWave: () => false,
    incrementWave: () => {
      waves += 1;
    },
    currentWave: () => waves,
    waveLimit: () => maxWaves,
    seedSnapshot: () => ({ waves, totalOutputTokens: 0 }),
    recordAgentTurn: jest.fn(),
    summary: () => ({
      totalOutputTokens: 0,
      waves,
      exhaustedReason: waves >= maxWaves ? `max waves (${maxWaves})` : null,
    }),
  };
};

jest.mock('@server/services/SocketService/handlers/chatHandlers/buildConversationBudget', () => ({
  buildConversationBudget: jest.fn(async () => makeFakeBudget(FAKE_MAX_WAVES)),
}));

const DEFAULT_FAKE_MAX_WAVES = FAKE_MAX_WAVES;

/**
 * Mirrors a real turn that replied and was re-summoned: records a non-passed
 * wave result and marks itself woken so the next wave re-dispatches it. (A
 * turn that records no wave result is a failed turn and is dropped for the
 * rest of the dispatch, so a bare no-op mock would never reach the cap.)
 */
function simulateRewokenReply(
  deps: { wokenByMention: Set<string> },
  shared: { currentWaveResults: Array<{ agentId: string; passed: boolean; replyLength: number }> },
  agentId: string
): void {
  shared.currentWaveResults.push({ agentId, passed: false, replyLength: 1 });
  deps.wokenByMention.add(agentId);
}

jest.mock('@server/services/SocketService/handlers/chatPhases/runAgentTurn', () => ({
  createRunAgentTurn: jest.fn(
    (
      deps: Parameters<typeof simulateRewokenReply>[0],
      shared: Parameters<typeof simulateRewokenReply>[1]
    ) =>
      (id: string): Promise<void> => {
        simulateRewokenReply(deps, shared, id);
        return Promise.resolve();
      }
  ),
}));

jest.mock('@server/services/SocketService/abortStore', () => ({
  createAbortController: jest.fn(() => new AbortController()),
  clearAbortController: jest.fn(),
  createAgentAbortController: jest.fn(() => new AbortController()),
  clearAgentAbortController: jest.fn(),
  isAgentTurnSuperseded: jest.fn(() => false),
}));

// Module under test
import {
  dispatchToThreadInternal,
  type InternalDispatchDeps,
} from '@server/services/SocketService/dispatch/dispatchToThread';
import { createRunAgentTurn } from '@server/services/SocketService/handlers/chatPhases/runAgentTurn';

function makeDeps(overrides: Partial<InternalDispatchDeps> = {}): InternalDispatchDeps {
  const sessionId = `test-${randomUUID()}`;
  return {
    session: {
      id: sessionId,
      agentId: 'user-1',
      threadId: 'thread-cap-test',
      participantAgentIds: ['agent-a'],
      createdAt: Date.now(),
    },
    sessionId,
    threadName: 'Cap Test Thread',
    isGroup: true,
    meta: { clientId: '' },
    message: '@agent-a hello',
    triggerMessageId: 'msg-1',
    participantAgentIds: ['agent-a'],
    agentNameMap: new Map([['agent-a', 'AgentA']]),
    agentRoleMap: new Map(),
    resolveParticipantId: (id: string) => (id === 'agent-a' ? 'agent-a' : undefined),
    isParticipantMention: (id: string) => id === 'agent-a',
    mentions: {
      mentionedAgentIds: ['agent-a'],
      hasMentions: true,
      rawMentions: ['agent-a'],
    } as InternalDispatchDeps['mentions'],
    dispatchSet: new Set(['agent-a']),
    dispatchRouting: 'all',
    effectiveParallelDispatch: false,
    thread: { id: 'thread-cap-test', dispatchMode: 'all' } as InternalDispatchDeps['thread'],
    threadRuntimeConfig: null,
    ...overrides,
  };
}

describe('dispatchToThreadInternal — cap behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    FAKE_MAX_WAVES = DEFAULT_FAKE_MAX_WAVES;
  });

  it('a null per-thread dispatch limit uses the settings default (per-thread override removed)', async () => {
    await dispatchToThreadInternal(
      makeDeps({
        thread: {
          dispatchMode: 'all',
          maxAgentDispatches: null,
        },
      })
    );

    const mockedCreateRunAgentTurn = jest.mocked(createRunAgentTurn);
    expect(mockedCreateRunAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockedCreateRunAgentTurn.mock.calls[0]?.[0]).toMatchObject({
      softDispatchThreshold: 5,
      hardDispatchCeiling: 10,
      HARD_DISPATCH_CEILING: 10,
    });
  });

  it('a persisted 0 per-thread value is ignored — the settings default applies', async () => {
    // Existing threads with a value set must not break: a persisted 0 neither
    // errors nor stops dispatch; it is simply not read.
    await dispatchToThreadInternal(
      makeDeps({
        thread: {
          dispatchMode: 'all',
          maxAgentDispatches: 0,
        },
      })
    );

    const mockedCreateRunAgentTurn = jest.mocked(createRunAgentTurn);
    expect(mockedCreateRunAgentTurn.mock.calls[0]?.[0]).toMatchObject({
      softDispatchThreshold: 5,
      hardDispatchCeiling: 10,
      HARD_DISPATCH_CEILING: 10,
    });
  });

  it('a persisted positive per-thread dispatch value is ignored — the settings default applies', async () => {
    await dispatchToThreadInternal(
      makeDeps({
        thread: {
          dispatchMode: 'all',
          maxAgentDispatches: 3,
        },
      })
    );

    const mockedCreateRunAgentTurn = jest.mocked(createRunAgentTurn);
    expect(mockedCreateRunAgentTurn.mock.calls[0]?.[0]).toMatchObject({
      softDispatchThreshold: 5,
      hardDispatchCeiling: 10,
    });
  });

  it('returns capHit=true when the wave loop reaches the budget wave limit', async () => {
    const result = await dispatchToThreadInternal(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capHit).toBe(true);
    expect(result.reason).toBe('cap_hit');
  });

  // A single agent re-woken every wave (via wokenByMention) advances exactly
  // one wave per turn, so maxWaves=N means "exactly N turns, then the cap" and
  // the real `maxWaves` cap, not the per-agent dispatch ceiling, ends the loop.
  // An integration-level mention relay can't pin this: mid-wave mention joins
  // collapse a two-agent relay into one wave, so it hits the per-agent ceiling.
  it('(a) maxWaves=2 runs exactly two waves (turns), then stops with the wave cap', async () => {
    FAKE_MAX_WAVES = 2;
    const result = await dispatchToThreadInternal(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capHit).toBe(true);
    expect(result.reason).toBe('cap_hit');
    expect(result.stopReason).toBe('wave-cap');
    // One agent dispatch per wave → exactly two turns before the cap.
    expect(result.wakeCount).toBe(2);
  });

  it('(a2) maxWaves=1 runs exactly one wave (turn), then stops at the cap', async () => {
    FAKE_MAX_WAVES = 1;
    const result = await dispatchToThreadInternal(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capHit).toBe(true);
    expect(result.reason).toBe('cap_hit');
    expect(result.stopReason).toBe('wave-cap');
    // "One wave" really means one turn: the single agent fires once, then the
    // loop-top check (waveCount 1 ≥ 1) stops before a second turn.
    expect(result.wakeCount).toBe(1);
  });

  it('reports wakeCount > 0 after cap is reached', async () => {
    const result = await dispatchToThreadInternal(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // wakeCount should equal the number of waves dispatched before the cap,
    // which is FAKE_MAX_WAVES (one agent dispatch per wave in this test).
    expect(result.wakeCount).toBeGreaterThan(0);
    expect(result.wakeCount).toBeLessThanOrEqual(FAKE_MAX_WAVES);
  });
});
