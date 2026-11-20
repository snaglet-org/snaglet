/**
 * Week / Day zoom and the overview (docs/architecture.md): Ctrl/⌘+wheel and pinch zoom about the pointer, + / − with the
 * grid focused (never ⌘+ / ⌘− / ⌘0), fit and max clamps, snapping that
 * follows the zoom, the remembered zoom, and the overview's window: two-way
 * sync with the grid, drag to pan, edges to zoom, press to center, keys, and
 * its toolbar toggle (off by default, remembered).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import type { Calendar, CalendarIntervalSpan, CalendarOccurrence } from '@snaglet/shared/types';

const api = vi.hoisted(() => ({
  listCalendars: vi.fn(),
  occurrences: vi.fn(),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));
vi.mock('@desktop/features/calendar/calendarApi', () => ({
  calendarApi: api,
  occurrencesSearch: (q: { from: string; to: string }) => `from=${q.from}&to=${q.to}`,
}));
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
const writes = vi.hoisted(() => ({ commitMove: vi.fn() }));
vi.mock('@desktop/features/calendar/occurrenceWrites', async (orig) => ({
  ...(await orig<typeof import('@desktop/features/calendar/occurrenceWrites')>()),
  commitMove: writes.commitMove,
}));
vi.mock('@desktop/features/pane-find/PaneFindContext', () => ({ usePaneIsActive: () => true }));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';
import { zonedToInstant } from '@desktop/features/calendar/calendarDates';

// The real editor mounts TipTap; the description field needs only a text box here.
vi.mock('@desktop/features/rich-markdown/editor', async () => ({
  ChipEditableInput: (
    await import('@desktop/features/rich-markdown/editor/chipEditableInput.testMock')
  ).MockChipEditableInput,
}));

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** The scroller's top on screen, the headers' height and the times' height (layout px). */
const SCROLLER_TOP = 100;
const HEAD = 64;
const VISIBLE = 480;
const DEFAULT = 0.8;

function cal(): Calendar {
  return {
    id: 'cal-default',
    title: 'Default calendar',
    description: '',
    timeZone: ZONE,
    color: 'blue',
    isDefault: true,
    sortOrder: 0,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    boundFields: [],
  } as Calendar;
}

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

/** Wed Oct 14, 2–3 PM: the opening scroll puts 1 PM at the top. */
function review(): CalendarOccurrence {
  return {
    source: 'event',
    key: 'event:r',
    eventId: 'r',
    revision: 1,
    calendarId: 'cal-default',
    title: 'Review',
    time: { kind: 'timed', start: at(14, 14), end: at(14, 15) },
    status: 'upcoming',
    canMove: true,
    canResize: true,
  } as CalendarOccurrence;
}

function every(day: string): CalendarIntervalSpan {
  return {
    key: `automation:automation-1111111111111-aaaaaaaaa:span:${day}`,
    source: 'automation',
    kind: 'interval',
    automationId: 'automation-1111111111111-aaaaaaaaa',
    calendarId: 'cal-default',
    name: 'Check inbox',
    day,
    everyMs: 15 * 60_000,
    startsAt: zonedToInstant('2026-10-13', 9 * 60, ZONE),
    nextRunAt: null,
    agentId: 'test-agent-a',
    agentName: 'Test Agent A',
    threadId: 'thread-1111111111111-aaaaaaaaa',
  };
}

// Layout jsdom doesn't do: the scroller's height and place, the headers above the times.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-calendar-scroll') ? HEAD + VISIBLE : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return /timeBody/.test(this.className) ? HEAD : 0;
    },
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
});

beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z')); // not this week: no now line
  __setCalendarWeekStartForTests(1);
  window.localStorage.clear();
  Object.values(api).forEach((fn) => fn.mockReset());
  writes.commitMove.mockReset().mockResolvedValue(undefined);
  api.listCalendars.mockResolvedValue({ calendars: [cal()] });
  __resetCalendarUndoForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __setCalendarWeekStartForTests(null);
});

