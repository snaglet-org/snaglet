/**
 * MemoryStatusRegistry — D4: skip/failure reasons are recorded and
 * queryable, inactive states log once per thread per boot, and active
 * transitions clear the log latch.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const info = jest.fn();

jest.mock('@server/config/logger', () => ({
  logger: {
    info: (...args: unknown[]) => info(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  getThreadMemoryStatus,
  listThreadMemoryStatuses,
  resetMemoryStatusRegistryForTests,
  setThreadMemoryStatus,
} from '@server/services/summary/MemoryStatusRegistry';

beforeEach(() => {
  jest.clearAllMocks();
  resetMemoryStatusRegistryForTests();
});

describe('thread statuses', () => {
  it('records and reads per-agent status, falling back to the shared slot', () => {
    setThreadMemoryStatus('t1', null, { state: 'active', providerId: 'ollama', modelId: 'm' });

    expect(getThreadMemoryStatus('t1', 'agent-1')).toMatchObject({
      state: 'active',
      providerId: 'ollama',
    });

    setThreadMemoryStatus('t1', 'agent-1', { state: 'inactive', reason: 'no-credentials' });
    expect(getThreadMemoryStatus('t1', 'agent-1')).toMatchObject({
      state: 'inactive',
      reason: 'no-credentials',
    });
    // Shared slot unaffected.
    expect(getThreadMemoryStatus('t1')).toMatchObject({ state: 'active' });
  });

  it('lists all statuses for a thread', () => {
    setThreadMemoryStatus('t1', 'a1', { state: 'active', providerId: 'p', modelId: 'm' });
    setThreadMemoryStatus('t1', 'a2', { state: 'inactive', reason: 'quality-floor' });
    setThreadMemoryStatus('t2', 'a3', { state: 'active' });

    const list = listThreadMemoryStatuses('t1');
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.agentId).sort()).toEqual(['a1', 'a2']);
  });

  it('logs inactive once per thread+agent per boot; active clears the latch', () => {
    setThreadMemoryStatus('t1', 'a1', { state: 'inactive', reason: 'no-credentials' });
    setThreadMemoryStatus('t1', 'a1', { state: 'inactive', reason: 'no-credentials' });
    expect(info).toHaveBeenCalledTimes(1);

    setThreadMemoryStatus('t1', 'a1', { state: 'active', providerId: 'p', modelId: 'm' });
    setThreadMemoryStatus('t1', 'a1', { state: 'inactive', reason: 'daily-cap-reached' });
    expect(info).toHaveBeenCalledTimes(2); // re-logged after recovery
  });
});
