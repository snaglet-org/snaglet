import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grabOf, resolveDrop, zoneAt } from './dropTargets';

const Z = 'UTC';
const timed = {
  kind: 'timed' as const,
  start: '2026-10-13T09:00:00.000Z',
  end: '2026-10-13T10:00:00.000Z',
};
const allDay = { kind: 'all_day' as const, startDate: '2026-10-13', endDate: '2026-10-15' };

/** A column whose viewport rect is 0..960 px (40 px / hour) — or zoomed: any height works. */
function column(kind: string, day: string, height = 960): HTMLElement {
  const el = document.createElement('div');
  el.dataset.calDrop = kind;
  el.dataset.calDay = day;
  el.getBoundingClientRect = () =>
    ({ top: 0, height, left: 0, width: 100, bottom: height, right: 100 }) as DOMRect;
  return el;
}

describe('dropTargets', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => root.remove());

  it('zoneAt finds the marked zone under the point inside the root only', () => {
    const col = column('timed', '2026-10-14');
    const slot = document.createElement('div');
    col.append(slot);
    root.append(col);
    const outside = column('timed', '2026-10-20');
    document.body.append(outside);
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [
      slot,
    ];
    expect(zoneAt(root, 1, 1)).toMatchObject({ kind: 'timed', day: '2026-10-14' });
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [
      outside,
    ];
    expect(zoneAt(root, 1, 1)).toBeNull();
    outside.remove();
  });

  it('moves a timed item keeping the grab offset, snapped to 15 min (zoom-safe ratio)', () => {
    // Pointer grabbed 30 min into the block.
    const col = column('timed', '2026-10-13');
    const grab = grabOf(timed, { kind: 'timed', day: '2026-10-13', el: col }, 9.5 * 40, Z);
    expect(grab.ms).toBe(30 * 60_000);
    // Same ratio on a 2× zoomed column (1920 px): 14:37 pointer → 14:07 start → 14:00.
    const zoomed = column('timed', '2026-10-14', 1920);
    const out = resolveDrop(
      timed,
      'move',
      { kind: 'timed', day: '2026-10-14', el: zoomed },
      (14 + 37 / 60) * 80,
      grab,
      Z
    );
    expect(out).toEqual({
      kind: 'timed',
      start: '2026-10-14T14:00:00.000Z',
      end: '2026-10-14T15:00:00.000Z',
    });
  });

  it('invalid: nowhere, kind changes, resize on another day', () => {
    const col = column('timed', '2026-10-13');
    const band = column('allday', '2026-10-13');
    const g = { ms: 0, days: 0 };
    expect(resolveDrop(timed, 'move', null, 0, g, Z)).toBeNull();
    expect(
      resolveDrop(timed, 'move', { kind: 'allday', day: '2026-10-13', el: band }, 0, g, Z)
    ).toBeNull();
    expect(
      resolveDrop(allDay, 'move', { kind: 'timed', day: '2026-10-13', el: col }, 0, g, Z)
    ).toBeNull();
    const other = column('timed', '2026-10-14');
    expect(
      resolveDrop(timed, 'resize-end', { kind: 'timed', day: '2026-10-14', el: other }, 400, g, Z)
    ).toBeNull();
  });

  it('resizes either edge on its own day (min 15 min)', () => {
    const col = column('timed', '2026-10-13');
    const zone = { kind: 'timed' as const, day: '2026-10-13', el: col };
    const g = { ms: 0, days: 0 };
    expect(resolveDrop(timed, 'resize-end', zone, 11.25 * 40, g, Z)).toEqual({
      kind: 'timed',
      start: timed.start,
      end: '2026-10-13T11:15:00.000Z',
    });
    expect(resolveDrop(timed, 'resize-start', zone, 9.9 * 40, g, Z)).toEqual({
      kind: 'timed',
      start: '2026-10-13T09:45:00.000Z',
      end: timed.end,
    });
  });

  it('a range row resizes across days (end ≥ its start day, start ≤ its end day); events do not', () => {
    const g = { ms: 0, days: 0 };
    const at = (day: string) => ({ kind: 'timed' as const, day, el: column('timed', day) });
    // Event rule unchanged: the end stays on the start day.
    expect(resolveDrop(timed, 'resize-end', at('2026-10-15'), 17 * 40, g, Z)).toBeNull();
    // A range row's end lands on Thursday 17:00.
    expect(resolveDrop(timed, 'resize-end', at('2026-10-15'), 17 * 40, g, Z, true)).toEqual({
      kind: 'timed',
      start: timed.start,
      end: '2026-10-15T17:00:00.000Z',
    });
    // Not before the start's day; the minimum length still holds on the start day.
    expect(resolveDrop(timed, 'resize-end', at('2026-10-12'), 17 * 40, g, Z, true)).toBeNull();
    expect(resolveDrop(timed, 'resize-end', at('2026-10-13'), 2 * 40, g, Z, true)).toEqual({
      kind: 'timed',
      start: timed.start,
      end: '2026-10-13T09:15:00.000Z',
    });
    // The start may move to an earlier day, never past the end's day.
    expect(resolveDrop(timed, 'resize-start', at('2026-10-12'), 20 * 40, g, Z, true)).toEqual({
      kind: 'timed',
      start: '2026-10-12T20:00:00.000Z',
      end: timed.end,
    });
    expect(resolveDrop(timed, 'resize-start', at('2026-10-14'), 8 * 40, g, Z, true)).toBeNull();
  });

  it("a multi-day event's end resizes on its last day (where its handle is), not elsewhere", () => {
    const g = { ms: 0, days: 0 };
    const at = (day: string) => ({ kind: 'timed' as const, day, el: column('timed', day) });
    const overnight = {
      kind: 'timed' as const,
      start: '2026-10-13T21:00:00.000Z',
      end: '2026-10-14T01:00:00.000Z',
    };
    expect(resolveDrop(overnight, 'resize-end', at('2026-10-14'), 2 * 40, g, Z)).toEqual({
      kind: 'timed',
      start: overnight.start,
      end: '2026-10-14T02:00:00.000Z',
    });
    expect(resolveDrop(overnight, 'resize-end', at('2026-10-15'), 2 * 40, g, Z)).toBeNull();
    expect(resolveDrop(overnight, 'resize-start', at('2026-10-14'), 0, g, Z)).toBeNull();
    // Ending at midnight, the end's day is still the start's.
    const toMidnight = { ...overnight, end: '2026-10-14T00:00:00.000Z' };
    expect(resolveDrop(toMidnight, 'resize-end', at('2026-10-13'), 23 * 40, g, Z)).toEqual({
      kind: 'timed',
      start: overnight.start,
      end: '2026-10-13T23:00:00.000Z',
    });
  });

  it('an all-day range resizes its right edge onto a later day of the band or Month', () => {
    const g = { ms: 0, days: 0 };
    const band = (day: string) => ({ kind: 'allday' as const, day, el: column('allday', day) });
    const cell = (day: string) => ({ kind: 'month' as const, day, el: column('month', day) });
    expect(resolveDrop(allDay, 'resize-end', band('2026-10-17'), 0, g, Z)).toEqual({
      kind: 'all_day',
      startDate: '2026-10-13',
      endDate: '2026-10-18',
    });
    // Back onto its first day: one day long.
    expect(resolveDrop(allDay, 'resize-end', cell('2026-10-13'), 0, g, Z)).toEqual({
      kind: 'all_day',
      startDate: '2026-10-13',
      endDate: '2026-10-14',
    });
    expect(resolveDrop(allDay, 'resize-end', cell('2026-10-12'), 0, g, Z)).toBeNull();
    expect(resolveDrop(allDay, 'resize-start', band('2026-10-17'), 0, g, Z)).toBeNull();
    const col = { kind: 'timed' as const, day: '2026-10-17', el: column('timed', '2026-10-17') };
    expect(resolveDrop(allDay, 'resize-end', col, 0, g, Z)).toBeNull();
  });

  it('all-day spans keep the grabbed day and length; Month drops keep time of day', () => {
    const band = column('allday', '2026-10-14');
    const grab = grabOf(allDay, { kind: 'allday', day: '2026-10-14', el: band }, 0, Z);
    expect(grab.days).toBe(1);
    const target = column('allday', '2026-10-17');
    expect(
      resolveDrop(allDay, 'move', { kind: 'allday', day: '2026-10-17', el: target }, 0, grab, Z)
    ).toEqual({
      kind: 'all_day',
      startDate: '2026-10-16',
      endDate: '2026-10-18',
    });
    const cell = column('month', '2026-10-20');
    expect(
      resolveDrop(
        timed,
        'move',
        { kind: 'month', day: '2026-10-20', el: cell },
        0,
        { ms: 0, days: 0 },
        Z
      )
    ).toEqual({
      kind: 'timed',
      start: '2026-10-20T09:00:00.000Z',
      end: '2026-10-20T10:00:00.000Z',
    });
  });

  it('snaps a timed drop to the step it is given (the zoom’s)', () => {
    const col = column('timed', '2026-10-13');
    const zone = { kind: 'timed' as const, day: '2026-10-13', el: col };
    // 40 px an hour: 9:37 → 9:35 at 5 minutes, 9:37 at 1, 9:30 at the default 15.
    const y = (9 + 37 / 60) * 40;
    const start = (t: ReturnType<typeof resolveDrop>) => (t?.kind === 'timed' ? t.start : null);
    expect(start(resolveDrop(timed, 'move', zone, y, { ms: 0, days: 0 }, Z))).toBe(
      '2026-10-13T09:30:00.000Z'
    );
    expect(start(resolveDrop(timed, 'move', zone, y, { ms: 0, days: 0 }, Z, false, 5))).toBe(
      '2026-10-13T09:35:00.000Z'
    );
    expect(start(resolveDrop(timed, 'move', zone, y, { ms: 0, days: 0 }, Z, false, 1))).toBe(
      '2026-10-13T09:37:00.000Z'
    );
    const resized = resolveDrop(
      timed,
      'resize-end',
      zone,
      (10 + 7 / 60) * 40,
      { ms: 0, days: 0 },
      Z,
      false,
      5
    );
    expect(resized).toEqual({ ...timed, end: '2026-10-13T10:05:00.000Z' });
  });
});
