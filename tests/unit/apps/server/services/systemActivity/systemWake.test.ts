/**
 * SystemWakeMonitor with a fake clock: the start is an activation; a note
 * far later than one heartbeat is a wake (its listeners hear of it and it
 * becomes the activation); a normal beat, a clock set back and a stopped
 * monitor are not. The heartbeat itself notices a sleep with no tick.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { SystemWakeMonitor } from '@server/services/systemActivity/systemWake';

const T0 = Date.parse('2026-10-13T12:00:00.000Z');

function monitorAt(start: number) {
  let now = start;
  const monitor = new SystemWakeMonitor({ now: () => now, heartbeatMs: 10_000, gapMs: 30_000 });
  return {
    monitor,
    set: (at: number) => {
      now = at;
    },
  };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('SystemWakeMonitor', () => {
  it('has no activation before it starts, and the start is one', () => {
    const { monitor } = monitorAt(T0);
    expect(monitor.lastActivation()).toBeNull();
    expect(monitor.check(T0 + 3_600_000)).toBe(false);
    monitor.start();
    expect(monitor.lastActivation()).toEqual({ at: T0, reason: 'start' });
    monitor.stop();
    expect(monitor.lastActivation()).toBeNull();
  });

  it('reads a gap far longer than a beat as a wake and tells its listeners', () => {
    const { monitor } = monitorAt(T0);
    const heard = jest.fn();
    const off = monitor.onWake(heard);
    monitor.start();
    // Beats on time (and a little late) are no wake.
    expect(monitor.check(T0 + 10_000)).toBe(false);
    expect(monitor.check(T0 + 45_000)).toBe(false);
    expect(heard).not.toHaveBeenCalled();
    // Eight hours asleep.
    const woke = T0 + 45_000 + 8 * 3_600_000;
    expect(monitor.check(woke)).toBe(true);
    expect(heard).toHaveBeenCalledWith({ at: woke, sleptMs: 8 * 3_600_000 });
    expect(monitor.lastActivation()).toEqual({ at: woke, reason: 'wake' });
    // The next beat is a normal one again.
    expect(monitor.check(woke + 10_000)).toBe(false);
    off();
    expect(monitor.check(woke + 10_000 + 3_600_000)).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('does not read a clock set back as a wake', () => {
    const { monitor } = monitorAt(T0);
    monitor.start();
    expect(monitor.check(T0 - 3_600_000)).toBe(false);
    expect(monitor.check(T0 - 3_600_000 + 10_000)).toBe(false);
    expect(monitor.lastActivation()).toEqual({ at: T0, reason: 'start' });
    monitor.stop();
  });

  it('keeps going when a listener throws', () => {
    const { monitor } = monitorAt(T0);
    const after = jest.fn();
    monitor.onWake(() => {
      throw new Error('listener broke');
    });
    monitor.onWake(after);
    monitor.start();
    expect(monitor.check(T0 + 3_600_000)).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('notices a sleep on its own heartbeat', () => {
    jest.useFakeTimers({ now: T0 });
    const monitor = new SystemWakeMonitor({ heartbeatMs: 10_000, gapMs: 30_000 });
    const heard = jest.fn();
    monitor.onWake(heard);
    monitor.start();
    jest.advanceTimersByTime(10_000);
    expect(heard).not.toHaveBeenCalled();
    // The machine sleeps: the wall clock jumps, the timers do not run.
    jest.setSystemTime(Date.now() + 2 * 3_600_000);
    jest.advanceTimersByTime(10_000);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(monitor.lastActivation()?.reason).toBe('wake');
    monitor.stop();
  });
});
