/**
 * The Repeat row of quick add and the event popover: the table date field's
 * "Repeat · Never ›" row and its repeat picker, shared (`RepeatRow`,
 * `RepeatPicker`). Clicking the row swaps the popover's content for the
 * picker, whose Back (or Done) saves and returns. An event repeats on set
 * days only (Custom offers no minutes or hours), and the whole series
 * changes together.
 */
import { useState } from 'react';
import type { CalendarEventRepeat } from '@snaglet/shared/types';
import { createTableRepeat, tableRepeatSummary } from '@snaglet/shared/utils';
import { RepeatPicker } from '@desktop/components/RepeatPicker/RepeatPicker';
import { RepeatRow } from '@desktop/components/RepeatPicker/RepeatRow';

interface EventRepeatControlProps {
  /** The event's start: `YYYY-MM-DD`, or a wall time `YYYY-MM-DDTHH:MM:SS` in `timeZone`. */
  anchor: string;
  timeZone: string;
  value: CalendarEventRepeat | null;
  onChange: (repeat: CalendarEventRepeat | null) => void;
  disabled?: boolean;
}

export function EventRepeatControl({
  anchor,
  timeZone,
  value,
  onChange,
  disabled,
}: EventRepeatControlProps) {
  const [open, setOpen] = useState(false);
  const built = value
    ? createTableRepeat({ date: anchor, rrule: value.rrule, tz: timeZone })
    : null;
  const repeat = built?.ok ? built.value : null;

  if (open) {
    return (
      <RepeatPicker
        nested
        backLabel="Back to the event"
        anchor={anchor}
        repeat={repeat}
        hasEnd
        noInterval
        onClose={() => setOpen(false)}
        onSave={(input) => {
          setOpen(false);
          onChange(input ? { rrule: input.rrule } : null);
        }}
      />
    );
  }
  return (
    <RepeatRow
      value={repeat ? tableRepeatSummary(repeat, { hasEnd: true }) : 'Never'}
      on={Boolean(repeat)}
      disabled={disabled}
      onClick={() => setOpen(true)}
    />
  );
}
