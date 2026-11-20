/**
 * One entry's properties, editable in place: the row window
 * (`TableEntryModal`) and the calendar's row popover share this. Each field
 * saves on its own, revision-safe, through the normal entry update (a step
 * in the user's table history), with the grid's editors: the cell editor
 * for text, numbers and dates, the entry picker for relations, the option
 * picker for selects, and a checkbox that saves on toggle.
 *
 * The entry reloads when a write names it (alone or in a batch) and when its
 * table's fields change. When a reload or a save finds it gone, it is
 * `deleted`: the surfaces show that, read-only, and nothing saves; an undo
 * that brings it back names it again, and it is live once more.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  RelatedTableEntries,
  RelatedTableItems,
  TableEntry,
  TableEntryValue,
  TableField,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, useDismissable } from '@desktop/components';
import { affectsEntry, emitTableEvent, subscribeTableEvents } from '@desktop/features/database';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { cn } from '@desktop/utils/classNames';
import { EntryCellEditor } from './cells/EntryCellEditor';
import { CheckboxCellValue } from './cells/CheckboxCellValue';
import { FieldTypeIcon } from './FieldTypeIcon';
import { RelationEntryPicker } from './RelationEntryPicker';
import { SelectEntryPicker } from './SelectEntryPicker';
import { TableEntryValueView } from './TableEntryValueView';
import { noteRepeatAdvance } from './repeatAdvanceToast';
import { entryValueProblem } from './dateRange';

interface LoadedEntry {
  entry: TableEntry;
  schemaVersion: string;
  relatedEntries: RelatedTableEntries;
  relatedItems: RelatedTableItems;
}

interface EntryEditing {
  /** The entry as last loaded (kept once it is deleted, for its name). */
  data: LoadedEntry | null;
  loadError: string | null;
  /** The entry is gone (deleted elsewhere): show it read-only, as deleted. */
  deleted: boolean;
  reload: () => void;
  /** The field being edited, or null. */
  editing: string | null;
  draft: TableEntryValue;
  saving: boolean;
  /** Why the last save or check of `errorFieldId` failed, or null. */
  fieldError: string | null;
  /** The field `fieldError` belongs to; it stays shown after its editor closes. */
  errorFieldId: string | null;
  begin: (field: TableField) => void;
  cancel: () => void;
  save: (field: TableField, value: TableEntryValue) => Promise<void>;
  /** The table's editor for `field`, bound to the draft. */
  renderEditor: (field: TableField) => ReactNode;
}

/** A read or save of the entry found it missing (deleted elsewhere). */
function isGone(err: unknown): boolean {
  return err instanceof FetchError && err.status === 404;
}

interface UseEntryEditingOptions {
  tableId: string;
  entryId: string;
  fields: TableField[];
  /** The entry's table went away. */
  onClose: () => void;
  /** After a field saved: the entry before and after the write. */
  onSaved?: (field: TableField, before: TableEntry, after: TableEntry) => void;
}