/** The pane at `zoom`; the overview strip is on unless `overview` is false. */
async function setup(
  zoom: 'week' | 'day' | 'month' = 'week',
  intervals: CalendarIntervalSpan[] = [],
  overview = true
) {
  api.occurrences.mockResolvedValue({
    from: '',
    to: '',
    occurrences: [review()],
    intervals,
    unavailable: [],
  });
  __resetCalendarStoreForTests({ calendars: [cal()] });
  __resetCalendarViewForTests({ anchor: '2026-10-14', zoom, overview });
  const utils = render(<CalendarView />);
  const scroller = utils.container.querySelector<HTMLElement>('[data-calendar-scroll]')!;
  scroller.getBoundingClientRect = () =>
    ({
      top: SCROLLER_TOP,
      bottom: SCROLLER_TOP + HEAD + VISIBLE,
      height: HEAD + VISIBLE,
      left: 0,
      right: 800,
      width: 0,
    }) as DOMRect;
  // The opening scroll runs as the items draw.
  if (zoom !== 'month') await screen.findByRole('button', { name: /^Review/ });
  return { ...utils, scroller };
}

const scaleOf = (container: HTMLElement) =>
  Number(container.querySelector<HTMLElement>('[role="grid"]')!.dataset.minutePx);
/** The minute at the top of the visible times. */
const topOf = (container: HTMLElement, scroller: HTMLElement) =>
  scroller.scrollTop / scaleOf(container);
const reviewBlock = () =>
  document.querySelector<HTMLElement>('[data-calendar-item][aria-label^="Review"]')!;

describe('zoom gestures', () => {
  it('opens at the default 48 px an hour, an hour before the first item', async () => {
    const { container, scroller } = await setup();
    expect(scaleOf(container)).toBe(DEFAULT);
    expect(scroller.scrollTop).toBe(13 * 60 * DEFAULT);
    expect(reviewBlock().style.top).toBe(`${14 * 60 * DEFAULT}px`);
  });

  it('Ctrl+wheel zooms about the pointer: the time under it stays put', async () => {
    const { container, scroller } = await setup();
    // 240 px down the visible times from 1 PM at 0.8 px a minute: 6 PM.
    const clientY = SCROLLER_TOP + HEAD + 240;
    const minuteUnder = () => topOf(container, scroller) + 240 / scaleOf(container);
    expect(minuteUnder()).toBe(18 * 60);
    const prevented = !fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY });
    expect(prevented).toBe(true);
    expect(scaleOf(container)).toBeGreaterThan(DEFAULT);
    expect(minuteUnder()).toBeCloseTo(18 * 60, 5);
    // Everything that places by time follows the scale.
    expect(reviewBlock().style.top).toBe(`${14 * 60 * scaleOf(container)}px`);
    // ⌘ + wheel too, and out again.
    fireEvent.wheel(scroller, { deltaY: 25, metaKey: true, clientY });
    expect(scaleOf(container)).toBeCloseTo(DEFAULT, 5);
    expect(minuteUnder()).toBeCloseTo(18 * 60, 5);
  });

  it('a plain wheel scrolls as before: no zoom, not prevented', async () => {
    const { container, scroller } = await setup();
    expect(fireEvent.wheel(scroller, { deltaY: 40, clientY: 300 })).toBe(true);
    expect(scaleOf(container)).toBe(DEFAULT);
  });

  it('stops at fit (the whole day in view) and at 12 px a minute', async () => {
    const { container, scroller } = await setup();
    for (let i = 0; i < 20; i++)
      fireEvent.wheel(scroller, { deltaY: 25, ctrlKey: true, clientY: 300 });
    expect(scaleOf(container)).toBeCloseTo(VISIBLE / (24 * 60), 9);
    expect(scroller.scrollTop).toBe(0);
    expect(screen.getByRole('scrollbar', { name: 'Visible hours' })).toHaveAttribute(
      'aria-valuetext',
      '12 AM – 12 AM'
    );
    for (let i = 0; i < 60; i++)
      fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY: 300 });
    expect(scaleOf(container)).toBe(12);
  });

  it('a trackpad pinch (WebKit gesture events) zooms about the pointer, never the page', async () => {
    const { container, scroller } = await setup();
    const gesture = (type: string, scale: number) => {
      const event = new Event(type, { cancelable: true, bubbles: true });
      Object.defineProperties(event, {
        scale: { value: scale },
        clientY: { value: SCROLLER_TOP + HEAD + 240 },
      });
      act(() => {
        scroller.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    expect(gesture('gesturestart', 1)).toBe(true);
    expect(gesture('gesturechange', 2)).toBe(true);
    expect(scaleOf(container)).toBeCloseTo(2 * DEFAULT, 9);
    expect(topOf(container, scroller) + 240 / scaleOf(container)).toBeCloseTo(18 * 60, 5);
    expect(gesture('gestureend', 2)).toBe(true);
  });

  it('+ / − zoom while the grid has focus; ⌘+ / ⌘− / ⌘0 stay the app’s', async () => {
    const { container } = await setup();
    const slot = screen.getByRole('gridcell', { name: 'Wednesday, October 14, 3 PM' });
    slot.focus();
    for (const init of [
      { key: '=', metaKey: true },
      { key: '-', metaKey: true },
      { key: '0', metaKey: true },
      { key: '=', ctrlKey: true },
      { key: '+', ctrlKey: true, shiftKey: true },
    ]) {
      expect(fireEvent.keyDown(slot, init)).toBe(true); // not prevented
    }
    expect(scaleOf(container)).toBe(DEFAULT);
    expect(fireEvent.keyDown(slot, { key: '+', shiftKey: true })).toBe(false);
    expect(scaleOf(container)).toBeCloseTo(DEFAULT * 1.25, 9);
    fireEvent.keyDown(slot, { key: '-' });
    expect(scaleOf(container)).toBeCloseTo(DEFAULT, 9);
    fireEvent.keyDown(slot, { key: '=' });
    expect(scaleOf(container)).toBeCloseTo(DEFAULT * 1.25, 9);
    // Typing in the search box is never a zoom.
    const search = screen.getByRole('searchbox', { name: 'Search this range' });
    search.focus();
    expect(fireEvent.keyDown(search, { key: '-' })).toBe(true);
    expect(scaleOf(container)).toBeCloseTo(DEFAULT * 1.25, 9);
  });

  it('remembers the zoom per viewer (and fit as fit)', async () => {
    window.localStorage.setItem('snaglet.calendar.timeZoom', '4');
    const first = await setup();
    expect(scaleOf(first.container)).toBe(4);
    fireEvent.wheel(first.scroller, { deltaY: -25, ctrlKey: true, clientY: 300 });
    const zoomed = scaleOf(first.container);
    // Written once the zoom settles.
    await waitFor(() =>
      expect(Number(window.localStorage.getItem('snaglet.calendar.timeZoom'))).toBeCloseTo(
        zoomed,
        3
      )
    );
    for (let i = 0; i < 30; i++)
      fireEvent.wheel(first.scroller, { deltaY: 25, ctrlKey: true, clientY: 300 });
    await waitFor(() =>
      expect(window.localStorage.getItem('snaglet.calendar.timeZoom')).toBe('fit')
    );
    first.unmount();
    const second = await setup('week');
    expect(scaleOf(second.container)).toBeCloseTo(VISIBLE / (24 * 60), 9);
  });

  it('renders fine when storage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { container } = await setup();
    expect(scaleOf(container)).toBe(DEFAULT);
    get.mockRestore();
    set.mockRestore();
  });
});

