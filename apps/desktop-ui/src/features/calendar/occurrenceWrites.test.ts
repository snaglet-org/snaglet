import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarOccurrence, CalendarRowOccurrence } from '@snaglet/shared/types';

const tables = vi.hoisted(() => ({ updateEntry: vi.fn(), history: vi.fn() }));
vi.mock('@desktop/utils/api', () => ({ tablesApi: tables, archiveApi: { restore: vi.fn() } }));
const repeats = vi.hoisted(() => ({
  move: vi.fn(),
  shift: vi.fn(),
  complete: vi.fn(),
  skip: vi.fn(),
}));
vi.mock('@desktop/utils/api/tableRepeats', () => ({ tableRepeatsApi: repeats }));
const history = vi.hoisted(() => ({ stepTableHistory: vi.fn() }));
// The real newestTableStep reads the mocked tablesApi.history.
vi.mock('@desktop/features/database/tableHistory', async (orig) => ({
  ...(await orig<typeof import('@desktop/features/database/tableHistory')>()),
  ...history,
}));
const cal = vi.hoisted(() => ({ updateEvent: vi.fn(), getEvent: vi.fn() }));
vi.mock('./calendarApi', () => ({ calendarApi: cal }));
const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

import {
  canShiftAll,
  cellValue,
  commitMove,
  completeOrSkip,
  needsRepeatChoice,
} from './occurrenceWrites';
import { __resetCalendarUndoForTests, undoCalendarStep, redoCalendarStep } from './calendarUndo';

const before = {
  kind: 'timed' as const,
  start: '2026-10-13T16:00:00.000Z',
  end: '2026-10-13T16:30:00.000Z',
};
const after = {
  kind: 'timed' as const,
  start: '2026-10-14T17:15:00.000Z',
  end: '2026-10-14T17:45:00.000Z',
};

function row(extra: Partial<CalendarRowOccurrence> = {}): CalendarRowOccurrence {
  return {
    source: 'row',
    key: 'row:f1:e1:x',
    calendarId: 'c',
    title: 'Pay rent',
    time: before,
    status: 'upcoming',
    canMove: true,
    canResize: true,
    tableId: 't1',
    tableName: 'Bills',
    projectId: null,
    entryId: 'e1',
    fieldId: 'f1',
    range: false,
    hasEnd: false,
    entryRevision: 'rev-1',
    schemaVersion: 'sv-1',
    ...extra,
  };
}

const step = { id: 'h9', label: 'Edit Pay rent', state: 'done', tableIds: ['t1'] };

