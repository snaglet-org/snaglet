import { describe, expect, it } from '@jest/globals';
import { assertNoArchiveSweep, runArchiveSweep } from '@server/services/ArchiveSweepGuard';

const SWEEP_RUNNING = 'A sweep is running; try again in a moment.';

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('archive sweep guard', () => {
  it('runs one sweep at a time, in the order they started', async () => {
    const order: string[] = [];
    const first = gate();
    const one = runArchiveSweep(async () => {
      order.push('one:start');
      await first.opened;
      order.push('one:end');
    });
    const two = runArchiveSweep(async () => {
      order.push('two');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['one:start']);

    first.open();
    await Promise.all([one, two]);

    expect(order).toEqual(['one:start', 'one:end', 'two']);
  });

  it('refuses restores while a sweep runs or waits, and allows them after', async () => {
    const running = gate();
    const sweep = runArchiveSweep(() => running.opened);

    expect(() => assertNoArchiveSweep()).toThrow(SWEEP_RUNNING);
    running.open();
    await sweep;

    expect(() => assertNoArchiveSweep()).not.toThrow();
  });

  it('releases the guard and the next sweep when a sweep fails', async () => {
    const failed = runArchiveSweep(async () => {
      throw new Error('out of shared memory');
    });
    const next = runArchiveSweep(async () => 'finished');

    await expect(failed).rejects.toThrow('out of shared memory');
    await expect(next).resolves.toBe('finished');
    expect(() => assertNoArchiveSweep()).not.toThrow();
  });
});