describe('detail follows the zoom', () => {
  /**
   * A sweep pressed `ratio` down the 1 PM cell of Wednesday, released half a
   * minute into 1:52 PM (columns 1 px a minute), opens quick add; its time line.
   */
  async function sweepFromSlotAt(ratio: number) {
    const slot = screen.getByRole('gridcell', { name: 'Wednesday, October 14, 1 PM' });
    slot.getBoundingClientRect = () => ({ top: 0, height: 120, bottom: 120 }) as DOMRect;
    const cols = Array.from(document.querySelectorAll<HTMLElement>('[data-cal-drop="timed"]'));
    cols.forEach((col, i) => {
      col.getBoundingClientRect = () =>
        ({ top: 0, bottom: 1440, height: 1440, left: i * 100, right: i * 100 + 100 }) as DOMRect;
    });
    const end = 13 * 60 + 52.5;
    fireEvent.pointerDown(slot, { button: 0, clientX: 250, clientY: 120 * ratio });
    fireEvent.pointerMove(window, { clientX: 250, clientY: end });
    fireEvent.pointerUp(window, { clientX: 250, clientY: end });
    return screen.findByRole('dialog', { name: 'New event' });
  }

  it('a sweep snaps to 15 minutes at the default zoom', async () => {
    await setup();
    const dialog = await sweepFromSlotAt(0.42);
    expect(within(dialog).getByText('Wed Oct 14, 1:00 – 2:00 PM')).toBeInTheDocument();
  });

  it('to 5 minutes zoomed in, and 1 far in', async () => {
    window.localStorage.setItem('snaglet.calendar.timeZoom', '4');
    const first = await setup();
    let dialog = await sweepFromSlotAt(0.42); // pressed 12.6 minutes in
    expect(within(dialog).getByText('Wed Oct 14, 1:10 – 1:55 PM')).toBeInTheDocument();
    first.unmount();
    window.localStorage.setItem('snaglet.calendar.timeZoom', '11');
    await setup();
    dialog = await sweepFromSlotAt(0.42);
    expect(within(dialog).getByText('Wed Oct 14, 1:12 – 1:53 PM')).toBeInTheDocument();
  });

  it('a drag moves by 5 minutes zoomed in', async () => {
    window.localStorage.setItem('snaglet.calendar.timeZoom', '4');
    await setup();
    const cols = Array.from(document.querySelectorAll<HTMLElement>('[data-cal-drop="timed"]'));
    cols.forEach((col, i) => {
      col.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 1440,
          height: 1440,
          left: i * 100,
          right: i * 100 + 100,
          width: 100,
        }) as DOMRect;
    });
    document.elementsFromPoint = ((x: number) => {
      const col = cols[Math.floor(x / 100)];
      return col ? [col] : [];
    }) as typeof document.elementsFromPoint;
    // Grab at 2:00 PM (y 840 of 1440), drop at 2:22 → 2:20 (5-minute snap).
    fireEvent.pointerDown(reviewBlock(), { button: 0, clientX: 250, clientY: 840 });
    fireEvent.pointerMove(window, { clientX: 256, clientY: 846 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 862 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 862 });
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(1));
    expect(writes.commitMove.mock.calls[0]![1]).toEqual({
      kind: 'timed',
      start: at(14, 14, 20),
      end: at(14, 15, 20),
    });
  });

  it('labels between the hours and finer ticks appear as room allows', async () => {
    const { container, scroller } = await setup();
    const minor = () =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-minor-label]')).map(
        (el) => el.textContent
      );
    expect(minor()).toEqual([]); // hours only at the default
    expect(container.querySelector('[data-tick-step]')).toHaveAttribute('data-tick-step', '15');
    // Zoom to 2 px a minute: 15-minute labels, 5-minute ticks.
    act(() => {
      fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY: 300 });
      fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY: 300 });
      fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY: 300 });
      fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY: 300 });
    });
    expect(scaleOf(container)).toBeGreaterThan(2);
    expect(minor()).toContain('6:15');
    expect(minor()).toContain('6:30');
    expect(minor()).not.toContain('6:00');
    expect(container.querySelector('[data-tick-step]')).toHaveAttribute('data-tick-step', '5');
  });
});

