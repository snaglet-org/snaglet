/**
 * Which calendar an automation shows on, whatever its timing (an Every one
 * as a line down each day): the calendar popovers' searchable picker
 * ({@link SearchSelect}) with "No calendar" on top, then the
 * calendars, each with its color dot. Deletion disconnects calendar placement.
 * With no calendar at all (the list loaded, not failed) it offers "Default
 * calendar (new)", reported as undefined: a create leaves it to the server,
 * an edit or a move makes it through `calendarIdForPick`.
 */
import type { Calendar } from '@snaglet/shared/types';
import { calendarColor, useCalendars } from '@desktop/features/calendar/calendarStore';
import { SearchSelect, type SearchSelectOption } from '@desktop/features/calendar/SearchSelect';
import styles from './AutomationCalendarPicker.module.scss';

/** The automation's calendar as its record names it: shown before the list loads. */
interface AutomationCalendarRef {
  id: string;
  title: string | null;
}

/** The "No calendar" option's value; never a calendar id. */
const NO_CALENDAR = '(none)';

const NO_CALENDAR_OPTION: SearchSelectOption = {
  value: NO_CALENDAR,
  label: 'No calendar',
  muted: true,
};

function calendarOptions(
  all: readonly Calendar[],
  current: AutomationCalendarRef | null,
  loaded: boolean
): SearchSelectOption[] {
  const options: SearchSelectOption[] = all.map((c) => ({
    value: c.id,
    label: c.title,
    color: calendarColor(c),
  }));
  if (current && !options.some((o) => o.value === current.id)) {
    const known = all.find((c) => c.id === current.id);
    options.push({
      value: current.id,
      label: known?.title ?? current.title ?? 'Calendar',
      ...(known ? { color: calendarColor(known) } : {}),
    });
  }
  // An empty catalog (loaded, not failed) makes a Default calendar on save.
  if (loaded && options.length === 0)
    options.push({ value: '', label: 'Default calendar (new)', color: 'gray' });
  return [NO_CALENDAR_OPTION, ...options];
}

const defaultCalendarId = (all: readonly Calendar[]): string | null =>
  all.find((c) => c.isDefault)?.id ?? null;

/** Every calendar and the Default one's id; `loaded` once the list is in and its last read didn't fail. */
export function useAutomationCalendars(): {
  calendars: Calendar[];
  defaultId: string | null;
  loaded: boolean;
} {
  const { calendars, error } = useCalendars();
  const all = calendars ?? [];
  return {
    calendars: all,
    defaultId: defaultCalendarId(all),
    loaded: calendars !== null && !error,
  };
}

interface AutomationCalendarPickerProps {
  /**
   * The chosen calendar; null = No calendar; undefined = the Default one (as
   * the server picks it); '' = "Default calendar (new)", picked from an empty list.
   */
  value: string | null | undefined;
  /** A calendar's id, null for No calendar, or undefined for "Default calendar (new)". */
  onChange: (calendarId: string | null | undefined) => void;
  calendars: readonly Calendar[];
  loaded?: boolean;
  current?: AutomationCalendarRef | null;
  disabled?: boolean;
}

export function AutomationCalendarPicker({
  value,
  onChange,
  calendars,
  current = null,
  loaded = true,
  disabled,
}: AutomationCalendarPickerProps) {
  return (
    <span className={styles.picker}>
      <SearchSelect
        label="Calendar"
        value={value === null ? NO_CALENDAR : (value ?? defaultCalendarId(calendars) ?? '')}
        options={calendarOptions(calendars, current, loaded)}
        searchPlaceholder="Search calendars"
        emptyText="No calendars match"
        disabled={disabled}
        onChange={(next) => onChange(next === NO_CALENDAR ? null : next || undefined)}
      />
    </span>
  );
}

/** The New / Edit form field: a label, then the picker (for any timing, Every included). */
export function AutomationCalendarField(picker: AutomationCalendarPickerProps) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>Calendar</span>
      <AutomationCalendarPicker {...picker} />
    </div>
  );
}
