import type { FC } from 'react';
import { calendarColor, useCalendars } from '@desktop/features/calendar/calendarStore';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import styles from './ColumnCalendarDot.module.scss';

/**
 * The small dot on a date field's column header when the field is shown on a
 * calendar ("Shown on Work"), in that calendar's color token. Mounted only
 * for bound fields, so tables without a calendar never load the calendars.
 */
export const ColumnCalendarDot: FC<{ calendarId: string }> = ({ calendarId }) => {
  const { calendars } = useCalendars();
  const calendar = calendars?.find((c) => c.id === calendarId);
  const label = calendar ? `Shown on ${calendar.title}` : 'Shown on a calendar';
  return (
    <span
      className={styles.dot}
      {...calendarColorProps(calendar ? calendarColor(calendar) : undefined)}
      role="img"
      aria-label={label}
      title={label}
    />
  );
};