describe('the overview', () => {
  const overview = () => screen.getByRole('complementary', { name: 'Day overview' });
  const windowEl = () => screen.getByRole('scrollbar', { name: 'Visible hours' });
  const pct = (minutes: number) => `${(minutes / 1440) * 100}%`;
  /** The overview's track, 720 px tall on screen (2 minutes a px). */
  function trackLayout() {
    const track = overview().querySelector<HTMLElement>('[data-overview-track]')!;
    track.getBoundingClientRect = () =>
      ({ top: 200, bottom: 920, height: 720, left: 0, right: 60, width: 60 }) as DOMRect;
    return track;
  }

  it('shows each day whole, its blocks and Every lines, and the window over the visible times', async () => {
    await setup('week', [every('2026-10-13'), every('2026-10-14')]);
    expect(overview().querySelectorAll('[data-overview-day]')).toHaveLength(7);
    const wed = overview().querySelector('[data-overview-day="2026-10-14"]')!;
    const block = wed.querySelector<HTMLElement>('[data-overview-block]')!;
    expect(block.style.top).toBe(pct(14 * 60));
    expect(block).toHaveAttribute('data-cal-color', 'blue');
    const tue = overview().querySelector('[data-overview-day="2026-10-13"]')!;
    expect(tue.querySelector<HTMLElement>('[data-overview-line]')!.style.top).toBe(pct(9 * 60));
    // 1 PM, 600 minutes of times at 0.8 px a minute: 1 PM – 11 PM.
    expect(windowEl().style.top).toBe(pct(13 * 60));
    expect(windowEl().style.height).toBe(pct(600));
    expect(windowEl()).toHaveAttribute('aria-valuetext', '1 PM – 11 PM');
    expect(windowEl()).toHaveAttribute(
      'aria-controls',
      screen.getByRole('grid').closest('[data-calendar-scroll]')!.id
    );
  });

  it('Day shows one column; Month has no overview and no toggle', async () => {
    const first = await setup('day');
    expect(overview().querySelectorAll('[data-overview-day]')).toHaveLength(1);
    first.unmount();
    await setup('month');
    expect(screen.queryByRole('complementary', { name: 'Day overview' })).toBeNull();
    expect(screen.queryByRole('button', { name: /overview/i })).toBeNull();
  });

  it('scrolling or zooming the grid moves and resizes the window', async () => {
    const { scroller } = await setup();
    scroller.scrollTop = 8 * 60 * DEFAULT;
    fireEvent.scroll(scroller);
    expect(windowEl().style.top).toBe(pct(8 * 60));
    fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY: SCROLLER_TOP + HEAD });
    // Zoomed about the top: it stays at 8 AM, the window gets shorter.
    expect(parseFloat(windowEl().style.top)).toBeCloseTo((8 * 60 * 100) / 1440, 6);
    expect(parseFloat(windowEl().style.height)).toBeLessThan((600 * 100) / 1440);
  });

  it('dragging the window pans the grid, with no feedback', async () => {
    const { scroller } = await setup();
    trackLayout();
    scroller.scrollTop = 8 * 60 * DEFAULT;
    fireEvent.scroll(scroller);
    // Grab the window (8 AM – 6 PM) and drag it 60 px down: 2 hours later.
    const y = 200 + 8 * 30 + 10;
    fireEvent.pointerDown(windowEl(), { button: 0, clientY: y });
    expect(document.activeElement).toBe(windowEl());
    fireEvent.pointerMove(window, { clientY: y + 60 });
    expect(scroller.scrollTop).toBeCloseTo(10 * 60 * DEFAULT, 6);
    // The grid's scroll event moves the window; the drag goes on from where it began.
    fireEvent.scroll(scroller);
    expect(windowEl().style.top).toBe(pct(10 * 60));
    fireEvent.pointerMove(window, { clientY: y + 120 });
    fireEvent.pointerUp(window, { clientY: y + 120 });
    expect(scroller.scrollTop).toBeCloseTo(12 * 60 * DEFAULT, 6);
    // Past the end it stops at the last screenful (2 PM – midnight).
    fireEvent.pointerDown(windowEl(), { button: 0, clientY: 600 });
    fireEvent.pointerMove(window, { clientY: 2000 });
    fireEvent.pointerUp(window, { clientY: 2000 });
    expect(scroller.scrollTop).toBeCloseTo((24 * 60 - 600) * DEFAULT, 6);
    // After release, moving the pointer does nothing.
    fireEvent.pointerMove(window, { clientY: 200 });
    expect(scroller.scrollTop).toBeCloseTo((24 * 60 - 600) * DEFAULT, 6);
  });

  it('dragging an edge zooms: a smaller window zooms in, the full height is fit', async () => {
    const { container, scroller } = await setup();
    trackLayout();
    const bottom = windowEl().querySelector('[data-overview-edge="bottom"]')!;
    // The window is 1 PM – 11 PM; pull its bottom up to 6 PM: half as long.
    fireEvent.pointerDown(bottom, { button: 0, clientY: 200 + 23 * 30 });
    fireEvent.pointerUp(window, { clientY: 200 + 18 * 30 });
    expect(scaleOf(container)).toBeCloseTo(2 * DEFAULT, 9);
    expect(topOf(container, scroller)).toBeCloseTo(13 * 60, 6);
    // The top edge up to midnight and the bottom down to midnight: fit.
    const top = windowEl().querySelector('[data-overview-edge="top"]')!;
    fireEvent.pointerDown(top, { button: 0, clientY: 200 + 13 * 30 });
    fireEvent.pointerUp(window, { clientY: 200 });
    fireEvent.pointerDown(windowEl().querySelector('[data-overview-edge="bottom"]')!, {
      button: 0,
      clientY: 200 + 18 * 30,
    });
    fireEvent.pointerUp(window, { clientY: 920 });
    expect(scaleOf(container)).toBeCloseTo(VISIBLE / 1440, 9);
    expect(windowEl().className).toMatch(/overviewWindowFit/);
  });

  it('pressing outside the window centers the view there', async () => {
    const { container, scroller } = await setup();
    trackLayout();
    // 5 AM: 150 px down the track. The view is 10 hours long: midnight – 10 AM.
    const day = overview().querySelector<HTMLElement>('[data-overview-day="2026-10-13"]')!;
    fireEvent.pointerDown(day, { button: 0, clientY: 200 + 150 });
    fireEvent.pointerUp(window, { clientY: 200 + 150 });
    expect(topOf(container, scroller)).toBeCloseTo(0, 6);
    fireEvent.pointerDown(day, { button: 0, clientY: 200 + 360 }); // noon
    fireEvent.pointerUp(window, { clientY: 200 + 360 });
    expect(topOf(container, scroller)).toBeCloseTo(7 * 60, 6);
    expect(scaleOf(container)).toBe(DEFAULT);
  });

  it('the window is a focusable scrollbar: arrows pan, Shift+arrows zoom', async () => {
    const { container, scroller } = await setup();
    const w = windowEl();
    w.focus();
    expect(w).toHaveAttribute('tabindex', '0');
    expect(w).toHaveAttribute('aria-orientation', 'vertical');
    fireEvent.keyDown(w, { key: 'ArrowUp' });
    expect(topOf(container, scroller)).toBeCloseTo(12 * 60, 6); // an hour (a quarter screen, at most 60)
    fireEvent.keyDown(w, { key: 'ArrowDown' });
    fireEvent.keyDown(w, { key: 'ArrowDown' });
    expect(topOf(container, scroller)).toBeCloseTo(14 * 60, 6);
    fireEvent.keyDown(w, { key: 'Home' });
    expect(topOf(container, scroller)).toBe(0);
    fireEvent.keyDown(w, { key: 'PageDown' });
    expect(topOf(container, scroller)).toBeCloseTo(600, 6);
    fireEvent.keyDown(w, { key: 'End' });
    expect(topOf(container, scroller)).toBeCloseTo(24 * 60 - 600, 6);
    expect(w).toHaveAttribute('aria-valuenow', '100');
    fireEvent.keyDown(w, { key: 'ArrowUp', shiftKey: true });
    expect(scaleOf(container)).toBeCloseTo(DEFAULT * 1.25, 9);
    fireEvent.keyDown(w, { key: 'ArrowDown', shiftKey: true });
    expect(scaleOf(container)).toBeCloseTo(DEFAULT, 9);
    // ⌘ / Ctrl combos are left alone; + / − work here too.
    expect(fireEvent.keyDown(w, { key: 'ArrowUp', metaKey: true })).toBe(true);
    fireEvent.keyDown(w, { key: '+' });
    expect(scaleOf(container)).toBeCloseTo(DEFAULT * 1.25, 9);
  });

  it('a wheel over it scrolls the grid; Ctrl+wheel zooms', async () => {
    const { container, scroller } = await setup();
    expect(fireEvent.wheel(overview(), { deltaY: 48 })).toBe(false);
    expect(topOf(container, scroller)).toBeCloseTo(13 * 60 + 60, 6);
    fireEvent.wheel(overview(), { deltaY: -25, ctrlKey: true });
    expect(scaleOf(container)).toBeGreaterThan(DEFAULT);
  });

  it('is off by default; the toolbar Overview button shows and hides it, remembered', async () => {
    window.localStorage.removeItem('snaglet.calendar.view');
    const first = await setup('week', [], false);
    const toggle = screen.getByRole('button', { name: 'Overview' });
    // Off: no strip, and no room kept for it.
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('complementary', { name: 'Day overview' })).toBeNull();
    expect(document.querySelector('[data-time-overview]')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAttribute('aria-controls', overview().id);
    expect(JSON.parse(window.localStorage.getItem('snaglet.calendar.view')!)).toMatchObject({
      overview: true,
    });
    first.unmount();

    // Day keeps it on (one preference for both).
    await setup('day', [], true);
    expect(overview()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.queryByRole('complementary', { name: 'Day overview' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('snaglet.calendar.view')!)).toMatchObject({
      overview: false,
    });
  });
});
