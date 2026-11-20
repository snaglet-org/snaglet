/**
 * The row popover: what clicking a table row on the calendar opens (and what
 * a quick add or a converted event shows once its row is made). The row's
 * Name as the title, its date line, its calendar and "<table> · <field>",
 * then its other properties as a compact list, each edited in place with the
 * table's own editors (`EntryProperties`) — a save is the normal entry
 * update, a step in the table history. The row-occurrence actions (Mark
 * done, Skip, Move to…, Repeat…) sit under them, and **Open full row** opens
 * the row window. Managed fields stay read-only, and so does the date when
 * the occurrence can't move (a managed `created_at`, a logged occurrence).
 * A date-and-time field has a Notify section (reminders for this row).
 * A row deleted while the popover is open (an agent, another window) shows
 * "This row was deleted" with its last values, read-only, and no actions.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  Calendar,
  CalendarRowOccurrence,
  TableEntry,
  TableField,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { ContextMenu } from '@desktop/components/ContextMenu';
import { cn } from '@desktop/utils/classNames';
import { tablesApi } from '@desktop/utils/api';
import { AnchoredSurface } from '@desktop/features/calendar/AnchoredSurface';
import popoverStyles from '@desktop/features/calendar/CalendarPopovers.module.scss';
import {
  formatClock,
  instantToZoned,
  shortDayLabel,
} from '@desktop/features/calendar/calendarDates';
import { calendarColor } from '@desktop/features/calendar/calendarStore';
import { describeSpan } from '@desktop/features/calendar/occurrenceMoves';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import { titleFieldOf } from '@desktop/features/calendar/rowCreate';
import { ReminderSettingsControl } from '@desktop/features/reminders/ReminderSettingsControl';
import { entryLabel } from '../TableView/RelationEntryPicker';
import {
  EntryEditorActions,
  EntryInlineEditor,
  EntryPropertyRow,
  useEntryEditing,
} from '../TableView/EntryProperties';
import { displayTitle } from './occurrenceText';
import styles from './RowPopover.module.scss';

export interface RowPopoverAction {
  label: string;
  disabled?: boolean;
  /** Takes back a Mark / Skip: drawn apart from the buttons that complete. */
  undo?: boolean;
  onSelect: () => void;
}

interface RowPopoverProps {
  anchor: HTMLElement;
  /** Finds the row's item again after the grid redraws it. */
  resolveAnchor?: () => HTMLElement | null;
  occurrence: CalendarRowOccurrence;
  calendar: Calendar | undefined;
  zone: string;
  /** The table's fields when the caller has them (a row just made). */
  fields?: TableField[];
  /** Mark done, Skip, Move to…, Repeat… (whichever apply). */
  actions: RowPopoverAction[];
  /**
   * Mark done through the repeat's status field: set it to one of the done
   * options (`label`). `fresh` is the row as this popover last read it.
   */
  onMarkStatus?: (
    statusFieldId: string,
    label: string,
    fresh?: { expectedRevision: string; schemaVersion: string }
  ) => void;
  /** Unmark this occurrence's done / skip (its entry in the row's occurrence log). */
  onUndoMark?: () => Promise<void>;
  onOpenFull: (fields: TableField[]) => void;
  onClose: () => void;
  /** A property saved (the pane refetches; the step goes on the calendar stack). */
  onSaved: (field: TableField, before: TableEntry, after: TableEntry) => void;
}

/** The occurrence's date line: a span, or just the start of a value with no end. */
function rowTimeLine(o: CalendarRowOccurrence, zone: string): string {
  if (o.time.kind === 'timed' && !o.hasEnd) {
    const start = instantToZoned(o.time.start, zone);
    const suffix = start.minutes < 720 ? 'AM' : 'PM';
    return `${shortDayLabel(start.date)}, ${formatClock(start.minutes)} ${suffix}`;
  }
  return describeSpan(o.time, zone);
}

/** What a logged occurrence reads as; an upcoming one has no state of its own. */
const OCCURRENCE_STATE: Record<string, string> = {
  done: '✓ Done',
  skipped: 'Skipped',
  moved: 'Moved',
};