export function useEntryEditing({
  tableId,
  entryId,
  fields,
  onClose,
  onSaved,
}: UseEntryEditingOptions): EntryEditing {
  const [data, setData] = useState<LoadedEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<TableEntryValue>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ fieldId: string; message: string } | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((value) => value + 1), []);
  /** Bumped by every read and save: only the newest one's entry is shown. */
  const generation = useRef(0);

  /** The entry is gone: no editor stays open on it. */
  const markDeleted = useCallback(() => {
    setDeleted(true);
    setLoadError(null);
    setEditing(null);
  }, []);

  const load = useCallback(async () => {
    const read = ++generation.current;
    try {
      const result = await tablesApi.entry(tableId, entryId);
      if (read !== generation.current) return;
      setData(result);
      setLoadError(null);
      setDeleted(false);
    } catch (err) {
      if (read !== generation.current) return;
      if (isGone(err)) markDeleted();
      else setLoadError(getErrorMessage(err, 'Could not load this entry'));
    }
  }, [tableId, entryId, markDeleted]);

  useEffect(() => {
    void load();
  }, [load, reloads]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  // Another pane, the grid behind or an agent wrote this entry (alone or in a
  // batch), or changed the table's fields (an undo that changed both sends
  // only that): refresh unless mid-edit.
  useEffect(
    () =>
      subscribeTableEvents((event) => {
        if (event.type === 'table.entries.changed' && event.tableId === tableId) {
          if (affectsEntry(event, entryId) && !editing) reload();
        }
        if (event.type === 'table.fields.changed' && event.tableId === tableId && !editing)
          reload();
        if (event.type === 'table.removed' && event.tableId === tableId) onClose();
      }),
    [tableId, entryId, editing, onClose, reload]
  );

  const begin = (field: TableField) => {
    if (!data || deleted || field.managed || saving) return;
    setError(null);
    setEditing(field.id);
    setDraft(data.entry.values[field.id] ?? null);
  };

  const cancel = () => {
    setEditing(null);
    setError(null);
  };

  const save = async (field: TableField, value: TableEntryValue) => {
    if (!data || deleted) return;
    const current = data.entry.values[field.id] ?? null;
    if (JSON.stringify(current) === JSON.stringify(value)) {
      cancel();
      return;
    }
    const problem = entryValueProblem(field, value);
    if (problem) {
      setError({ fieldId: field.id, message: problem });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await tablesApi.updateEntry(tableId, entryId, {
        values: { [field.id]: value },
        schemaVersion: data.schemaVersion,
        expectedRevision: data.entry.revision,
      });
      // A read still in flight must not bring back an earlier revision.
      generation.current += 1;
      void noteRepeatAdvance({
        tableId,
        fields,
        before: data.entry,
        after: result.entry,
        patch: { [field.id]: value },
      });
      setData(result);
      setEditing(null);
      emitTableEvent({ type: 'table.entries.changed', tableId, entryId });
      onSaved?.(field, data.entry, result.entry);
    } catch (err) {
      if (err instanceof FetchError && err.status === 409) {
        setError({
          fieldId: field.id,
          message: 'This entry changed elsewhere. Reloaded the latest version; try again.',
        });
        setEditing(null);
        reload();
      } else if (isGone(err)) {
        markDeleted();
      } else {
        setError({ fieldId: field.id, message: getErrorMessage(err, 'Could not save this field') });
      }
    } finally {
      setSaving(false);
    }
  };

  /**
   * A repeat action from the date's popover saved the entry: show it, and
   * let the open date follow (its own edit would now be stale).
   */
  const adoptWritten = (field: TableField, entry: TableEntry, schemaVersion: string) => {
    // A read still in flight must not bring back an earlier revision.
    generation.current += 1;
    setData((current) => (current ? { ...current, entry, schemaVersion } : current));
    setDraft(entry.values[field.id] ?? null);
  };

  const renderEditor = (field: TableField) => {
    const common = {
      field,
      value: draft,
      relatedEntries: data?.relatedEntries,
      relatedItems: data?.relatedItems,
      onChange: (next: TableEntryValue) => setDraft(next),
      onCommit: (next: TableEntryValue) => void save(field, next),
      onCancel: cancel,
      busy: saving,
      error: error?.fieldId === field.id ? error.message : null,
      autoFocus: true,
      // A repeating date's picker is the date + repeat popover.
      repeat: field.recurrence
        ? {
            tableId,
            entryId,
            onWritten: (entry: TableEntry, schemaVersion: string) =>
              adoptWritten(field, entry, schemaVersion),
          }
        : undefined,
    };
    if (field.type === 'relation') return <RelationEntryPicker {...common} />;
    if (field.type === 'select') return <SelectEntryPicker {...common} />;
    return <EntryCellEditor {...common} />;
  };

  return {
    data,
    loadError,
    deleted,
    reload,
    editing,
    draft,
    saving,
    fieldError: error?.message ?? null,
    errorFieldId: error?.fieldId ?? null,
    begin,
    cancel,
    save,
    renderEditor,
  };
}

