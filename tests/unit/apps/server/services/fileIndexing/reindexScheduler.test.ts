import {
  createReindexScheduler,
  startPeriodicSweep,
} from '@server/services/fileIndexing/reindexScheduler';

const MINUTE = 60_000;

describe('startPeriodicSweep', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function sweeps(busy: () => boolean = () => false) {
    return {
      all: jest.fn(async () => undefined),
      gaps: jest.fn(async () => undefined),
      busy,
    };
  }

  it('sweeps every project every 30 minutes and the gap projects every 5 between', async () => {
    const s = sweeps();
    const stop = startPeriodicSweep(s);

    await jest.advanceTimersByTimeAsync(29 * MINUTE);
    expect(s.all).not.toHaveBeenCalled();
    expect(s.gaps).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(1 * MINUTE);
    expect(s.all).toHaveBeenCalledTimes(1);
    expect(s.gaps).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(30 * MINUTE);
    expect(s.all).toHaveBeenCalledTimes(2);
    expect(s.gaps).toHaveBeenCalledTimes(10);
    stop();
  });

  it('never starts on top of a running sweep, and runs a due full sweep on the next free tick', async () => {
    let busy = true;
    const s = sweeps(() => busy);
    const stop = startPeriodicSweep(s);

    await jest.advanceTimersByTimeAsync(30 * MINUTE);
    expect(s.all).not.toHaveBeenCalled();
    expect(s.gaps).not.toHaveBeenCalled();

    busy = false;
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(s.all).toHaveBeenCalledTimes(1);
    expect(s.gaps).not.toHaveBeenCalled();
    stop();
  });

  it('stops sweeping once stopped', async () => {
    const s = sweeps();
    const stop = startPeriodicSweep(s);
    stop();
    await jest.advanceTimersByTimeAsync(60 * MINUTE);
    expect(s.all).not.toHaveBeenCalled();
    expect(s.gaps).not.toHaveBeenCalled();
  });
});

describe('createReindexScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('coalesces a burst for one project into one delayed run', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const scheduler = createReindexScheduler(run, 750);

    scheduler.schedule('route write', 'project-1');
    await jest.advanceTimersByTimeAsync(500);
    scheduler.schedule('config watcher', 'project-1');
    await jest.advanceTimersByTimeAsync(749);
    expect(run).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      label: 'route write + config watcher',
      projectId: 'project-1',
    });
  });

  it('serializes work and safely widens multi-project bursts to a global pass', async () => {
    let finishFirst: (() => void) | undefined;
    const run = jest
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(undefined);
    const scheduler = createReindexScheduler(run, 10);

    scheduler.schedule('first', 'project-1');
    await jest.advanceTimersByTimeAsync(10);
    scheduler.schedule('second', 'project-1');
    scheduler.schedule('third', 'project-2');
    await jest.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith({ label: 'second + third', projectId: undefined });
  });
});
