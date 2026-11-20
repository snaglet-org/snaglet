/**
 * A tool/scheduled wake refused by a summary halt is held, not dropped: its
 * seed message is already persisted, so when the halt lifts (on the next user
 * send or wake) every held wake is replayed through the public dispatch entry,
 * oldest first, with its original target.
 *
 * The halt and everything past the halt gate are mocked: `buildDispatchDeps`
 * reporting no participants ends the dispatch right after the gate, which is
 * exactly where a replayed wake proves it got through.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let mockHalted = false;
let mockRepaired = false;
jest.mock('@server/services/summary/summaryHalt', () => ({
  isThreadSummaryHalted: () => mockHalted,
  clearSummaryHaltIfRepaired: async () => {
    if (!mockHalted) return true;
    if (!mockRepaired) return false;
    mockHalted = false;
    return true;
  },
}));

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: async (id: string) => ({ id }) },
}));

const buildDispatchDeps = jest.fn(async (_input: Record<string, unknown>) => ({
  ok: false as const,
  reason: 'no_participants' as const,
}));
jest.mock('@server/services/SocketService/dispatch/buildDispatchDeps', () => ({
  buildDispatchDeps: (input: Record<string, unknown>) => buildDispatchDeps(input),
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
import {
  liftSummaryHaltAndReplayWakes,
  listHeldWakes,
  resetHeldWakesForTests,
} from '@server/services/SocketService/dispatch/summaryHaltedWakes';

const THREAD = 'thread-1111111111111-aaaaaaaaa';

function wake(messageId: string, targetAgentId?: string) {
  return {
    threadId: THREAD,
    senderId: 'test-agent-a',
    messageId,
    message: `seed ${messageId}`,
    source: 'tool' as const,
    ...(targetAgentId ? { targetAgentId } : {}),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  resetHeldWakesForTests();
  mockHalted = true;
  mockRepaired = false;
});

describe('wakes refused by a summary halt', () => {
  it('holds the wake instead of silently dropping it', async () => {
    const result = await dispatchToThread(wake('message-1', 'test-agent-b'));

    expect(result).toEqual({
      ok: true,
      reason: 'held_for_summary_halt',
      wakeCount: 0,
      capHit: false,
    });
    expect(buildDispatchDeps).not.toHaveBeenCalled();
    expect(listHeldWakes(THREAD)).toEqual([wake('message-1', 'test-agent-b')]);
  });

  it('collapses repeat refusals of the same seed', async () => {
    await dispatchToThread(wake('message-1'));
    await dispatchToThread(wake('message-1'));
    await dispatchToThread(wake('message-2'));

    expect(listHeldWakes(THREAD).map((w) => w.messageId)).toEqual(['message-1', 'message-2']);
  });

  it('replays every held wake, in order, when a user send lifts the halt', async () => {
    await dispatchToThread(wake('message-1', 'test-agent-b'));
    await dispatchToThread(wake('message-2'));
    mockRepaired = true;

    await expect(liftSummaryHaltAndReplayWakes(THREAD)).resolves.toBe(true);
    await settle();

    expect(buildDispatchDeps.mock.calls.map(([input]) => input.messageId)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(buildDispatchDeps.mock.calls[0]![0]).toMatchObject({ targetAgentId: 'test-agent-b' });
    expect(listHeldWakes(THREAD)).toEqual([]);
  });

  it('replays held wakes when a later wake is the one that lifts the halt', async () => {
    await dispatchToThread(wake('message-1'));
    mockRepaired = true;

    await dispatchToThread(wake('message-2'));
    await settle();

    const dispatched = buildDispatchDeps.mock.calls.map(([input]) => input.messageId);
    expect(dispatched).toHaveLength(2);
    expect(dispatched).toEqual(expect.arrayContaining(['message-1', 'message-2']));
    expect(listHeldWakes(THREAD)).toEqual([]);
  });

  it('keeps holding while the halt stands', async () => {
    await dispatchToThread(wake('message-1'));

    await expect(liftSummaryHaltAndReplayWakes(THREAD)).resolves.toBe(false);
    await settle();

    expect(buildDispatchDeps).not.toHaveBeenCalled();
    expect(listHeldWakes(THREAD)).toHaveLength(1);
  });
});
