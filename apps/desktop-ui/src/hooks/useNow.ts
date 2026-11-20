import { useEffect, useState } from 'react';

/**
 * A clock (`Date.now()`) that ticks every `intervalMs` while `active`, on
 * wall-clock boundaries (every whole second by default) rather than at the
 * offset the hook happened to mount at, so a seconds countdown neither skips
 * nor repeats a second. Each tick is scheduled from the clock itself, so a late
 * tick does not push the later ones off the boundary. It stops while the window is hidden (another app or tab in front) and catches
 * up the moment it is shown again; unmounting or going inactive stops it.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      // Time left to the next multiple of the interval (a full interval when
      // exactly on one).
      const wait = intervalMs - (Date.now() % intervalMs);
      timer = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, wait);
    };
    const start = () => {
      stop();
      if (document.visibilityState === 'hidden') return;
      setNow(Date.now());
      schedule();
    };
    start();
    document.addEventListener('visibilitychange', start);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', start);
    };
  }, [active, intervalMs]);
  return now;
}