/** The class names a property row uses (the modal's and the popover's modules both have them). */
type EntryPropertyClasses = Readonly<
  Partial<
    Record<
      | 'property'
      | 'propertyName'
      | 'propertyIcon'
      | 'propertyValue'
      | 'valueButton'
      | 'readOnly'
      | 'empty'
      | 'editor'
      | 'editorActions'
      | 'fieldError',
      string
    >
  >
>;

/**
 * An open field editor. A press anywhere outside it (its own pickers count as
 * inside) cancels the edit and never saves; the surface around it stays open,
 * so the next outside press closes that. Escape stays with the editor itself.
 */
export function EntryInlineEditor({
  editing,
  className,
  children,
}: {
  editing: EntryEditing;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dismissProps = useDismissable({
    open: true,
    onDismiss: () => {
      if (!editing.saving) editing.cancel();
    },
    surfaceRef: ref,
    closeOnEscape: false,
  });
  return (
    <div ref={ref} className={className} data-entry-inline-editor="" {...dismissProps}>
      {children}
    </div>
  );
}

/** The Cancel / Save pair under an open editor. */
export function EntryEditorActions({
  editing,
  field,
  classes,
}: {
  editing: EntryEditing;
  field: TableField;
  classes: Pick<EntryPropertyClasses, 'editorActions'>;
}) {
  return (
    <div className={classes.editorActions}>
      <Button size="sm" variant="ghost" onClick={editing.cancel} disabled={editing.saving}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={() => void editing.save(field, editing.draft)}
        disabled={editing.saving}
      >
        {editing.saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}

/** One field as a labeled property (`<dt>` + `<dd>`), editable in place unless managed. */
export function EntryPropertyRow({
  editing,
  field,
  entryTitle,
  classes,
}: {
  editing: EntryEditing;
  field: TableField;
  /** The entry's name, for the checkbox's label. */
  entryTitle: string;
  classes: EntryPropertyClasses;
}) {
  const { data, saving } = editing;
  if (!data) return null;
  const value = data.entry.values[field.id] ?? null;
  const isEditing = editing.editing === field.id;
  const readOnly = field.managed || editing.deleted;
  return (
    <div className={classes.property} data-field-id={field.id}>
      <dt className={classes.propertyName}>
        <span className={classes.propertyIcon} aria-hidden>
          <FieldTypeIcon type={field.type} />
        </span>
        {field.name}
      </dt>
      <dd className={classes.propertyValue}>
        {field.type === 'checkbox' && !readOnly ? (
          <div className={classes.valueButton}>
            <CheckboxCellValue
              checked={value === true}
              label={`${field.name} in ${entryTitle}`}
              disabled={saving}
              onToggle={() => void editing.save(field, !(value === true))}
            />
          </div>
        ) : isEditing ? (
          <EntryInlineEditor editing={editing} className={classes.editor}>
            {editing.renderEditor(field)}
            <EntryEditorActions editing={editing} field={field} classes={classes} />
          </EntryInlineEditor>
        ) : (
          <button
            type="button"
            className={cn(classes.valueButton, readOnly && classes.readOnly)}
            aria-label={readOnly ? `${field.name} (read-only)` : `Edit ${field.name}`}
            disabled={readOnly || saving || !!editing.editing}
            onClick={() => editing.begin(field)}
          >
            {value === null || (Array.isArray(value) && value.length === 0) ? (
              <span className={classes.empty}>{readOnly ? '—' : 'Empty'}</span>
            ) : (
              <TableEntryValueView
                field={field}
                value={value}
                relatedEntries={data.relatedEntries}
                relatedItems={data.relatedItems}
              />
            )}
          </button>
        )}
        {editing.errorFieldId === field.id && editing.fieldError && (
          <p className={classes.fieldError} role="alert">
            {editing.fieldError}
          </p>
        )}
      </dd>
    </div>
  );
}
