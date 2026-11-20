/**
 * IdleUnloader — the timer + race-safety primitive shared by
 * LocalEmbedderService and LocalRerankerService's idle-unload paths. Tested
 * in isolation (fake timers, no ONNX/DB) since it's pure timing + ordering
 * logic; the two services' own tests cover the wiring on top of it.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { IdleUnloader } from '@server/services/localModels/idleUnload';

describe('IdleUnloader', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not fire onIdle before the threshold', () => {
    const onIdle = jest.fn(() => Promise.resolve());
    const unloader = new IdleUnloader(() => 1000, onIdle);

    unloader.touch();
    jest.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('fires onIdle once the threshold elapses with no further touch()', () => {
    const onIdle = jest.fn(() => Promise.resolve());
    const unloader = new IdleUnloader(() => 1000, onIdle);

    unloader.touch();
    jest.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('touch() reschedules — repeated activity keeps deferring the unload', () => {
    const onIdle = jest.fn(() => Promise.resolve());
    const unloader = new IdleUnloader(() => 1000, onIdle);

    unloader.touch();
    jest.advanceTimersByTime(700);
    unloader.touch(); // activity resets the clock
    jest.advanceTimersByTime(700);
    expect(onIdle).not.toHaveBeenCalled(); // only 700ms since the last touch
    jest.advanceTimersByTime(300);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('reads the idle threshold per-call (env-style override without restart)', () => {
    const onIdle = jest.fn(() => Promise.resolve());
    let ms = 1000;
    const unloader = new IdleUnloader(() => ms, onIdle);

    unloader.touch();
    ms = 50; // simulate an env override taking effect
    unloader.touch(); // reschedule reads the new threshold
    jest.advanceTimersByTime(50);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('cancel() prevents a pending unload from firing', () => {
    const onIdle = jest.fn(() => Promise.resolve());
    const unloader = new IdleUnloader(() => 1000, onIdle);

    unloader.touch();
    unloader.cancel();
    jest.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('race safety: awaitInFlightDispose() resolves immediately when nothing is disposing', async () => {
    const unloader = new IdleUnloader(
      () => 1000,
      () => Promise.resolve()
    );
    await expect(unloader.awaitInFlightDispose()).resolves.toBeUndefined();
  });

  it('race safety: a call arriving mid-dispose waits for the in-flight unload to finish', async () => {
    jest.useRealTimers(); // real microtask ordering — the race is about promise timing, not the setTimeout clock

    let resolveDispose: () => void = () => {};
    const disposeStarted = jest.fn();
    const onIdle = jest.fn(() => {
      disposeStarted();
      return new Promise<void>((resolve) => {
        resolveDispose = resolve;
      });
    });
    const unloader = new IdleUnloader(() => 5, onIdle);

    unloader.touch();
    // Wait for the real setTimeout(5ms) to fire and start the dispose.
    await new Promise((r) => setTimeout(r, 20));
    expect(disposeStarted).toHaveBeenCalledTimes(1);

    // A "call" arriving mid-dispose: awaitInFlightDispose() must not resolve
    // until the in-flight onIdle() promise settles.
    let waiterResolved = false;
    const waiter = unloader.awaitInFlightDispose().then(() => {
      waiterResolved = true;
    });

    // Give the microtask queue a beat — the waiter must still be pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(waiterResolved).toBe(false);

    resolveDispose();
    await waiter;
    expect(waiterResolved).toBe(true);
  });
});
