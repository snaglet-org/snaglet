import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tableDateTimeToUtc, userTimeZone } from '@snaglet/shared/utils';
import { Button, DateInput } from '@desktop/components';
import { useAnchoredPosition, useDismissable } from '@desktop/components/Popover';
import styles from './PauseUntilPopover.module.scss';

const QUARTER_HOUR_MS = 15 * 60_000;

/** `date` as a datetime-local value ("YYYY-MM-DDTHH:MM") in `timeZone`. */
export function toDateTimeLocal(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** An hour from now, rounded up to the quarter hour: a sensible first pick. */
function defaultPauseUntil(now: Date, timeZone: string): string {
  const at = Math.ceil((now.getTime() + 60 * 60_000) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  return toDateTimeLocal(new Date(at), timeZone);
}

export interface PauseUntilPopoverProps {
  anchor: HTMLElement;
  name: string;
  /** The chosen time, as an ISO instant. */
  onPause: (untilIso: string) => void;
  onCancel: () => void;
  /** The viewer's zone unless a test pins one. */
  timeZone?: string;
}

/**
 * "Pause until…" from a helper's chip menu: a date and time in the viewer's
 * zone; Enter or Pause commits. Escape or a press outside cancels, and focus
 * goes back to the chip's menu button.
 */
export function PauseUntilPopover({
  anchor,
  name,
  onPause,
  onCancel,
  timeZone = userTimeZone(),
}: PauseUntilPopoverProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { position } = useAnchoredPosition({ anchor, surfaceRef, width: 260 });
  const dismissProps = useDismissable({ open: true, onDismiss: onCancel, surfaceRef });
  const [value, setValue] = useState(() => defaultPauseUntil(new Date(), timeZone));
  const utc = value ? tableDateTimeToUtc(value, timeZone) : null;
  const until = utc === null ? Number.NaN : Date.parse(utc);
  const valid = Number.isFinite(until) && until > Date.now();

  const placed = position !== null;
  useEffect(() => {
    if (placed) inputRef.current?.focus({ preventScroll: true });
  }, [placed]);

  // Back to the opener when the surface closes with focus inside it.
  const returnTo = useRef(anchor);
  returnTo.current = anchor;
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        if (returnTo.current.isConnected) returnTo.current.focus({ preventScroll: true });
      }
    },
    []
  );

  return createPortal(
    <div
      ref={surfaceRef}
      role="dialog"
      aria-label={`Pause ${name} until`}
      className={styles.surface}
      style={position ?? { position: 'fixed', visibility: 'hidden', width: 260 }}
      {...dismissProps}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onPause(new Date(until).toISOString());
        }}
      >
        <p className={styles.title}>
          Pause <strong>{name}</strong> until
        </p>
        <DateInput
          ref={inputRef}
          type="datetime-local"
          required
          aria-label="Resume at"
          value={value}
          onChange={setValue}
          size="sm"
          fullWidth
        />
        <div className={styles.footer}>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!valid}>
            Pause
          </Button>
        </div>
      </form>
    </div>,
    document.body
  );
}
