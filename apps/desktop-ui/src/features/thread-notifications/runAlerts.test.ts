/**
 * The two decisions a window makes about a run-ended alert:
 * "am I already watching this thread?" and "did another window already take
 * this alert?".
 */
import { describe, expect, it } from 'vitest';
import {
  RUN_ALERT_CLAIM_TTL_MS,
  claimRunAlert,
  isWatchingThread,
  type RunAlertClaimStore,
} from './runAlerts';

const THREAD = 'thread-1111111111111-aaaaaaaaa';
const OTHER = 'thread-2222222222222-bbbbbbbbb';

/** An in-memory stand-in for one window's localStorage. */
function fakeStore(initial: Record<string, string> = {}): RunAlertClaimStore {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe('isWatchingThread', () => {
  it('is true only for the focused window showing that exact thread', () => {
    expect(
      isWatchingThread({ threadId: THREAD, activeThreadId: THREAD, windowFocused: true })
    ).toBe(true);
  });

  it('is false when the window is not focused, even on that thread', () => {
    expect(
      isWatchingThread({ threadId: THREAD, activeThreadId: THREAD, windowFocused: false })
    ).toBe(false);
  });

  it('is false when the active pane shows another thread', () => {
    expect(isWatchingThread({ threadId: THREAD, activeThreadId: OTHER, windowFocused: true })).toBe(
      false
    );
  });

  it('is false when no thread is active (a doc, the Calendar, nothing)', () => {
    expect(isWatchingThread({ threadId: THREAD, activeThreadId: null, windowFocused: true })).toBe(
      false
    );
  });
});

describe('claimRunAlert', () => {
  it('lets the first caller through and refuses the second for the same run', () => {
    const store = fakeStore();
    expect(claimRunAlert('run-1', store, 1_000)).toBe(true);
    expect(claimRunAlert('run-1', store, 1_001)).toBe(false);
  });

  it('keeps claims per run, so a second run still alerts', () => {
    const store = fakeStore();
    expect(claimRunAlert('run-1', store, 1_000)).toBe(true);
    expect(claimRunAlert('run-2', store, 1_000)).toBe(true);
  });

  it('takes over a claim older than the TTL, so a stale key never silences a run', () => {
    const store = fakeStore();
    expect(claimRunAlert('run-1', store, 1_000)).toBe(true);
    expect(claimRunAlert('run-1', store, 1_000 + RUN_ALERT_CLAIM_TTL_MS - 1)).toBe(false);
    expect(claimRunAlert('run-1', store, 1_000 + RUN_ALERT_CLAIM_TTL_MS)).toBe(true);
  });

  it('alerts rather than going silent when there is no usable storage', () => {
    expect(claimRunAlert('run-1', null, 1_000)).toBe(true);
    expect(claimRunAlert('run-1', undefined, 1_000)).toBe(true);
    const throwing: RunAlertClaimStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(claimRunAlert('run-1', throwing, 1_000)).toBe(true);
  });

  it('ignores a corrupt claim value', () => {
    const store = fakeStore({ 'snaglet.runAlert.run-1': 'not-a-number' });
    expect(claimRunAlert('run-1', store, 1_000)).toBe(true);
  });
});
