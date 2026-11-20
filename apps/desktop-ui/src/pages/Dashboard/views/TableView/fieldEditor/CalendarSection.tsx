import { useId, type FC } from 'react';
import { Select } from '@desktop/components';
import { calendarColor, useCalendars } from '@desktop/features/calendar/calendarStore';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import editorStyles from '../TableFieldEditor.module.scss';
import styles from './fieldEditor.module.scss';

const NONE = '';

interface Props {
  /** The calendar shown (draft, else saved; None for a new field). */
  calendarId: string | 'default' | null;
  disabled?: boolean;
  onChange: (calendarId: string | 'default' | null) => void;
}

/**
 * "Show on calendar" for a date field:
 * None by default, saved with the rest of the editor (create or update
 * request). No "End time from": a range's end comes from the field itself
 * (the End date switch).
 */
export const CalendarSection: FC<Props> = ({ calendarId: value, disabled, onChange }) => {
  const selectId = useId();
  // Every calendar; null while loading.
  const { calendars } = useCalendars();
  const active = calendars ?? [];
  const selected =
    value && value !== 'default' ? calendars?.find((c) => c.id === value) : undefined;
  // A bound field whose calendar is not loaded yet keeps its own option.
  const keepsOwn = value && value !== 'default' && !active.some((c) => c.id === value);

  return (
    <div className={styles.section} role="group" aria-label="Calendar">
      <div className={`${editorStyles.control} ${styles.inlineControl}`}>
        <label htmlFor={selectId}>Show on calendar</label>
        <div
          className={styles.swatchRow}
          {...calendarColorProps(selected ? calendarColor(selected) : undefined)}
        >
          <span className={styles.swatch} data-empty={value ? undefined : ''} aria-hidden />
          <Select
            id={selectId}
            size="sm"
            className={editorStyles.typeSelect}
            value={value ?? NONE}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value || null)}
          >
            <option value={NONE}>None</option>
            {active.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.title}
              </option>
            ))}
            {calendars !== null && active.length === 0 && (
              <option value="default">Default calendar (new)</option>
            )}
            {keepsOwn && (
              <option value={value!}>{selected ? selected.title : 'Current calendar'}</option>
            )}
          </Select>
        </div>
      </div>
    </div>
  );
};
