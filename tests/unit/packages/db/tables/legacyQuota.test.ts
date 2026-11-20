/**
 * Undo/redo skips a journaled quota repeat op (a `counted` tally step, a
 * repeat value with a `quota` key, a log row with a `done_on` day): quotas
 * are not supported, so replaying one would write a plain `done` the row
 * never had.
 */
import { describe, expect, it } from '@jest/globals';
import { isLegacyQuotaRepeatOp } from '@snaglet/db/tables/table_history/legacyQuota';
import type { RepeatOp, StoredOccurrence } from '@snaglet/db/tables/table_history/types';

const REPEAT = {
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  dtstart: '2026-03-02',
  current: '2026-03-09',
  tz: 'UTC',
};

function row(extra: Record<string, unknown> = {}): StoredOccurrence {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tableId: 'table-1111111111111-aaaaaaaaa',
    fieldId: 'field-1',
    entryId: '11111111-1111-4111-8111-111111111111',
    occurrence: '2026-03-02',
    kind: 'done',
    movedTo: null,
    actorKind: 'user',
    actorId: 'u1',
    createdAt: '2026-03-02T10:00:00.000Z',
    ...extra,
  } as StoredOccurrence;
}

function op(partial: Partial<RepeatOp>): RepeatOp {
  return {
    op: 'repeat',
    tableId: 'table-1111111111111-aaaaaaaaa',
    fieldId: 'field-1',
    entryId: '11111111-1111-4111-8111-111111111111',
    before: REPEAT,
    after: { ...REPEAT, current: '2026-03-16' },
    added: [row()],
    removed: [],
    occurrence: { action: 'done' },
    ...partial,
  };
}

describe('isLegacyQuotaRepeatOp', () => {
  it('leaves a current done, skip, set and clear op alone', () => {
    expect(isLegacyQuotaRepeatOp(op({}))).toBe(false);
    expect(isLegacyQuotaRepeatOp(op({ occurrence: { action: 'skipped' } }))).toBe(false);
    expect(isLegacyQuotaRepeatOp(op({ occurrence: undefined, before: null }))).toBe(false);
    expect(isLegacyQuotaRepeatOp(op({ occurrence: undefined, after: null, added: [] }))).toBe(
      false
    );
  });

  it('flags an old counted tally step', () => {
    const counted = { action: 'counted' } as unknown as RepeatOp['occurrence'];
    expect(isLegacyQuotaRepeatOp(op({ occurrence: counted }))).toBe(true);
  });

  it('flags a repeat value that still carries a quota, on either side', () => {
    const quota = { ...REPEAT, quota: { count: 3, days: null } };
    expect(isLegacyQuotaRepeatOp(op({ before: quota }))).toBe(true);
    expect(isLegacyQuotaRepeatOp(op({ after: quota }))).toBe(true);
  });

  it('flags a log row journaled with a tally day, added or removed', () => {
    expect(isLegacyQuotaRepeatOp(op({ added: [row({ doneOn: '2026-03-04' })] }))).toBe(true);
    expect(
      isLegacyQuotaRepeatOp(
        op({
          occurrence: { action: 'undone' },
          added: [],
          removed: [row({ doneOn: '2026-03-04' })],
        })
      )
    ).toBe(true);
    expect(isLegacyQuotaRepeatOp(op({ added: [row({ doneOn: null })] }))).toBe(false);
  });
});
