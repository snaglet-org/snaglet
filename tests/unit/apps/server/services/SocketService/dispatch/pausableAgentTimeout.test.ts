/**
 * createPausableAgentTimeout — the per-agent turn timeout that stops the clock
 * while a run is parked on the voice speaking floor (floor-gated
 * generation). Parked time must not be charged against the timeout.
 */

// dispatchToThread pulls a wide server graph; stub the native ONNX addon that
// SIGABRTs jest workers before anything transitively loads it.
jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class MockTensor {},
}));

import { createPausableAgentTimeout } from '@server/services/SocketService/dispatch/dispatchToThread';

describe('createPausableAgentTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves with the wrapped value when it settles in time', async () => {
    const { promise } = createPausableAgentTimeout(Promise.resolve('ok'), 1000, 'A');
    await expect(promise).resolves.toBe('ok');
  });

  it('rejects with a "timed out" message the classifier recognizes', async () => {
    let capture: Error | null = null;
    const { promise } = createPausableAgentTimeout(new Promise<never>(() => {}), 1000, 'Ada');
    promise.catch((e) => (capture = e));
    await jest.advanceTimersByTimeAsync(1001);
    expect(capture).not.toBeNull();
    // handleAgentDispatchError classifies a timeout by `message.includes('timed out')`.
    expect((capture as unknown as Error).message).toContain('timed out');
    expect((capture as unknown as Error).message).toContain('[Ada]');
  });

  it('does not time out while paused, then bank the elapsed time on resume', async () => {
    let settled: 'timeout' | 'pending' = 'pending';
    const { promise, pause, resume } = createPausableAgentTimeout(
      new Promise<never>(() => {}),
      1000,
      'A'
    );
    promise.catch(() => (settled = 'timeout'));

    // 600ms elapse, then the run parks on the floor.
    await jest.advanceTimersByTimeAsync(600);
    pause();
    // A long park (5s) — normally 5× over the deadline, but the clock is frozen.
    await jest.advanceTimersByTimeAsync(5000);
    expect(settled).toBe('pending');

    // Resume: 400ms remained. 399ms → still alive.
    resume();
    await jest.advanceTimersByTimeAsync(399);
    expect(settled).toBe('pending');
    // The final 2ms cross the banked deadline → it times out.
    await jest.advanceTimersByTimeAsync(2);
    expect(settled).toBe('timeout');
  });

  it('is idempotent: double pause / double resume do not corrupt the deadline', async () => {
    let settled: 'timeout' | 'pending' = 'pending';
    const { promise, pause, resume } = createPausableAgentTimeout(
      new Promise<never>(() => {}),
      1000,
      'A'
    );
    promise.catch(() => (settled = 'timeout'));

    await jest.advanceTimersByTimeAsync(500);
    pause();
    pause(); // no-op
    await jest.advanceTimersByTimeAsync(3000);
    resume();
    resume(); // no-op — must not re-bank or double-arm
    await jest.advanceTimersByTimeAsync(499);
    expect(settled).toBe('pending');
    await jest.advanceTimersByTimeAsync(2);
    expect(settled).toBe('timeout');
  });

  it('pause after settle is a harmless no-op', async () => {
    const { promise, pause, resume } = createPausableAgentTimeout(
      Promise.resolve('done'),
      1000,
      'A'
    );
    await expect(promise).resolves.toBe('done');
    expect(() => {
      pause();
      resume();
    }).not.toThrow();
  });

  it('runs onTimeout at expiry, before the wrapper rejects, so the caller can abort the turn', async () => {
    const order: string[] = [];
    const onTimeout = jest.fn(() => order.push('onTimeout'));
    const { promise } = createPausableAgentTimeout(
      new Promise<never>(() => {}),
      1000,
      'A',
      onTimeout
    );
    promise.catch(() => order.push('rejected'));
    await jest.advanceTimersByTimeAsync(1001);
    expect(order).toEqual(['onTimeout', 'rejected']);
  });

  it('does not run onTimeout when the turn settles in time', async () => {
    const onTimeout = jest.fn();
    const { promise } = createPausableAgentTimeout(Promise.resolve('ok'), 1000, 'A', onTimeout);
    await expect(promise).resolves.toBe('ok');
    await jest.advanceTimersByTimeAsync(2000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('timeoutMs 0 = unlimited: never arms a timer, outlives 600s', async () => {
    const onTimeout = jest.fn();
    let resolveTurn: (v: string) => void = () => {};
    const turn = new Promise<string>((r) => (resolveTurn = r));
    const { promise, pause, resume } = createPausableAgentTimeout(turn, 0, 'A', onTimeout);
    expect(jest.getTimerCount()).toBe(0);
    pause();
    resume();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000); // an hour
    expect(onTimeout).not.toHaveBeenCalled();
    resolveTurn('late but fine');
    await expect(promise).resolves.toBe('late but fine');
  });

  it('timeoutMs 0 still propagates the turn rejection (abort path unchanged)', async () => {
    const { promise } = createPausableAgentTimeout(Promise.reject(new Error('aborted')), 0, 'A');
    await expect(promise).rejects.toThrow('aborted');
  });
});
