/**
 * A live countdown to an automation's next wake, next to its date in the
 * pane: "in 2d 3h 15m 08s", leading zero units left out ("in 15m 08s",
 * "in 08s"). Only for an active automation whose next run is ahead (an Every
 * one counts to its next tick); paused, finished, deleted, no next run and a
 * first-open one (no fixed time: it runs when Snaglet first opens) show none. At
 * zero it says "Due now" until the record refreshes (the Running badge and
 * `automations:changed` take over); it never counts below zero. It ticks
 * each second through {@link useNow}, which stops while the window is
 * hidden. Not a live region: its label says the time in words.
 */
import { useState } from 'react';
import type { AutomationRecord } from '@snaglet/shared/types';
import { useNow } from '@desktop/hooks/useNow';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Whole seconds left, rounded up so the count reaches zero when it is due. */
function secondsLeft(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

function units(total: number) {
  return {
    days: Math.floor(total / DAY),
    hours: Math.floor((total % DAY) / HOUR),
    minutes: Math.floor((total % HOUR) / MINUTE),
    seconds: total % MINUTE,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * @public `ms` left as "2d 3h 15m 08s", from its first non-zero unit; seconds,
 * and minutes after the first unit, take two digits. Unit-tested.
 */
export function countdownText(ms: number): string {
  const { days, hours, minutes, seconds } = units(secondsLeft(ms));
  if (days > 0) return `${days}d ${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${pad(seconds)}s`;
}

/** @public "Next run in 2 days 3 hours": the two largest units, in words. Unit-tested. */
export function countdownLabel(ms: number): string {
  const { days, hours, minutes, seconds } = units(secondsLeft(ms));
  const parts: Array<[number, string]> = [
    [days, 'day'],
    [hours, 'hour'],
    [minutes, 'minute'],
    [seconds, 'second'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first < 0) return 'Next run due now';
  const words = parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`);
  return `Next run in ${words.join(' ')}`;
}

export function NextRunCountdown({
  automation: a,
  className,
}: {
  automation: AutomationRecord;
  className?: string;
}) {
  const parsed =
    a.status === 'active' && a.nextRunAt && a.when.kind !== 'first_open'
      ? Date.parse(a.nextRunAt)
      : Number.NaN;
  const target = Number.isFinite(parsed) ? parsed : null;
  // The next run this countdown has seen ahead: reaching it says "Due now",
  // while one already past when it arrives shows nothing.
  const [counted, setCounted] = useState<number | null>(null);
  const [ticking, setTicking] = useState(true);
  const now = useNow(target !== null && ticking);
  const left = target === null ? 0 : target - now;

  if (target !== null && left > 0 && counted !== target) setCounted(target);
  // Nothing changes after zero until the record does, so the clock rests.
  const shouldTick = target !== null && left > 0;
  if (shouldTick !== ticking) setTicking(shouldTick);

  if (target === null || (left <= 0 && counted !== target)) return null;
  return (
    <span role="timer" aria-label={countdownLabel(left)} className={className}>
      {left > 0 ? `in ${countdownText(left)}` : 'Due now'}
    </span>
  );
}