describe('occurrenceWrites', () => {
  beforeEach(() => {
    __resetCalendarUndoForTests();
    for (const m of [tables, repeats, history, cal, toast]) {
      Object.values(m).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset());
    }
    tables.history.mockResolvedValue({ undo: step, redo: null });
  });

  it('plain row whose history step cannot be found: no guessed undo, a pointer to the history', async () => {
    tables.updateEntry.mockResolvedValue({});
    tables.history.mockRejectedValue(new Error('offline'));
    await commitMove(row(), after, { zone: 'UTC', message: 'Moved Pay rent' });
    expect(toast.showToast).toHaveBeenCalledWith(
      "Moved Pay rent. To undo it, use the table's history."
    );
    await undoCalendarStep();
    expect(history.stepTableHistory).not.toHaveBeenCalled();
  });

  it('a newest step that is not a done step of this table offers no undo', async () => {
    tables.updateEntry.mockResolvedValue({});
    for (const undo of [
      { ...step, state: 'undone' },
      { ...step, tableIds: ['t2'] },
    ]) {
      toast.showToast.mockClear();
      tables.history.mockResolvedValue({ undo, redo: null });
      await commitMove(row(), after, { zone: 'UTC', message: 'Moved Pay rent' });
      expect(toast.showToast).toHaveBeenCalledWith(
        "Moved Pay rent. To undo it, use the table's history."
      );
    }
    await undoCalendarStep();
    expect(history.stepTableHistory).not.toHaveBeenCalled();
  });

  it('plain row: one entry update with the start and revisions; undo/redo step that history id', async () => {
    tables.updateEntry.mockResolvedValue({});
    await commitMove(row(), after, { zone: 'UTC', message: 'Moved Pay rent' });
    expect(tables.updateEntry).toHaveBeenCalledWith('t1', 'e1', {
      values: { f1: after.start },
      schemaVersion: 'sv-1',
      expectedRevision: 'rev-1',
    });
    expect(toast.showToast).toHaveBeenCalledWith(
      'Moved Pay rent',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    );
    await undoCalendarStep();
    expect(history.stepTableHistory).toHaveBeenCalledWith('undo', {
      expected: step,
      tableId: 't1',
    });
    await redoCalendarStep();
    expect(history.stepTableHistory).toHaveBeenLastCalledWith('redo', {
      expected: { ...step, state: 'undone' },
      tableId: 't1',
    });
  });

  it('repeating row: R3 move (only this one) and shift (all upcoming) with the planned occurrence', async () => {
    const o = row({
      repeat: { occurrence: '2026-10-13T09:00:00', isCurrent: true, summary: 'Weekly' },
    });
    repeats.move.mockResolvedValue({});
    repeats.shift.mockResolvedValue({});
    await commitMove(o, after, { zone: 'UTC', message: 'm', mode: 'one' });
    expect(repeats.move).toHaveBeenCalledWith('t1', 'e1', 'f1', {
      occurrence: '2026-10-13T09:00:00',
      to: after.start,
      expectedRevision: 'rev-1',
      schemaVersion: 'sv-1',
    });
    await commitMove(o, after, { zone: 'UTC', message: 'm', mode: 'all' });
    expect(repeats.shift).toHaveBeenCalledTimes(1);
    expect(tables.updateEntry).not.toHaveBeenCalled();
  });

  it('date fields send YYYY-MM-DD', async () => {
    const o = row({
      time: { kind: 'all_day', startDate: '2026-10-13', endDate: '2026-10-14' },
      repeat: { occurrence: '2026-10-13', isCurrent: true, summary: 'Weekly' },
    });
    repeats.move.mockResolvedValue({});
    await commitMove(
      o,
      { kind: 'all_day', startDate: '2026-10-15', endDate: '2026-10-16' },
      {
        zone: 'UTC',
        message: 'm',
      }
    );
    expect(repeats.move.mock.calls[0]![3]).toMatchObject({
      occurrence: '2026-10-13',
      to: '2026-10-15',
    });
  });

  it('events PATCH time at the revision', async () => {
    const e: CalendarOccurrence = {
      source: 'event',
      key: 'event:e',
      eventId: 'e',
      revision: 4,
      calendarId: 'c',
      title: 'Standup',
      time: before,
      status: 'upcoming',
      canMove: true,
      canResize: true,
    };
    cal.updateEvent.mockResolvedValue({ event: {} });
    await commitMove(e, after, { zone: 'UTC', message: 'Moved Standup' });
    expect(cal.updateEvent).toHaveBeenCalledWith('e', {
      time: { kind: 'timed', startAt: after.start, endAt: after.end, timeZone: 'UTC' },
      expectedRevision: 4,
    });
  });

  it("an event's move and its undo / redo keep the event's own zone, not the viewer's", async () => {
    const e: CalendarOccurrence = {
      source: 'event',
      key: 'event:e',
      eventId: 'e',
      revision: 4,
      timeZone: 'Asia/Tokyo',
      calendarId: 'c',
      title: 'Standup',
      time: before,
      status: 'upcoming',
      canMove: true,
      canResize: true,
    };
    cal.updateEvent.mockResolvedValue({ event: {} });
    cal.getEvent.mockResolvedValue({ event: { revision: 5 } });
    await commitMove(e, after, { zone: 'UTC', message: 'Moved Standup' });
    const saved = { kind: 'timed', startAt: after.start, endAt: after.end, timeZone: 'Asia/Tokyo' };
    expect(cal.updateEvent).toHaveBeenLastCalledWith('e', { time: saved, expectedRevision: 4 });

    await undoCalendarStep();
    expect(cal.updateEvent).toHaveBeenLastCalledWith('e', {
      time: { kind: 'timed', startAt: before.start, endAt: before.end, timeZone: 'Asia/Tokyo' },
      expectedRevision: 5,
    });
    await redoCalendarStep();
    expect(cal.updateEvent).toHaveBeenLastCalledWith('e', { time: saved, expectedRevision: 5 });
  });

  it('a failed write throws and records no step', async () => {
    tables.updateEntry.mockRejectedValue(new Error('nope'));
    await expect(commitMove(row(), after, { zone: 'UTC', message: 'm' })).rejects.toThrow('nope');
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('complete / skip go to R3 with the current-occurrence guard', async () => {
    const o = row({
      repeat: { occurrence: '2026-10-13T09:00:00', isCurrent: true, summary: 'Weekly' },
    });
    repeats.complete.mockResolvedValue({});
    repeats.skip.mockResolvedValue({});
    await completeOrSkip(o, 'done', 'Marked Pay rent done');
    expect(repeats.complete).toHaveBeenCalledWith('t1', 'e1', 'f1', {
      expectedRevision: 'rev-1',
      schemaVersion: 'sv-1',
      expectedCurrent: '2026-10-13T09:00:00',
    });
    await completeOrSkip(o, 'skip', 'Skipped Pay rent');
    expect(repeats.skip).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith('Skipped Pay rent', expect.anything());
  });

  describe('range fields (End date on)', () => {
    const write = () => tables.updateEntry.mock.calls[0]![2];

    it('a move writes the whole shifted datetime range in one entry update', async () => {
      tables.updateEntry.mockResolvedValue({});
      await commitMove(row({ range: true, hasEnd: true }), after, { zone: 'UTC', message: 'm' });
      expect(tables.updateEntry).toHaveBeenCalledTimes(1);
      expect(write()).toEqual({
        values: { f1: `${after.start}/${after.end}` },
        schemaVersion: 'sv-1',
        expectedRevision: 'rev-1',
      });
    });

    it('a move keeps a short range exact (the drag draws at least 15 minutes)', () => {
      const short = row({
        range: true,
        hasEnd: true,
        time: { kind: 'timed', start: '2026-10-13T09:00:00.000Z', end: '2026-10-13T09:10:00.000Z' },
      });
      const dropped = {
        kind: 'timed' as const,
        start: '2026-10-14T11:00:00.000Z',
        end: '2026-10-14T11:15:00.000Z',
      };
      expect(cellValue(short, dropped)).toBe('2026-10-14T11:00:00.000Z/2026-10-14T11:10:00.000Z');
      expect(cellValue(short, dropped, 'resize')).toBe(
        '2026-10-14T11:00:00.000Z/2026-10-14T11:15:00.000Z'
      );
    });

    it('a range holding only a start stays single on a move, and gets an end on a resize', async () => {
      tables.updateEntry.mockResolvedValue({});
      const single = row({ range: true, hasEnd: false });
      await commitMove(single, after, { zone: 'UTC', message: 'm' });
      expect(write().values).toEqual({ f1: after.start });
      tables.updateEntry.mockClear();
      await commitMove(single, after, { zone: 'UTC', message: 'm', kind: 'resize' });
      expect(write().values).toEqual({ f1: `${after.start}/${after.end}` });
    });

    it('a date range writes its last day (the end is included on the wire)', () => {
      const days = row({
        range: true,
        hasEnd: true,
        time: { kind: 'all_day', startDate: '2026-10-13', endDate: '2026-10-16' },
      });
      expect(
        cellValue(days, { kind: 'all_day', startDate: '2026-10-20', endDate: '2026-10-23' })
      ).toBe('2026-10-20/2026-10-22');
      expect(
        cellValue(days, { kind: 'all_day', startDate: '2026-10-20', endDate: '2026-10-21' })
      ).toBe('2026-10-20');
      // A plain date field still gets only its date.
      expect(
        cellValue(row({ time: days.time }), {
          kind: 'all_day',
          startDate: '2026-10-20',
          endDate: '2026-10-23',
        })
      ).toBe('2026-10-20');
    });

    it('a resize of a repeating row is one plain entry update, never a move or shift', async () => {
      tables.updateEntry.mockResolvedValue({});
      const o = row({
        range: true,
        hasEnd: true,
        repeat: { occurrence: '2026-10-13T09:00:00', isCurrent: true, summary: 'Weekly' },
      });
      const longer = {
        kind: 'timed' as const,
        start: before.start,
        end: '2026-10-13T18:00:00.000Z',
      };
      await commitMove(o, longer, { zone: 'UTC', message: 'Resized', kind: 'resize' });
      expect(repeats.move).not.toHaveBeenCalled();
      expect(repeats.shift).not.toHaveBeenCalled();
      expect(tables.updateEntry).toHaveBeenCalledWith('t1', 'e1', {
        values: { f1: `${before.start}/2026-10-13T18:00:00.000Z` },
        schemaVersion: 'sv-1',
        expectedRevision: 'rev-1',
      });
      // A move of the same row still goes to the repeat route (the server keeps the length).
      repeats.move.mockResolvedValue({});
      await commitMove(o, after, { zone: 'UTC', message: 'm', mode: 'one' });
      expect(repeats.move).toHaveBeenCalledWith('t1', 'e1', 'f1', {
        occurrence: '2026-10-13T09:00:00',
        to: after.start,
        expectedRevision: 'rev-1',
        schemaVersion: 'sv-1',
      });
      expect(tables.updateEntry).toHaveBeenCalledTimes(1);
    });
  });

  it('needsRepeatChoice / canShiftAll (missing = true)', () => {
    expect(needsRepeatChoice(row())).toBe(false);
    const r = row({ repeat: { occurrence: 'x', isCurrent: true, summary: '' } });
    expect(needsRepeatChoice(r)).toBe(true);
    expect(canShiftAll(r)).toBe(true);
    const blocked = row({
      repeat: { occurrence: 'x', isCurrent: false, summary: '', canShiftAll: false } as never,
    });
    expect(canShiftAll(blocked)).toBe(false);
  });
});
