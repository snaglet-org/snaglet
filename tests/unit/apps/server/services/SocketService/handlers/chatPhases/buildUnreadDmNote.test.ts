/**
 * buildUnreadDmNote — best-effort, skipped for dm_enabled=false, one summary
 * query for an agent with no mail, and marks the run's own DM thread read first.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const order: string[] = [];
const mockFindByAgent = jest.fn<(id: string) => Promise<{ id: string } | null>>();
const mockSummary = jest.fn<(id: string) => Promise<unknown[]>>();
const mockMarkIfDm = jest.fn<(t: string, m: string) => Promise<void>>();
jest.mock('@snaglet/db/tables/members', () => ({
  Members: { findByAgent: (id: string) => mockFindByAgent(id) },
}));
jest.mock('@server/services/dm/DmService', () => ({
  DmService: {
    unreadSummary: (id: string) => {
      order.push('summary');
      return mockSummary(id);
    },
    markReadIfDm: (t: string, m: string) => {
      order.push('mark');
      return mockMarkIfDm(t, m);
    },
  },
}));
const mockWarn = jest.fn();
jest.mock('@server/config/logger', () => ({ logger: { warn: (m: unknown) => mockWarn(m) } }));

import { buildUnreadDmNote } from '@server/services/SocketService/handlers/chatPhases/buildUnreadDmNote';

beforeEach(() => {
  order.length = 0;
  mockFindByAgent.mockReset().mockResolvedValue({ id: 'member-a' });
  mockSummary
    .mockReset()
    .mockResolvedValue([{ fromName: 'Test Agent B', fromKind: 'agent', count: 2 }]);
  mockMarkIfDm.mockReset().mockResolvedValue(undefined);
  mockWarn.mockReset();
});

describe('buildUnreadDmNote', () => {
  it('names the senders of unread mail', async () => {
    expect(await buildUnreadDmNote('test-agent-a', { dmEnabled: true })).toBe(
      'Unread DMs: 2 from Test Agent B. Read them with the thread tool, op "dm_list" (see the snaglet-dms skill).'
    );
  });

  it('no unread mail yields null after exactly one summary query', async () => {
    mockSummary.mockResolvedValue([]);
    expect(await buildUnreadDmNote('test-agent-a', { dmEnabled: true })).toBeNull();
    expect(mockSummary).toHaveBeenCalledTimes(1);
  });

  it('skips without any query when dm_enabled is false', async () => {
    expect(await buildUnreadDmNote('test-agent-a', { dmEnabled: false })).toBeNull();
    expect(mockFindByAgent).not.toHaveBeenCalled();
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('marks the current thread read (DM-only, decided in SQL) before computing the note', async () => {
    await buildUnreadDmNote('test-agent-a', { dmEnabled: true, currentThreadId: 'thread-1' });
    expect(mockMarkIfDm).toHaveBeenCalledWith('thread-1', 'member-a');
    expect(order).toEqual(['mark', 'summary']);
  });

  it('does not mark anything without a current thread', async () => {
    await buildUnreadDmNote('test-agent-a', { dmEnabled: true });
    expect(mockMarkIfDm).not.toHaveBeenCalled();
  });

  it('a lookup error yields null and a warning', async () => {
    mockSummary.mockRejectedValue(new Error('db down'));
    expect(await buildUnreadDmNote('test-agent-a', { dmEnabled: true })).toBeNull();
    expect(String(mockWarn.mock.calls[0]?.[0])).toContain('db down');
  });
});