export function RowPopover(props: RowPopoverProps) {
  const { occurrence: o, onClose } = props;
  const [fields, setFields] = useState<TableField[] | null>(props.fields ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.fields) return;
    let canceled = false;
    tablesApi
      .fields(o.tableId)
      .then((result) => {
        if (!canceled) setFields(result.fields);
      })
      .catch((err: unknown) => {
        if (!canceled) setError(getErrorMessage(err, "Couldn't load the row"));
      });
    return () => {
      canceled = true;
    };
  }, [o.tableId, props.fields]);

  return (
    <AnchoredSurface
      anchor={props.anchor}
      resolveAnchor={props.resolveAnchor}
      label={displayTitle(o)}
      width={340}
      onDismiss={onClose}
    >
      {fields ? (
        <RowBody {...props} fields={fields} />
      ) : (
        <p className={popoverStyles.muted} role={error ? 'alert' : undefined}>
          {error ?? 'Loading…'}
        </p>
      )}
    </AnchoredSurface>
  );
}

function RowBody({
  occurrence: o,
  calendar,
  zone,
  fields,
  actions,
  onMarkStatus,
  onUndoMark,
  onOpenFull,
  onClose,
  onSaved,
}: RowPopoverProps & { fields: TableField[] }) {
  const editing = useEntryEditing({
    tableId: o.tableId,
    entryId: o.entryId,
    fields,
    onClose,
    onSaved,
  });
  const { data, loadError, deleted } = editing;
  const bodyRef = useRef<HTMLDivElement>(null);

  // Once the row is loaded, focus its first control, unless focus is already
  // somewhere the user put it: the popover opens over a lost focus (the quick
  // add or event popover it replaces, which leaves it on the pane itself) or
  // the row's own item.
  const loaded = data !== null;
  useEffect(() => {
    if (!loaded) return;
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      !active.isConnected ||
      active.hasAttribute('data-calendar-pane');
    if (!lost && !(active instanceof HTMLElement && active.closest('[data-calendar-item]'))) return;
    bodyRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({
      preventScroll: true,
    });
  }, [loaded]);
  const titleField = titleFieldOf(fields);
  const dateField = fields.find((f) => f.id === o.fieldId);
  const title = data ? entryLabel(data.entry, fields) : displayTitle(o);
  // A repeating row has one status for the whole row (it resets after each
  // Done), so a logged occurrence shows its own state in its place.
  const occurrenceState = o.repeat ? OCCURRENCE_STATE[o.status] : undefined;
  const statusFieldId = dateField?.recurrence?.statusFieldId ?? null;
  // "Mark done" reads as the repeat's own words: one "Mark <option>" button
  // per done option of its status field (a repeat with no status field keeps
  // the plain Done button).
  const doneOptionLabels = (dateField?.recurrence?.doneOptionIds ?? []).flatMap((id) => {
    const option = fields.find((f) => f.id === statusFieldId)?.options?.find((x) => x.id === id);
    return option ? [option.label] : [];
  });
  const doneOptions =
    statusFieldId && onMarkStatus
      ? (dateField?.recurrence?.doneOptionIds ?? []).flatMap((id) => {
          const option = fields
            .find((f) => f.id === statusFieldId)
            ?.options?.find((x) => x.id === id);
          return option ? [option] : [];
        })
      : [];
  // A done or skipped occurrence turns its Mark / Skip buttons into one Undo,
  // drawn differently so it doesn't read as another way to complete it.
  const undoKind =
    onUndoMark && o.repeat && (o.status === 'done' || o.status === 'skipped') ? o.status : null;
  const [undoing, setUndoing] = useState(false);
  const shownActions: RowPopoverAction[] = [];
  for (const action of actions) {
    if (undoKind && (action.label === 'Mark done' || action.label === 'Skip')) {
      if (!shownActions.some((shown) => shown.undo)) {
        shownActions.push({
          label: undoKind === 'skipped' ? 'Undo skip' : 'Undo done',
          undo: true,
          disabled: undoing,
          onSelect: () => {
            setUndoing(true);
            void onUndoMark?.().finally(() => setUndoing(false));
          },
        });
      }
    } else if (action.label === 'Mark done' && statusFieldId && doneOptions.length > 0) {
      for (const option of doneOptions) {
        shownActions.push({
          label: `Mark ${option.label}`,
          disabled: action.disabled,
          onSelect: () =>
            onMarkStatus?.(
              statusFieldId,
              option.label,
              data
                ? { expectedRevision: data.entry.revision, schemaVersion: data.schemaVersion }
                : undefined
            ),
        });
      }
    } else {
      shownActions.push(action);
    }
  }
  const others = fields.filter(
    (f) =>
      f.id !== titleField?.id &&
      f.id !== o.fieldId &&
      f.type !== 'uuid' &&
      !(occurrenceState && f.id === statusFieldId)
  );
  const color = calendar ? calendarColor(calendar) : undefined;

  // Managed and empty properties stay behind "Show N more", so the list is
  // what the row actually holds. A property being edited always shows.
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [notifyAnchor, setNotifyAnchor] = useState<HTMLElement | null>(null);
  const isQuiet = (field: TableField) => {
    const value = data?.entry.values[field.id];
    const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0);
    return field.managed || empty;
  };
  const shownProps = showAll
    ? others
    : others.filter(
        (f) => !isQuiet(f) || editing.editing === f.id || editing.errorFieldId === f.id
      );
  const hiddenCount = others.length - shownProps.length;
  // The buttons that complete an occurrence stay; the rest go behind ⋯.
  const isSecondary = (label: string) => label.startsWith('Move to') || label === 'Repeat…';
  const primaryActions = shownActions.filter((a) => !isSecondary(a.label));
  const secondaryActions = shownActions.filter((a) => isSecondary(a.label));

  // An open editor owns Escape (it cancels the edit, not the popover).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && editing.editing) e.preventDefault();
  };

  // A managed date (created_at) or an occurrence the calendar can't move
  // (a logged one) can't be re-dated here.
  const dateLocked = !dateField || dateField.managed || !o.canMove || deleted;
  // Reminders need a start time: a date-and-time field the user sets.
  // Done by status: the row's status field holds one of the repeat's done
  // options (a series on its last occurrence stays done without moving on).
  const statusValue = statusFieldId ? data?.entry.values[statusFieldId] : undefined;
  const doneLabels = new Set(doneOptionLabels.map((label) => label.toLowerCase()));
  const doneByStatus = typeof statusValue === 'string' && doneLabels.has(statusValue.toLowerCase());
  // A done or skipped occurrence has nothing left to remind about.
  const remindable =
    !deleted &&
    dateField?.type === 'datetime' &&
    !dateField.managed &&
    o.time.kind === 'timed' &&
    o.status !== 'done' &&
    o.status !== 'skipped' &&
    !doneByStatus;
  const editingTitle = titleField && editing.editing === titleField.id;
  const editingDate = dateField && !dateLocked && editing.editing === dateField.id;

  const stateChip = o.repeat ? (OCCURRENCE_STATE[o.status] ?? 'Upcoming') : null;

  return (
    <div ref={bodyRef} className={styles.body} onKeyDown={onKeyDown}>
      <div className={styles.header}>
        <div className={popoverStyles.row}>
          <span className={popoverStyles.swatch} {...calendarColorProps(color)} aria-hidden />
          {editingTitle ? (
            <EntryInlineEditor editing={editing} className={styles.inlineEditor}>
              {editing.renderEditor(titleField)}
              <EntryEditorActions editing={editing} field={titleField} classes={styles} />
            </EntryInlineEditor>
          ) : (
            <h3 className={styles.title}>
              {titleField && data && !deleted ? (
                <button
                  type="button"
                  className={styles.titleButton}
                  aria-label={`Edit ${titleField.name}: ${title}`}
                  disabled={editing.saving || !!editing.editing}
                  onClick={() => editing.begin(titleField)}
                >
                  {title}
                </button>
              ) : (
                title
              )}
            </h3>
          )}
          {stateChip && (
            <span
              className={styles.stateChip}
              data-state={o.status}
              title={o.status === 'upcoming' ? undefined : `This occurrence is ${o.status}`}
            >
              {stateChip}
            </span>
          )}
        </div>
        {titleField && editing.errorFieldId === titleField.id && editing.fieldError && (
          <p className={popoverStyles.error} role="alert">
            {editing.fieldError}
          </p>
        )}

        {editingDate ? (
          <EntryInlineEditor editing={editing} className={styles.inlineEditor}>
            {editing.renderEditor(dateField)}
            <EntryEditorActions editing={editing} field={dateField} classes={styles} />
            {editing.fieldError && (
              <p className={popoverStyles.error} role="alert">
                {editing.fieldError}
              </p>
            )}
          </EntryInlineEditor>
        ) : (
          <div className={styles.whenLine}>
            <button
              type="button"
              className={popoverStyles.timeLine}
              aria-label={`${dateField?.name ?? 'Date'}: ${rowTimeLine(o, zone)}. ${
                dateLocked ? 'Read-only here' : 'Edit'
              }`}
              title={dateLocked ? 'Read-only here' : undefined}
              disabled={dateLocked || !data || !!editing.editing}
              onClick={() => dateField && editing.begin(dateField)}
            >
              {rowTimeLine(o, zone)}
            </button>
            {o.repeat?.summary && <span className={styles.repeatText}>↻ {o.repeat.summary}</span>}
          </div>
        )}
        {!editingDate &&
          dateField &&
          editing.errorFieldId === dateField.id &&
          editing.fieldError && (
            <p className={popoverStyles.error} role="alert">
              {editing.fieldError}
            </p>
          )}
      </div>

      {deleted && (
        <p className={popoverStyles.muted} role="status">
          This row was deleted.
        </p>
      )}
      {loadError ? (
        <p className={popoverStyles.error} role="alert">
          {loadError}{' '}
          <Button size="xs" variant="link" onClick={editing.reload}>
            Retry
          </Button>
        </p>
      ) : !data ? (
        !deleted && <p className={popoverStyles.muted}>Loading…</p>
      ) : (
        others.length > 0 && (
          <div className={styles.section}>
            {shownProps.length > 0 && (
              <dl className={styles.properties} aria-label="Properties">
                {shownProps.map((field) => (
                  <EntryPropertyRow
                    key={field.id}
                    editing={editing}
                    field={field}
                    entryTitle={title}
                    classes={styles}
                  />
                ))}
              </dl>
            )}
            {(hiddenCount > 0 || showAll) && (
              <button
                type="button"
                className={styles.moreLink}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? 'Show fewer' : `Show ${hiddenCount} more`}
              </button>
            )}
          </div>
        )
      )}

      {!deleted && (
        <div className={cn(styles.section, popoverStyles.rowActions)}>
          {primaryActions.map((action) => (
            <Button
              key={action.label}
              size="sm"
              variant="neutral"
              className={action.undo ? popoverStyles.undoAction : undefined}
              disabled={action.disabled}
              onClick={action.onSelect}
            >
              {action.undo && <span aria-hidden>↶ </span>}
              {action.label}
            </Button>
          ))}
          {remindable && (
            <Button size="sm" variant="neutral" onClick={(e) => setNotifyAnchor(e.currentTarget)}>
              Notify
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label="More actions"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom });
            }}
          >
            ⋯
          </Button>
        </div>
      )}
      {menu && (
        <ContextMenu
          ariaLabel="Row actions"
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...secondaryActions.map((action) => ({
              label: action.label,
              disabled: action.disabled,
              onSelect: action.onSelect,
            })),
            { label: 'Open full row', onSelect: () => onOpenFull(fields) },
          ]}
        />
      )}

      {notifyAnchor && remindable && dateField && (
        <AnchoredSurface
          anchor={notifyAnchor}
          label={`Notify · ${dateField.name}`}
          width={320}
          onDismiss={() => setNotifyAnchor(null)}
        >
          <ReminderSettingsControl
            item={{
              kind: 'table_entry',
              tableId: o.tableId,
              entryId: o.entryId,
              fieldId: o.fieldId,
            }}
            label={`Notify · ${dateField.name}`}
          />
        </AnchoredSurface>
      )}

      <p className={styles.where} {...calendarColorProps(color)}>
        {calendar?.title ?? 'Calendar'} · {o.tableName} · {dateField?.name ?? ''}
      </p>
    </div>
  );
}
