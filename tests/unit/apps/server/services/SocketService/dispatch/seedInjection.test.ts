/**
 * Mid-run delivery of tool-dispatch seeds (thread_send from an agent, or an
 * external MCP member) that land on a thread whose run lock is already held.
 *
 * Besides recording the seed for a post-run re-dispatch, dispatchToThread's
 * busy branch queues it into pendingAgentMessages for each running target. It
 * is drained at the next tool seam (as socket sends are) and struck from the
 * post-run backstop once every target saw it, so an agent is not re-woken into
 * a message it already talked past.
 *
 * Real: ActiveRunTracker, ActiveWorkRegistry, PendingAgentMessageService,
 * drainInjectablePeerMessages (formatInjected + decideMidRunInjection).
 * Mocked: thread lookup, buildDispatchDeps (routing inputs), sockets, logs.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/summary/summaryHalt', () => ({
  isThreadSummaryHalted: () => false,
  clearSummaryHaltIfRepaired: async () => true,
}));

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: async (id: string) => ({ id }) },
}));

interface FakeRouting {
  dispatchSet: string[];
  mentioned: string[];
}
let mockRouting: FakeRouting = { dispatchSet: [], mentioned: [] };
const PARTICIPANTS = ['agent-venus', 'agent-clio', 'agent-test-c'];
jest.mock('@server/services/SocketService/dispatch/buildDispatchDeps', () => ({
  buildDispatchDeps: async () => ({
    ok: true as const,
    deps: {
      sessionId: `tool-dispatch-${Math.random()}`,
      dispatchSet: new Set(mockRouting.dispatchSet),
      agentNameMap: new Map([['agent-clio', 'Clio']]),
      mentions: {
        mentionedAgentIds: mockRouting.mentioned,
        hasMentions: mockRouting.mentioned.length > 0,
        rawMentions: [],
      },
      resolveParticipantId: (id: string) =>
        PARTICIPANTS.find((p) => p.toLowerCase() === id.toLowerCase()),
    },
  }),
}));

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { sendToClient: jest.fn(), broadcastToChannel: jest.fn() },
}));

const makeLogsProxy = (): unknown =>
  new Proxy(jest.fn(), {
    get: () => makeLogsProxy(),
    apply: () => undefined,
  });
jest.mock('@server/services/LogsService', () => ({ LogsService: makeLogsProxy() }));

import { dispatchToThread } from '@server/services/SocketService/dispatch/dispatchToThread';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { drainInjectablePeerMessages } from '@server/services/SocketService/handlers/chatPhases/peerInjection';

const THREAD = 'thread-1111111111111-seedinjct';
const SESSION = 'session-running-wave';
const USER = { kind: 'user' as const, name: 'Claude Code', userId: 'user-local' };

/** Hold the thread's run lock and register `agentIds` as live thread-runs. */
function startRun(agentIds: string[]): void {
  expect(activeRunTracker.startSession(SESSION, THREAD)).toBe(true);
  for (const agentId of agentIds) {
    activeRunTracker.start(`run-${agentId}`, {
      agentId,
      agentName: agentId,
      threadId: THREAD,
      threadTitle: 'T',
    });
  }
}

function seed(
  messageId: string,
  message: string,
  senderId: string,
  sender: Parameters<typeof dispatchToThread>[0]['sender'] = USER
) {
  return dispatchToThread({
    threadId: THREAD,
    senderId,
    messageId,
    message,
    source: 'tool',
    sender,
  });
}

/** What the running agent's next tool-result turn would get appended. */
function nextToolSeam(agentId: string, mode: 'all' | 'mentioned' = 'mentioned'): string[] {
  return drainInjectablePeerMessages({ threadId: THREAD, agentId, mode });
}

beforeEach(() => {
  mockRouting = { dispatchSet: [], mentioned: [] };
  pendingAgentMessages.resetForTests();
  activeWorkRegistry.clear();
});

afterEach(() => {
  activeRunTracker.takeSkippedSeeds(SESSION);
  for (const id of PARTICIPANTS) activeRunTracker.finish(`run-${id}`);
  activeRunTracker.finishSession(SESSION);
  activeWorkRegistry.clear();
});

