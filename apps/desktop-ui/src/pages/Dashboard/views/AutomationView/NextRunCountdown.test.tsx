/**
 * The pane's countdown to the next wake: its text at each unit threshold,
 * its label in words, ticking each second (and resting while the window is
 * hidden), the states that show none, and "Due now" at zero.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRecord } from '@snaglet/shared/types';
import { automationRecord } from '@desktop/features/automations/testFixtures';
import { countdownLabel, countdownText, NextRunCountdown } from './NextRunCountdown';

const NOW = Date.parse('2026-10-14T08:00:00.000Z');
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

const inFuture = (ms: number) => new Date(NOW + ms).toISOString();
const at = (ms: number, over: Partial<AutomationRecord> = {}) =>
  automationRecord({ nextRunAt: inFuture(ms), ...over });

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const timer = () => screen.queryByRole('timer');
const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('countdownText', () => {
  it('starts at the first unit that is not zero', () => {
    expect(countdownText(2 * D + 3 * H + 15 * M + 8 * S)).toBe('2d 3h 15m 08s');
    expect(countdownText(3 * H + 15 * M + 8 * S)).toBe('3h 15m 08s');
    expect(countdownText(15 * M + 8 * S)).toBe('15m 08s');
    expect(countdownText(8 * S)).toBe('08s');
  });

  it('pads seconds always and minutes after the first unit, keeping inner zeros', () => {
    expect(countdownText(2 * D + 5 * S)).toBe('2d 0h 00m 05s');
    expect(countdownText(1 * H + 5 * M)).toBe('1h 05m 00s');
    expect(countdownText(5 * M)).toBe('5m 00s');
    expect(countdownText(D - S)).toBe('23h 59m 59s');
    expect(countdownText(H)).toBe('1h 00m 00s');
  });

  it('rounds up to whole seconds and never goes below zero', () => {
    expect(countdownText(999)).toBe('01s');
    expect(countdownText(59 * S + 1)).toBe('1m 00s');
    expect(countdownText(0)).toBe('00s');
    expect(countdownText(-5 * S)).toBe('00s');
  });
});

describe('countdownLabel', () => {
  it('says the two largest units in words', () => {
    expect(countdownLabel(2 * D + 3 * H + 15 * M)).toBe('Next run in 2 days 3 hours');
    expect(countdownLabel(1 * H + 1 * M + 8 * S)).toBe('Next run in 1 hour 1 minute');
    expect(countdownLabel(2 * D + 5 * M)).toBe('Next run in 2 days');
    expect(countdownLabel(15 * M + 8 * S)).toBe('Next run in 15 minutes 8 seconds');
    expect(countdownLabel(1 * S)).toBe('Next run in 1 second');
    expect(countdownLabel(0)).toBe('Next run due now');
  });
});

describe('NextRunCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('ticks each second, then says Due now at zero and stays there', () => {
    render(<NextRunCountdown automation={at(65 * S)} />);
    expect(timer()).toHaveTextContent('in 1m 05s');
    expect(timer()).toHaveAccessibleName('Next run in 1 minute 5 seconds');
    // Not a live region: the ticks are not announced.
    expect(timer()).not.toHaveAttribute('aria-live');

    tick(S);
    expect(timer()).toHaveTextContent('in 1m 04s');
    tick(5 * S);
    expect(timer()).toHaveTextContent('in 59s');
    tick(59 * S);
    expect(timer()).toHaveTextContent('Due now');
    expect(timer()).toHaveAccessibleName('Next run due now');
    // Nothing changes until the record does, so the clock rests.
    expect(vi.getTimerCount()).toBe(0);
    tick(10 * S);
    expect(timer()).toHaveTextContent('Due now');
  });

  it('counts again once the refreshed record has a new next run', () => {
    const { rerender } = render(<NextRunCountdown automation={at(2 * S)} />);
    tick(2 * S);
    expect(timer()).toHaveTextContent('Due now');
    rerender(<NextRunCountdown automation={at(2 * S + 3 * H)} />);
    expect(timer()).toHaveTextContent('in 3h 00m 00s');
    tick(S);
    expect(timer()).toHaveTextContent('in 2h 59m 59s');
  });

  it('counts an Every automation down to its next tick', () => {
    render(
      <NextRunCountdown
        automation={at(14 * M, {
          when: { kind: 'interval', everyMs: 15 * M, tz: 'UTC' },
          whenText: 'every 15 minutes',
        })}
      />
    );
    expect(timer()).toHaveTextContent('in 14m 00s');
  });

  it.each([
    ['paused', { status: 'paused' as const, pausedReason: 'user' as const }],
    ['finished', { status: 'finished' as const }],
    ['deleted', { status: 'cancelled' as const }],
    [
      'it runs when Snaglet first opens (no fixed time)',
      {
        when: { kind: 'first_open' as const, after: '05:00', tz: 'UTC' },
        whenText: 'when Snaglet first opens, after 5:00 AM',
      },
    ],
  ])('shows none when %s', (_name, over) => {
    render(<NextRunCountdown automation={at(H, over)} />);
    expect(timer()).toBeNull();
  });

  it('shows none with no next run, or one already past when it arrives', () => {
    const { rerender } = render(
      <NextRunCountdown automation={automationRecord({ nextRunAt: null })} />
    );
    expect(timer()).toBeNull();
    rerender(<NextRunCountdown automation={at(-M)} />);
    expect(timer()).toBeNull();
  });

  it('rests while the window is hidden and catches up when it is shown', () => {
    render(<NextRunCountdown automation={at(10 * M)} />);
    expect(timer()).toHaveTextContent('in 10m 00s');
    setVisibility('hidden');
    tick(5 * S);
    expect(timer()).toHaveTextContent('in 10m 00s');
    setVisibility('visible');
    expect(timer()).toHaveTextContent('in 9m 55s');
    tick(S);
    expect(timer()).toHaveTextContent('in 9m 54s');
  });

  it('stops its clock when it unmounts', () => {
    const { unmount } = render(<NextRunCountdown automation={at(H)} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
