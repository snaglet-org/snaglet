import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const start = jest.fn();
const finish = jest.fn();
const listRecent = jest.fn();
const listByHook = jest.fn();
const markInterrupted = jest.fn();

jest.mock('@snaglet/db', () => ({
  HookRuns: {
    start,
    finish,
    listRecent,
    listByHook,
    markInterrupted,
  },
}));

const emitHookRunStarted = jest.fn();
const emitHookRunFinished = jest.fn();
jest.mock('@server/realtime/surfaces/hookRuns', () => ({
  emitHookRunStarted,
  emitHookRunFinished,
}));

import { hookRunLedger } from '@server/services/customHooks/HookRunLedger';

const RUN = {
  id: 'hook-run-1',
  hookName: 'daily-digest',
  source: 'event' as const,
  eventName: 'message:create',
  status: 'running' as const,
  agentId: null,
  threadId: null,
  durationMs: null,
  exitCode: null,
  stdout: null,
  stderr: null,
  startedAt: '2026-07-29T12:00:00.000Z',
  finishedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('HookRunLedger', () => {
  it('broadcasts the durable start row after persistence succeeds', async () => {
    start.mockResolvedValue(RUN as never);

    await hookRunLedger.start({
      id: RUN.id,
      hookName: RUN.hookName,
      source: RUN.source,
      eventName: RUN.eventName,
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ hookName: 'daily-digest', source: 'event' })
    );
    expect(emitHookRunStarted).toHaveBeenCalledWith(RUN);
  });

  it('records timeout as a distinct terminal status and broadcasts the final row', async () => {
    const timedOut = {
      ...RUN,
      status: 'timed_out',
      durationMs: 30_000,
      stderr: 'timeout',
      finishedAt: '2026-07-29T12:00:30.000Z',
    };
    finish.mockResolvedValue(timedOut as never);

    await hookRunLedger.finish(RUN.id, {
      ok: false,
      exitCode: null,
      durationMs: 30_000,
      stdout: '',
      stderr: 'timeout',
      timedOut: true,
    });

    expect(finish).toHaveBeenCalledWith(
      RUN.id,
      expect.objectContaining({ status: 'timed_out', durationMs: 30_000 })
    );
    expect(emitHookRunFinished).toHaveBeenCalledWith(timedOut);
  });

  it('delegates bounded recent and per-hook history reads', async () => {
    listRecent.mockResolvedValue([RUN] as never);
    listByHook.mockResolvedValue([RUN] as never);

    await expect(hookRunLedger.listRecent(12)).resolves.toEqual([RUN]);
    await expect(hookRunLedger.listByHook('daily-digest', 40)).resolves.toEqual([RUN]);
    expect(listRecent).toHaveBeenCalledWith(12);
    expect(listByHook).toHaveBeenCalledWith('daily-digest', 40);
  });
});