describe('tool-dispatch seed on a busy thread → in-run delivery', () => {
  it('an external MCP @mention reaches the running agent at its next tool seam, and is not re-dispatched after the run', async () => {
    startRun(['agent-venus']);
    mockRouting = { dispatchSet: ['agent-venus'], mentioned: ['agent-venus'] };

    const result = await seed('message-1', '@Venus here is the test output', 'member-cc');
    expect(result.reason).toBe('queued_for_post_run');

    const injected = nextToolSeam('agent-venus');
    expect(injected).toHaveLength(1);
    expect(injected[0]).toBe('[message from Claude Code] @Venus here is the test output');

    // Seen in-run → struck from the post-run backstop: no second wake.
    expect(activeRunTracker.takeSkippedSeeds(SESSION)).toEqual([]);
  });

  it('keeps the post-run re-dispatch when the run ends before any tool seam', async () => {
    startRun(['agent-venus']);
    mockRouting = { dispatchSet: ['agent-venus'], mentioned: ['agent-venus'] };

    await seed('message-late', '@Venus one more thing', 'member-cc');

    // No drain happened (final reply, no further tool call): exactly one wake.
    expect(activeRunTracker.takeSkippedSeeds(SESSION)).toEqual(['message-late']);
  });

  it('mentioned mode: an un-mentioned running agent is not injected', async () => {
    startRun(['agent-venus', 'agent-clio']);
    mockRouting = { dispatchSet: ['agent-venus'], mentioned: ['agent-venus'] };

    await seed('message-m', '@Venus only you', 'member-cc');

    expect(nextToolSeam('agent-clio')).toEqual([]);
    expect(nextToolSeam('agent-venus')).toHaveLength(1);
    expect(activeRunTracker.takeSkippedSeeds(SESSION)).toEqual([]);
  });

  it('a peer agent post is mode-gated at drain: injected in all mode, deferred (not injected) in mentioned mode without a mention', async () => {
    startRun(['agent-venus', 'agent-test-c']);
    mockRouting = { dispatchSet: ['agent-venus', 'agent-test-c'], mentioned: [] };

    // Label comes from the dispatch deps' participant name map.
    await seed('message-peer', 'status: H1 landed', 'agent-clio', { kind: 'agent' });

    const venus = nextToolSeam('agent-venus', 'all');
    expect(venus).toHaveLength(1);
    expect(venus[0]).toContain('[message from Clio]');
    // Same message, mentioned-mode policy, no @mention → deferred to history.
    expect(nextToolSeam('agent-test-c', 'mentioned')).toEqual([]);
  });

  it('never injects into the sender’s own run (an agent’s own thread_send post)', async () => {
    startRun(['agent-venus']);
    // Even if routing put the sender in the set, its own post is not news to it.
    mockRouting = { dispatchSet: ['agent-venus'], mentioned: ['agent-venus'] };

    await seed('message-self', '@Venus note to self', 'agent-venus', {
      kind: 'agent',
      name: 'Venus',
    });

    expect(nextToolSeam('agent-venus', 'all')).toEqual([]);
    // Nothing was injected, so the backstop stays armed.
    expect(activeRunTracker.takeSkippedSeeds(SESSION)).toEqual(['message-self']);
  });

  it('keeps the backstop when a target is idle (only the running one is injected)', async () => {
    startRun(['agent-venus']);
    mockRouting = { dispatchSet: ['agent-venus', 'agent-clio'], mentioned: [] };

    await seed('message-mixed', 'everyone: heads up', 'member-cc');

    expect(nextToolSeam('agent-venus', 'all')).toHaveLength(1);
    expect(nextToolSeam('agent-clio', 'all')).toEqual([]);
    // Clio is idle and never saw it → the post-run wake must still fire.
    expect(activeRunTracker.takeSkippedSeeds(SESSION)).toEqual(['message-mixed']);
  });

  it('without a sender the busy branch only records the seed', async () => {
    startRun(['agent-venus']);
    mockRouting = { dispatchSet: ['agent-venus'], mentioned: ['agent-venus'] };

    await dispatchToThread({
      threadId: THREAD,
      senderId: 'member-cc',
      messageId: 'message-legacy',
      message: '@Venus hi',
      source: 'tool',
    });

    expect(nextToolSeam('agent-venus')).toEqual([]);
    expect(activeRunTracker.takeSkippedSeeds(SESSION)).toEqual(['message-legacy']);
  });
});
