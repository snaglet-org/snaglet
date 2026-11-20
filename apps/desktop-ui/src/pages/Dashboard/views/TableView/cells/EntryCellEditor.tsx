import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import type {
  RelatedTableEntries,
  RelatedTableItems,
  TableEntry,
  TableEntryValue,
  TableField,
} from '@snaglet/shared/types';
import { DateInput, TextInput } from '@desktop/components';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import { useTableInputEscape } from '../useTableInputEscape';
import { fromDateTimeInput, toDateTimeInput } from '../dateTimeInput';
import { joinRangeParts, rangeKindOf, rangeParts, type RangeParts } from '../dateRange';
import { TableEntryValueView } from '../TableEntryValueView';
import { CellPickerPopover } from '../CellPickerPopover';
import { DateRepeatInput } from '../repeat/DateRepeatPopover';
import { CheckboxCellValue } from './CheckboxCellValue';
import styles from './EntryCellEditor.module.scss';

/** A saved row's repeating date: its picker is the date + repeat popover. */
interface EntryCellRepeat {
  tableId: string;
  entryId: string;
  /** A repeat action saved the row: take it as the editor's base. */
  onWritten?: (entry: TableEntry, schemaVersion: string) => void;
}

export interface EntryCellEditorProps {
  field: TableField;
  value: TableEntryValue;
  relatedEntries?: RelatedTableEntries;
  /** Titles of the Snaglet items relations to docs, agents, … link to. */
  relatedItems?: RelatedTableItems;
  /** Every edit feeds the revision-safe autosave draft. */
  onChange: (value: TableEntryValue) => void;
  /** Enter. */
  onCommit: (value: TableEntryValue) => void;
  /** Escape. */
  onCancel: () => void;
  busy: boolean;
  error?: string | null;
  autoFocus?: boolean;
  /**
   * A grid cell is too narrow for a range's two inputs: they open stacked
   * and labeled in a panel under the cell, which shows the value. The row
   * window has room and keeps them inline.
   */
  rangePanel?: boolean;
  /**
   * The row is saved and the field repeats (`recurrence`): the date's
   * picker (a range's Start) gets the Repeat row and view. Left out, a date
   * is a plain DateInput.
   */
  repeat?: EntryCellRepeat;
}

/** Empty scalar input means "no value"; the row's validation decides if that is allowed. */
function emptyToNull(text: string): string | null {
  return text.trim() === '' ? null : text;
}

/**
 * Editor for one scalar cell of a custom-table entry (Text, Number, Date/Time,
 * Checkbox). Relation cells use the grid's entry picker; managed and other
 * non-editable fields render read-only here.
 *
 * A range field (Date with End date) edits its start and end in two inputs
 * of the field's kind; an empty end is a single value. A pair the shared
 * parser refuses still reaches the draft (whose validation refuses it too),
 * shows the parser's sentence, and Enter does not commit it.
 *
 * Text cells are the shared chip input: Snaglet chips can be dragged in or found
 * with `@`, and the value is canonical markdown. The enclosing EntryCell owns
 * scalar chip-drop rejection and its transient, out-of-flow notice.
 *
 * Enter commits and Escape cancels. An Escape the `@` menu already handled
 * (default prevented) only closes that menu.
 */
