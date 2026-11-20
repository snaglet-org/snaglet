import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  createStreamIdleWatchdog,
  isProviderStreamStallError,
  ProviderStreamStallError,
} from '@server/services/SocketService/handlers/chatPhases/streamIdleWatchdog';

describe('createStreamIdleWatchdog', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('steady activity keeps the call alive past the idle window', () => {
    const turn = new AbortController();
    const w = createStreamIdleWatchdog(turn.signal, 1000);
    for (let i = 0; i < 20; i++) {
      jest.advanceTimersByTime(900);
      w.touch();
    }
    expect(w.signal.aborted).toBe(false);
    expect(w.stalled()).toBe(false);
    w.dispose();
  });

  it('silence for idleMs aborts the call (not the turn) with a stall error', () => {
    const turn = new AbortController();
    const w = createStreamIdleWatchdog(turn.signal, 5 * 60_000, 'anthropic');
    jest.advanceTimersByTime(5 * 60_000 - 1);
    expect(w.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(w.signal.aborted).toBe(true);
    expect(w.stalled()).toBe(true);
    expect(turn.signal.aborted).toBe(false);
    expect(isProviderStreamStallError(w.signal.reason)).toBe(true);
    expect((w.signal.reason as Error).message).toBe(
      'Model stream stalled: no output from anthropic for 5m; the call was aborted.'
    );
    // The provider's AbortError is mapped to the stall error.
    const mapped = w.translate(new DOMException('aborted', 'AbortError'));
    expect(mapped).toBeInstanceOf(ProviderStreamStallError);
    w.dispose();
  });

  it('turn abort propagates to the call signal and is not reported as a stall', () => {
    const turn = new AbortController();
    const w = createStreamIdleWatchdog(turn.signal, 1000);
    const reason = new Error('stop');
    turn.abort(reason);
    expect(w.signal.aborted).toBe(true);
    expect(w.signal.reason).toBe(reason);
    jest.advanceTimersByTime(5000);
    expect(w.stalled()).toBe(false);
    const err = new DOMException('aborted', 'AbortError');
    expect(w.translate(err)).toBe(err);
    w.dispose();
  });

  it('an already-aborted turn signal aborts the call immediately', () => {
    const turn = new AbortController();
    turn.abort();
    const w = createStreamIdleWatchdog(turn.signal, 1000);
    expect(w.signal.aborted).toBe(true);
    w.dispose();
  });

  it('idleMs 0 disables the watchdog but still links the turn signal', () => {
    const turn = new AbortController();
    const w = createStreamIdleWatchdog(turn.signal, 0);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60 * 60_000);
    expect(w.signal.aborted).toBe(false);
    turn.abort();
    expect(w.signal.aborted).toBe(true);
    w.dispose();
  });

  it('dispose clears the timer and unlinks from the turn', () => {
    const turn = new AbortController();
    const w = createStreamIdleWatchdog(turn.signal, 1000);
    w.dispose();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    turn.abort();
    expect(w.signal.aborted).toBe(false);
    expect(w.stalled()).toBe(false);
  });

  it('non-abort errors pass through translate unchanged when not stalled', () => {
    const turn = new AbortController();
    const w = createStreamIdleWatchdog(turn.signal, 1000);
    const err = new Error('429');
    expect(w.translate(err)).toBe(err);
    w.dispose();
  });
});
