/**
 * The schedule timer survives a database hiccup. The next-run lookup runs in
 * the tick's `finally`; if it throws, the failure is logged and the timer is
 * re-armed at the max poll delay instead of never firing again until restart.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const query = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.mock('@snaglet/db', () => ({
  ...jest.requireActual<Record<string, unknown>>('@snaglet/db'),
  getDb: () => ({ query: (sql: string, params?: unknown[]) => query(sql, params) }),
}));

const logError = jest.fn();
jest.mock('@server/config/logger', () => ({
  logger: {
    error: (...a: unknown[]) => logError(...a),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// start() reconciles automations through a lazy import before the first
// tick. Loading the real AutomationService graph takes real time that fake
// timers can't advance, so under a loaded full run `settleUntil` could give
// up before the first tick. A stub keeps the test on the timer.
jest.mock('@server/services/automations/AutomationService', () => ({
  automationService: { reconcile: async () => undefined },
}));

// The wake heartbeat is its own timer (systemWake.test.ts); this test counts
// the scheduler's.
jest.mock('@server/services/systemActivity/systemWake', () => ({
  systemWakeMonitor: {
    start: () => undefined,
    stop: () => undefined,
    check: () => false,
    lastActivation: () => null,
    onWake: () => () => undefined,
  },
}));

import { scheduleService } from '@server/services/ScheduleService';

const MAX_TIMER_DELAY_MS = 60_000;

function isDueRowsQuery(sql: string): boolean {
  return sql.includes('SELECT * FROM schedules');
}

function isNextRunQuery(sql: string): boolean {
  return sql.includes('MIN(next_run_at)');
}

function callsOf(predicate: (sql: string) => boolean): number {
  return query.mock.calls.filter(([sql]) => predicate(sql)).length;
}

/**
 * Let the service's promise chain run until `condition` holds. Advancing by 0
 * yields to pending promise callbacks without moving the fake clock, so this
 * waits on the outcome rather than on a guessed number of microtask turns.
 */
async function settleUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await jest.advanceTimersByTimeAsync(0);
  expect(condition()).toBe(true);
}

beforeEach(() => {
  jest.useFakeTimers();
  query.mockReset();
  logError.mockReset();
});

afterEach(() => {
  scheduleService.stop();
  jest.useRealTimers();
});

describe('ScheduleService timer', () => {
  it('re-arms and keeps ticking after the next-run lookup fails', async () => {
    let nextRunFailures = 1;
    query.mockImplementation(async (sql) => {
      if (isNextRunQuery(sql) && nextRunFailures > 0) {
        nextRunFailures -= 1;
        throw new Error('connection terminated');
      }
      return { rows: [] };
    });

    scheduleService.start();
    // First tick ran, its next-run lookup failed, and the timer is armed again.
    await settleUntil(() => callsOf(isNextRunQuery) === 1 && jest.getTimerCount() === 1);

    expect(callsOf(isDueRowsQuery)).toBe(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('next-run lookup failed'));

    // Re-armed at the max poll delay: nothing before it, the next tick at it.
    await jest.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS - 1);
    expect(callsOf(isDueRowsQuery)).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await settleUntil(() => callsOf(isNextRunQuery) === 2);

    expect(callsOf(isDueRowsQuery)).toBe(2);
  });
});