export function EntryCellEditor({
  field,
  value,
  onChange,
  onCommit,
  onCancel,
  busy,
  error,
  autoFocus = false,
  rangePanel = false,
  repeat,
}: EntryCellEditorProps) {
  const errorId = useId();
  const [textEditor, setTextEditor] = useState<Editor | null>(null);
  // Enter can arrive in the same tick as the edit before it, ahead of the
  // parent's re-render; commit the newest value, not the last rendered prop.
  const latestRef = useRef(value);
  useEffect(() => {
    latestRef.current = value;
  }, [value]);
  const rangeKind = field.managed ? null : rangeKindOf(field);
  // The parts as typed, so a refused pair stays on screen; `storedRange` keeps
  // the value's exact instants for parts left untouched.
  const [range, setRange] = useState<RangeParts>(() => rangeParts(value));
  const rangeRef = useRef(range);
  const [storedRange] = useState(range);
  const [rangeProblem, setRangeProblem] = useState<string | null>(null);
  // The panel hangs from the cell; held in state so it renders once the cell exists.
  const [cellEl, setCellEl] = useState<HTMLDivElement | null>(null);
  const rangeNarrow = rangePanel && !!rangeKind;
  const repeating =
    repeat && field.recurrence && (field.type === 'date' || field.type === 'datetime')
      ? repeat
      : null;
  const scalarType =
    field.type === 'number' ||
    field.type === 'date' ||
    field.type === 'datetime' ||
    field.type === 'checkbox';

  useTableInputEscape(textEditor, () => {
    if (!busy) onCancel();
  });

  const change = (next: TableEntryValue) => {
    if (busy) return;
    latestRef.current = next;
    onChange(next);
  };

  const changeRangePart = (part: keyof RangeParts, text: string) => {
    if (busy || !rangeKind) return;
    const next = {
      ...rangeRef.current,
      [part]:
        rangeKind === 'datetime'
          ? (fromDateTimeInput(text, storedRange[part] || null) ?? '')
          : text.trim(),
    };
    rangeRef.current = next;
    setRange(next);
    const joined = joinRangeParts(next, rangeKind);
    setRangeProblem(joined.problem);
    change(joined.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (busy || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (
      event.key === 'Enter' &&
      scalarType &&
      !field.managed &&
      event.target instanceof HTMLInputElement
    ) {
      event.preventDefault();
      // Read the parts, not the last render: Enter can follow an edit in the same tick.
      const problem = rangeKind && joinRangeParts(rangeRef.current, rangeKind).problem;
      if (problem) setRangeProblem(problem);
      else onCommit(latestRef.current);
    }
  };

  const message = rangeProblem ?? error ?? null;
  const describedBy = message ? errorId : undefined;
  const ariaLabel = field.name;

  let control: ReactNode;
  if (field.managed || !(scalarType || field.type === 'text')) {
    control = (
      <span className={styles.readOnly} aria-readonly="true" aria-label={ariaLabel}>
        {value === null ? '' : String(value)}
      </span>
    );
  } else if (field.type === 'text') {
    control = (
      <ChipEditableInput
        onEditorReady={setTextEditor}
        value={typeof value === 'string' ? value : ''}
        onChange={(next) => change(next === '' && field.nullable ? null : next)}
        onSubmit={() => {
          if (!busy) onCommit(latestRef.current);
        }}
        placeholder="Type, or @ to find…"
        disabled={busy}
        autoFocus={autoFocus}
        ariaLabel={ariaLabel}
        ariaInvalid={!!message}
        ariaDescribedBy={describedBy}
        className={styles.chipInput}
      />
    );
  } else if (field.type === 'number') {
    control = (
      <TextInput
        unstyled
        className={styles.scalarInput}
        inputMode="decimal"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => change(emptyToNull(event.target.value))}
        readOnly={busy}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-invalid={!!message}
        aria-describedby={describedBy}
        placeholder="0"
      />
    );
  } else if (rangeKind) {
    const datetime = rangeKind === 'datetime';
    const shown = (part: keyof RangeParts) =>
      datetime ? toDateTimeInput(range[part]) : range[part];
    const rangeInput = (part: keyof RangeParts, inPanel = false) => {
      const props = {
        className: inPanel
          ? styles.rangePanelInput
          : `${styles.rangeInput} ${part === 'end' ? styles.rangeEnd : ''}`,
        fullWidth: true,
        step: datetime ? 'any' : undefined,
        value: shown(part),
        range: { part, other: shown(part === 'start' ? 'end' : 'start') },
        onChange: (next: string) => changeRangePart(part, next),
        readOnly: busy,
        autoFocus: autoFocus && part === 'start',
        'aria-label': part === 'start' ? 'Start' : 'End',
        'aria-invalid': !!message,
        'aria-describedby': describedBy,
      };
      // A range repeats on its start.
      return repeating && part === 'start' ? (
        <DateRepeatInput
          {...props}
          tableId={repeating.tableId}
          entryId={repeating.entryId}
          field={field}
          onEntryWritten={repeating.onWritten}
        />
      ) : (
        <DateInput {...props} type={datetime ? 'datetime-local' : 'date'} />
      );
    };
    const joined = joinRangeParts(range, rangeKind).value;
    control = rangeNarrow ? (
      <>
        <span className={styles.rangeSummary}>
          {typeof joined === 'string' ? (
            <TableEntryValueView field={field} value={joined} />
          ) : (
            'Pick a start'
          )}
        </span>
        <CellPickerPopover
          anchor={cellEl}
          minWidth={datetime ? 300 : 240}
          // Nothing to drop on a date: an outside press keeps what was typed
          // and closes the card, Escape reverts it, as in the grid itself.
          onDismiss={(reason) => {
            if (busy) return;
            if (reason === 'escape') onCancel();
            else onCommit(latestRef.current);
          }}
        >
          <div className={styles.rangePanel} role="group" aria-label={ariaLabel}>
            <span className={styles.rangePanelLabel}>Start</span>
            {rangeInput('start', true)}
            <span className={styles.rangePanelLabel}>End</span>
            {rangeInput('end', true)}
            <p
              id={message ? errorId : undefined}
              role={message ? 'alert' : undefined}
              className={styles.rangePanelHint}
            >
              {message ?? 'Leave End empty for a single ' + (datetime ? 'time.' : 'day.')}
            </p>
          </div>
        </CellPickerPopover>
      </>
    ) : (
      <div className={styles.rangeControl} role="group" aria-label={ariaLabel}>
        {rangeInput('start')}
        <span className={styles.rangeArrow} aria-hidden="true">
          →
        </span>
        {rangeInput('end')}
      </div>
    );
  } else if (field.type === 'date' || field.type === 'datetime') {
    const datetime = field.type === 'datetime';
    const props = {
      className: styles.dateInput,
      fullWidth: true,
      step: datetime ? 'any' : undefined,
      value: datetime
        ? toDateTimeInput(typeof value === 'string' ? value : null)
        : typeof value === 'string'
          ? value
          : '',
      onChange: (next: string) =>
        change(
          datetime
            ? fromDateTimeInput(
                next,
                typeof latestRef.current === 'string' ? latestRef.current : null
              )
            : emptyToNull(next)
        ),
      readOnly: busy,
      autoFocus,
      'aria-label': ariaLabel,
      'aria-invalid': !!message,
      'aria-describedby': describedBy,
    };
    control = repeating ? (
      <DateRepeatInput
        {...props}
        tableId={repeating.tableId}
        entryId={repeating.entryId}
        field={field}
        onEntryWritten={repeating.onWritten}
      />
    ) : (
      <DateInput {...props} type={datetime ? 'datetime-local' : 'date'} />
    );
  } else {
    control = (
      <CheckboxCellValue
        checked={value === true}
        label={ariaLabel}
        disabled={busy}
        autoFocus={autoFocus}
        onToggle={() => change(latestRef.current !== true)}
      />
    );
  }

  return (
    <div
      ref={setCellEl}
      className={styles.cell}
      onKeyDown={onKeyDown}
      aria-busy={busy || undefined}
    >
      <div className={styles.control}>{control}</div>
      {message && !(rangeKind && rangeNarrow) && (
        <p id={errorId} role="alert" className={styles.error}>
          {message}
        </p>
      )}
    </div>
  );
}
