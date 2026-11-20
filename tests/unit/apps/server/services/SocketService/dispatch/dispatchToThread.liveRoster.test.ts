/**
 * The dispatch wave loop and the real mention routing, with a roster that
 * changes during the run. An agent's turn adds or removes a teammate (what the
 * thread tool does), then speaks through the reply seam finalReply.ts and
 * turnLoop.ts use (routeReplyMentions: re-read the roster, skip a speaker that
 * left, route). A mention of a just-added agent must wake it in the same run; a
 * mention of a just-removed one must not; a speaker that left wakes nobody.
 * Turns are fakes (createRunAgentTurn is mocked); dispatchToThreadInternal,
 * liveRoster, routeReplyMentions, routeSpokenMentions, mentionRouter and
 * MentionParser are real.
 */

import { randomUUID } from 'crypto';

const mockListByThread = jest.fn();
const mockBroadcast = jest.fn();

jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: jest.fn(),
    broadcastToChannel: (...args: unknown[]) => mockBroadcast(...args),
  },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: (...args: unknown[]) => mockListByThread(...args) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    findByIds: jest.fn(async (ids: string[]) => ids.map((id) => ({ id, archived: false }))),
  },
}));
const NAMES: Record<string, string> = {
  'agent-lead': 'Lead',
  'agent-nova': 'Nova',
  'agent-orion': 'Orion',
};
jest.mock('@server/services/AgentService', () => ({
  agentService: {
    get: jest.fn(async (id: string) => (NAMES[id] ? { id, name: NAMES[id] } : undefined)),
  },
}));
jest.mock('@server/services/settings', () => ({
  settingsService: { read: jest.fn().mockResolvedValue(5) },
}));
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    add: jest.fn(),
    finish: jest.fn(),
    finishSession: jest.fn().mockReturnValue([]),
    takeSkippedSeeds: jest.fn().mockReturnValue([]),
    snapshot: jest.fn().mockReturnValue({ activeThreadCount: 0, activeRunCount: 0 }),
    sessionRunToken: jest.fn().mockReturnValue(undefined),
    reserveHandoff: jest.fn(),
  },
}));
const makeLogsProxy = (): unknown =>
  new Proxy(jest.fn(), {
    get: () => makeLogsProxy(),
    apply: () => undefined,
  });
jest.mock('@server/services/LogsService', () => ({ LogsService: makeLogsProxy() }));

const makeBudget = () => {
  let waves = 0;
  return {
    canContinue: () => waves < 6,
    waveLimitReached: () => waves >= 6,
    exhaustedNonWave: () => false,
    nonWaveExhaustionKind: () => null,
    incrementWave: () => {
      waves += 1;
    },
    currentWave: () => waves,
    waveLimit: () => 6,
    seedSnapshot: () => ({ waves, totalOutputTokens: 0 }),
    recordAgentTurn: jest.fn(),
    summary: () => ({ totalOutputTokens: 0, waves, exhaustedReason: null }),
  };
};
jest.mock('@server/services/SocketService/handlers/chatHandlers/buildConversationBudget', () => ({
  buildConversationBudget: jest.fn(async () => makeBudget()),
}));
jest.mock('@server/services/SocketService/abortStore', () => ({
  createAbortController: jest.fn(() => new AbortController()),
  clearAbortController: jest.fn(),
  createAgentAbortController: jest.fn(() => new AbortController()),
  clearAgentAbortController: jest.fn(),
  isAgentTurnSuperseded: jest.fn(() => false),
}));

type Turn = (deps: RunAgentTurnDeps, shared: RunAgentTurnSharedState) => Promise<void>;
const turns = new Map<string, Turn>();
const ran: string[] = [];
jest.mock('@server/services/SocketService/handlers/chatPhases/runAgentTurn', () => ({
  createRunAgentTurn: jest.fn(
    (deps: RunAgentTurnDeps, shared: RunAgentTurnSharedState) =>
      async (id: string): Promise<void> => {
        ran.push(id);
        const turn = turns.get(id);
        if (turn) await turn(deps, shared);
        else shared.currentWaveResults.push({ agentId: id, passed: false, replyLength: 1 });
      }
  ),
}));

import {
  dispatchToThreadInternal,
  type InternalDispatchDeps,
} from '@server/services/SocketService/dispatch/dispatchToThread';
import {
  markThreadRosterChanged,
  threadRosterVersion,
} from '@server/services/SocketService/dispatch/rosterVersion';
import { routeReplyMentions } from '@server/services/SocketService/handlers/chatPhases/routeReplyMentions';
import { createRunAgentTurn } from '@server/services/SocketService/handlers/chatPhases/runAgentTurn';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const LEAD = 'agent-lead';
const NOVA = 'agent-nova';
const ORION = 'agent-orion';
const row = (agentId: string) => ({ id: `tp-${agentId}`, kind: 'agent', agentId });

let threadId = '';

