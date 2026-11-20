/**
 * One archive sweep at a time in this process, and no restore while one runs
 * or waits: a sweep drops a large project's tables in transactions of their
 * own before it deletes the project, so a project restored in between would
 * come back without some of them.
 */
import { ConflictError } from '@snaglet/shared/utils';

let sweeps = 0;
let queue: Promise<void> = Promise.resolve();

/** Run `sweep` after every sweep started before it has finished. */
export async function runArchiveSweep<T>(sweep: () => Promise<T>): Promise<T> {
  sweeps += 1;
  const previous = queue;
  let release = () => {};
  queue = new Promise<void>((resolve) => (release = resolve));
  try {
    await previous;
    return await sweep();
  } finally {
    sweeps -= 1;
    release();
  }
}

/** Refuse a restore (409) while a sweep runs or waits. */
export function assertNoArchiveSweep(): void {
  if (sweeps > 0) throw new ConflictError('A sweep is running; try again in a moment.');
}
