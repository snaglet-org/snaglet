/**
 * The Calendar and Table field pickers of quick add and the event popover.
 * Calendar lists the calendars with their color dots. Table field lists only
 * the date fields bound to the chosen calendar, labeled like the sidebar
 * ("tasks · due"), after **None (plain event)**, the default: picking one
 * makes the item a row of that table instead of an event.
 */
import type { Calendar } from '@snaglet/shared/types';
import { calendarColor } from './calendarStore';
import { targetLabel, type RowTarget } from './rowCreate';
import { SearchSelect, type SearchSelectOption } from './SearchSelect';
import styles from './CalendarPopovers.module.scss';

const PLAIN_EVENT_LABEL = 'None (plain event)';

/** Snaglet's own columns (`created_at`) carry this id prefix; Snaglet sets their values. */
const MANAGED_FIELD_ID = 'field-managed-';

/**
 * The fields a row can be made in on `calendar`: its bound date fields,
 * leaving out managed ones (a calendar may show `created_at`, but nobody
 * writes it). The create re-checks against the table's live fields.
 */
function rowTargetsOf(calendar: Calendar | undefined): RowTarget[] {
  const bound = (calendar?.boundFields ?? []).filter(
    (f) => !f.fieldId.startsWith(MANAGED_FIELD_ID)
  );
  return bound.map((f) => ({
    tableId: f.tableId,
    tableName: f.tableName,
    fieldId: f.fieldId,
    fieldName: f.fieldName,
    fieldType: f.fieldType,
  }));
}

/** `target` when it is bound to `calendar`, else null (None). */
export function keepTargetOn(
  calendar: Calendar | undefined,
  target: RowTarget | null
): RowTarget | null {
  if (!target) return null;
  return rowTargetsOf(calendar).find((t) => t.fieldId === target.fieldId) ?? null;
}

function calendarOptions(calendars: readonly Calendar[]): SearchSelectOption[] {
  return calendars.map((c) => ({ value: c.id, label: c.title, color: calendarColor(c) }));
}

function fieldOptions(calendar: Calendar | undefined): SearchSelectOption[] {
  return [
    { value: '', label: PLAIN_EVENT_LABEL },
    ...rowTargetsOf(calendar).map((t) => ({
      value: t.fieldId,
      label: targetLabel(t),
      detail: t.fieldType === 'date' ? 'Date' : 'Date & time',
      icon: '▦',
    })),
  ];
}

interface CalendarFieldPickersProps {
  calendars: readonly Calendar[];
  calendarId: string | null;
  onCalendarChange: (calendarId: string) => void;
  target: RowTarget | null;
  onTargetChange: (target: RowTarget | null) => void;
  /** Disable the Table field picker (e.g. while a conversion runs). */
  fieldDisabled?: boolean;
}

export function CalendarFieldPickers({
  calendars,
  calendarId,
  onCalendarChange,
  target,
  onTargetChange,
  fieldDisabled,
}: CalendarFieldPickersProps) {
  const calendar = calendars.find((c) => c.id === calendarId);
  return (
    <>
      <span className={styles.pickerLabel}>Calendar</span>
      <SearchSelect
        label="Calendar"
        value={calendarId ?? ''}
        options={
          calendars.length
            ? calendarOptions(calendars)
            : [{ value: '', label: 'Default calendar (new)', color: 'gray' }]
        }
        searchPlaceholder="Search calendars"
        emptyText="No calendars match"
        onChange={onCalendarChange}
      />
      <span className={styles.pickerLabel}>Table field</span>
      <SearchSelect
        label="Table field"
        value={target?.fieldId ?? ''}
        options={fieldOptions(calendar)}
        searchPlaceholder="Search date fields"
        emptyText="No date fields on this calendar match"
        disabled={fieldDisabled}
        onChange={(fieldId) =>
          onTargetChange(rowTargetsOf(calendar).find((t) => t.fieldId === fieldId) ?? null)
        }
      />
    </>
  );
}
