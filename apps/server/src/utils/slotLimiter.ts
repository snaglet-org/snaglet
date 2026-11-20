/**
 * A runner that lets at most `max` tasks run at once; the rest wait in arrival
 * order. A finished or failed task hands its slot straight to the next waiter.
 */
export function createSlotLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active += 1;
    } else {
      // The finishing task hands its slot over, so the count stays put.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