/** A turn that changes the roster, then speaks `content` through the reply seam. */
function speaksAfter(
  change: string[] | null,
  content: string,
  fanOut = jest.fn(),
  speaker = LEAD
): Turn {
  return async (deps, shared) => {
    if (change) {
      mockListByThread.mockResolvedValue(change.map(row));
      markThreadRosterChanged(threadId);
    }
    await routeReplyMentions({
      deps,
      shared,
      agent: { id: speaker, name: NAMES[speaker] } as never,
      runtimeAgent: { id: speaker, name: NAMES[speaker], modelId: 'm' } as never,
      replyAgentId: speaker,
      content,
      fanOutAllModeMidRunMessage: fanOut,
      logContext: 'final reply',
    });
    shared.currentWaveResults.push({ agentId: speaker, passed: false, replyLength: 1 });
  };
}

function makeDeps(opts: {
  ids: string[];
  routing: 'all' | 'mentioned';
  names?: Array<[string, string]>;
  dispatch?: string[];
  rosterVersion?: number;
}): InternalDispatchDeps {
  const isGroup = opts.ids.length > 1;
  const names = new Map(opts.names ?? (isGroup ? opts.ids.map((id) => [id, NAMES[id]!]) : []));
  const sessionId = `test-${randomUUID()}`;
  return {
    session: {
      id: sessionId,
      agentId: 'user-1',
      threadId,
      participantAgentIds: opts.ids,
      createdAt: Date.now(),
    },
    sessionId,
    threadName: 'Pricing review',
    isGroup,
    meta: { clientId: '' },
    message: '@Lead what does Nova think?',
    triggerMessageId: 'msg-1',
    participantAgentIds: [...opts.ids],
    agentNameMap: names,
    agentRoleMap: new Map(),
    resolveParticipantId: (id: string) => opts.ids.find((p) => p === id),
    isParticipantMention: (id: string) => opts.ids.includes(id),
    mentions: {
      mentionedAgentIds: [LEAD],
      hasMentions: true,
      rawMentions: ['Lead'],
    } as InternalDispatchDeps['mentions'],
    dispatchSet: new Set(opts.dispatch ?? [LEAD]),
    ...(opts.rosterVersion !== undefined ? { rosterVersion: opts.rosterVersion } : {}),
    dispatchRouting: opts.routing,
    effectiveParallelDispatch: isGroup,
    thread: { dispatchMode: opts.routing, kind: 'chat' },
    threadRuntimeConfig: null,
  };
}

function mentionSkipped(agentId: string): boolean {
  return mockBroadcast.mock.calls.some(
    ([, msg]) =>
      (msg as { type?: string }).type === 'chat:mention-skipped' &&
      (msg as { payload: { mentionedAgentId: string } }).payload.mentionedAgentId === agentId
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  turns.clear();
  ran.length = 0;
  threadId = `thread-${randomUUID()}`;
});

describe('dispatch — an agent added during the run', () => {
  it('in a group thread (mentioned), a mention in the reply wakes the new agent in the same run', async () => {
    turns.set(LEAD, speaksAfter([LEAD, ORION, NOVA], '@Nova what is your take on the pricing?'));

    await dispatchToThreadInternal(makeDeps({ ids: [LEAD, ORION], routing: 'mentioned' }));

    // Woken mid-wave, right after the reply. (An agent woken by a mention is
    // offered the next wave too, as before; a real one passes there.)
    expect(ran.slice(0, 2)).toEqual([LEAD, NOVA]);
    expect(ran).not.toContain(ORION);
    expect(mentionSkipped(NOVA)).toBe(false);
  });

  it('in a one-agent thread, the reply mention makes it a group and wakes the new agent', async () => {
    turns.set(LEAD, speaksAfter([LEAD, NOVA], '@Nova what is your take on the pricing?'));

    await dispatchToThreadInternal(makeDeps({ ids: [LEAD], routing: 'mentioned' }));

    expect(ran).toEqual([LEAD, NOVA]);
  });

  it('the new agent can answer the one who brought it in', async () => {
    turns.set(LEAD, speaksAfter([LEAD, NOVA], '@Nova what is your take on the pricing?'));
    let leadTurns = 0;
    const lead = turns.get(LEAD)!;
    turns.set(LEAD, async (deps, shared) => {
      leadTurns += 1;
      if (leadTurns === 1) return lead(deps, shared);
      shared.currentWaveResults.push({ agentId: LEAD, passed: false, replyLength: 1 });
    });
    turns.set(NOVA, async (deps, shared) => {
      await routeReplyMentions({
        deps,
        shared,
        agent: { id: NOVA, name: 'Nova' } as never,
        runtimeAgent: { id: NOVA, name: 'Nova', modelId: 'm' } as never,
        replyAgentId: NOVA,
        content: '@Lead keep the price, drop the trial.',
        fanOutAllModeMidRunMessage: jest.fn(),
        logContext: 'final reply',
      });
      shared.currentWaveResults.push({ agentId: NOVA, passed: false, replyLength: 1 });
    });

    await dispatchToThreadInternal(makeDeps({ ids: [LEAD], routing: 'mentioned' }));

    expect(ran).toEqual([LEAD, NOVA, LEAD]);
  });

  it('in broadcast (all) mode, the reply reaches the new agent like everyone else', async () => {
    const fanOut = jest.fn();
    turns.set(LEAD, speaksAfter([LEAD, ORION, NOVA], 'Nova is here now.', fanOut));

    await dispatchToThreadInternal(makeDeps({ ids: [LEAD, ORION], routing: 'all' }));

    const targets = fanOut.mock.calls[0]?.[1] as string[] | undefined;
    expect(targets).toEqual(expect.arrayContaining([ORION, NOVA]));
  });

  it('a run with no roster change never re-reads it', async () => {
    turns.set(LEAD, speaksAfter(null, '@Orion please check the numbers.'));

    await dispatchToThreadInternal(makeDeps({ ids: [LEAD, ORION], routing: 'mentioned' }));

    expect(ran.slice(0, 2)).toEqual([LEAD, ORION]);
    expect(mockListByThread).not.toHaveBeenCalled();
  });
});

