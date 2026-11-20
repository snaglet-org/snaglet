import { describe, expect, it } from '@jest/globals';
import { createSlotLimiter } from '@server/utils/slotLimiter';

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('createSlotLimiter', () => {
  it.each([1, 2])('never runs more than %d task(s) at once', async (limit) => {
    const run = createSlotLimiter(limit);
    let running = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const tasks = gates.map((gate, index) =>
      run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
        return index;
      })
    );

    await settle();
    expect(running).toBe(limit);
    for (const gate of gates) {
      gate.resolve();
      await settle();
    }

    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(limit);
  });

  it('hands the slot to the next task when a task throws', async () => {
    const run = createSlotLimiter(1);
    const gate = deferred();
    const failing = run(async () => {
      await gate.promise;
    });
    let nextStarted = false;
    const next = run(async () => {
      nextStarted = true;
      return 'ran';
    });

    await settle();
    expect(nextStarted).toBe(false);
    gate.reject(new Error('out of memory'));

    await expect(failing).rejects.toThrow('out of memory');
    await expect(next).resolves.toBe('ran');
    await expect(run(async () => 'later')).resolves.toBe('later');
  });
});
