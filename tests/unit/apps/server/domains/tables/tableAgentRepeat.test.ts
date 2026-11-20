/**
 * The `table` tool's repeat items: a `set` carries only `rrule` and `date`.
 * Removed params (`within`, the time-to-do-it window; `quota`, a repeat done
 * a number of times) and anything else unknown are refused with a message
 * that names the key, never dropped on the floor.
 */
import { describe, expect, it } from '@jest/globals';
import { repeatCall } from '@server/domains/tables/tableAgent';

const ID = '11111111-1111-4111-8111-111111111111';

function refusal(run: () => unknown): { statusCode?: number; message?: string } {
  try {
    run();
  } catch (err) {
    return err as { statusCode?: number; message?: string };
  }
  return {};
}

describe('repeat set keys', () => {
  it('rejects quota in a set, naming the key', () => {
    const set = { rrule: 'FREQ=WEEKLY', quota: 3 };
    const error = refusal(() => repeatCall({ id: ID, field: 'when', set } as never, 'repeat[0]'));
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('repeat[0].set.quota');
    expect(error.message).toContain('rrule, date');
  });

  it('rejects within in a set, naming the key', () => {
    const set = { rrule: 'FREQ=DAILY', within: 'P1D' };
    const error = refusal(() => repeatCall({ id: ID, field: 'when', set } as never, 'repeat[2]'));
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('repeat[2].set.within');
  });

  it('passes rrule and date through unchanged', () => {
    expect(
      repeatCall({ id: ID, field: 'when', set: { rrule: 'FREQ=DAILY', date: '2026-03-01' } }, 'r')
    ).toEqual({ action: 'set', body: { rrule: 'FREQ=DAILY', date: '2026-03-01' } });
    expect(repeatCall({ id: ID, field: 'when', set: { rrule: 'FREQ=DAILY' } }, 'r')).toEqual({
      action: 'set',
      body: { rrule: 'FREQ=DAILY' },
    });
  });

  it('still maps null set, done and skip to their actions', () => {
    expect(repeatCall({ id: ID, field: 'when', set: null }, 'r')).toEqual({
      action: 'clear',
      body: {},
    });
    expect(repeatCall({ id: ID, field: 'when', done: true }, 'r')).toEqual({
      action: 'complete',
      body: {},
    });
    expect(repeatCall({ id: ID, field: 'when', skip: 'now' }, 'r')).toEqual({
      action: 'skip',
      body: { jump: true },
    });
  });

  it('rejects an unknown item key the same way', () => {
    const error = refusal(() =>
      repeatCall({ id: ID, field: 'when', done: true, quota: 2 } as never, 'repeat[1]')
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('repeat[1].quota');
  });
});