describe('dispatch — an agent removed during the run', () => {
  it('is not woken by a mention, and the mention is reported as skipped', async () => {
    turns.set(LEAD, speaksAfter([LEAD, ORION], '@Nova thanks, that settles it.'));

    await dispatchToThreadInternal(makeDeps({ ids: [LEAD, ORION, NOVA], routing: 'mentioned' }));

    expect(ran).toEqual([LEAD]);
    expect(mentionSkipped(NOVA)).toBe(true);
  });

  it('gets no further wave even if it was already due one', async () => {
    // Nova is woken first (a mention), then removed before the next wave.
    turns.set(LEAD, async (deps, shared) => {
      await speaksAfter(null, '@Nova one question.')(deps, shared);
      mockListByThread.mockResolvedValue([row(LEAD), row(ORION)]);
      markThreadRosterChanged(threadId);
    });
    const deps = makeDeps({ ids: [LEAD, ORION, NOVA], routing: 'mentioned' });
    // Sequential, so Nova is queued for the next wave rather than started now.
    deps.effectiveParallelDispatch = false;

    await dispatchToThreadInternal(deps);

    expect(ran).toEqual([LEAD]);
  });
});

describe('dispatch — a speaker that leaves during its run', () => {
  it('its final reply wakes nobody, even with a mention (mentioned mode)', async () => {
    turns.set(NOVA, speaksAfter([LEAD, ORION], '@Lead over to you. Leaving.', jest.fn(), NOVA));

    await dispatchToThreadInternal(
      makeDeps({ ids: [LEAD, ORION, NOVA], routing: 'mentioned', dispatch: [NOVA] })
    );

    expect(ran).toEqual([NOVA]);
  });

  it('its final reply is not fanned out to the room (all mode)', async () => {
    const fanOut = jest.fn();
    turns.set(NOVA, speaksAfter([LEAD, ORION], 'Done, leaving.', fanOut, NOVA));

    await dispatchToThreadInternal(
      makeDeps({ ids: [LEAD, ORION, NOVA], routing: 'all', dispatch: [NOVA] })
    );

    expect(fanOut).not.toHaveBeenCalled();
    expect(ran).toEqual([NOVA]);
  });
});

describe('dispatch — a change between the roster read and the run start', () => {
  it('an agent removed in between gets no first-wave turn', async () => {
    // chatHandlers / buildDispatchDeps take the version just before reading.
    const versionAtRead = threadRosterVersion(threadId);
    // Nova is removed after the read, before the dispatch starts.
    mockListByThread.mockResolvedValue([row(LEAD), row(ORION)]);
    markThreadRosterChanged(threadId);

    await dispatchToThreadInternal(
      makeDeps({
        ids: [LEAD, ORION, NOVA],
        routing: 'all',
        dispatch: [LEAD, ORION, NOVA],
        rosterVersion: versionAtRead,
      })
    );

    expect(ran).toContain(LEAD);
    expect(ran).toContain(ORION);
    expect(ran).not.toContain(NOVA);
  });
});

describe('dispatch — the helper-thread flag the prompt reads', () => {
  it('is set for a subagent helper’s own thread and not otherwise', async () => {
    const helperDeps = makeDeps({ ids: [LEAD], routing: 'mentioned' });
    helperDeps.thread = {
      dispatchMode: 'mentioned',
      kind: 'chat',
      parentThreadId: 'thread-parent',
    };
    await dispatchToThreadInternal(helperDeps);
    await dispatchToThreadInternal(makeDeps({ ids: [LEAD], routing: 'mentioned' }));

    const calls = jest.mocked(createRunAgentTurn).mock.calls;
    expect(calls[0]?.[0].isHelperThread).toBe(true);
    expect(calls[1]?.[0].isHelperThread).toBe(false);
  });
});
