import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { TableField } from '@snaglet/shared/types';
import { Button } from '@desktop/components';
import { TrashIcon } from '@desktop/components/Icons';
import { emitTableEvent } from '@desktop/features/database';
import { ReminderSettingsControl } from '@desktop/features/reminders/ReminderSettingsControl';
import { CopyEntryIdButton } from './CopyEntryIdButton';
import { entryLabel } from './RelationEntryPicker';
import { RepeatSection } from './repeat/RepeatSection';
import { TableEntryDelete } from './TableEntryDelete';
import {
  EntryEditorActions,
  EntryInlineEditor,
  EntryPropertyRow,
  useEntryEditing,
} from './EntryProperties';
import styles from './TableEntryModal.module.scss';

interface Props {
  tableId: string;
  entryId: string;
  /** The table's fields in display order. */
  fields: TableField[];
  onClose: () => void;
}

/**
 * A pane-contained preview of one table entry: its name as the title and every
 * field as a labeled property, each editable in place. Saves are per field and
 * revision-safe, like the grid's autosave. An entry deleted while it is open
 * (an agent, another window) stays open read-only under "This row was
 * deleted", its last values shown and nothing editable, until it is closed or
 * an undo brings it back. Its trash icon deletes the entry the way a grid
 * delete does (TableEntryDelete, immediate: undoable, a dialog only on a
 * conflict) and closes the preview.
 */
export function TableEntryModal({ tableId, entryId, fields, onClose }: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const editing = useEntryEditing({ tableId, entryId, fields, onClose });
  const { data, loadError, deleted, saving, fieldError } = editing;
  // A press on the scrim while a field editor is open closes the editor only
  // (EntryInlineEditor cancels it on that press); the next one closes the row.
  const scrimPressEditing = useRef(false);
  /** Set while the entry's delete runs; frozen at the revision shown. */
  const [deleting, setDeleting] = useState<{ id: string; revision: string } | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const visible = fields.filter(
    (field) => !field.isTitle || field.type !== 'text' || field.managed
  );
  const titleField = fields.find(
    (field) => !field.managed && field.isTitle && field.type === 'text'
  );
  const title = data ? entryLabel(data.entry, fields) : deleted ? 'Deleted row' : 'Loading…';
  const editingTitle = !!titleField && !!data && editing.editing === titleField.id;
  // Repeat: one section per repeating date/datetime field
  // (a range too: it repeats on its start and keeps its length). A deleted
  // row shows neither these nor its reminders.
  const repeating = deleted
    ? []
    : fields.filter(
        (field) =>
          !field.managed &&
          !!field.recurrence &&
          (field.type === 'date' || field.type === 'datetime')
      );

  // Reminders: a date-and-time field shown on a calendar, once the row has a time in it.
  const remindable =
    data && !deleted
      ? fields.filter(
          (field) =>
            !field.managed &&
            field.type === 'datetime' &&
            !!field.calendarId &&
            data.entry.values[field.id] != null &&
            data.entry.values[field.id] !== ''
        )
      : [];

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !editing.editing) {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className={styles.overlay} data-table-entry-modal="">
      <div
        className={styles.scrim}
        aria-hidden
        onPointerDown={() => {
          scrimPressEditing.current = editing.editing !== null;
        }}
        onClick={() => !saving && !scrimPressEditing.current && onClose()}
      />
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        // The heading gives way to its editor while the name is edited.
        aria-labelledby={editingTitle ? undefined : titleId}
        aria-label={editingTitle ? title : undefined}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className={styles.header}>
          {titleField && editingTitle ? (
            <EntryInlineEditor editing={editing} className={styles.titleEditor}>
              {editing.renderEditor(titleField)}
              <EntryEditorActions editing={editing} field={titleField} classes={styles} />
            </EntryInlineEditor>
          ) : (
            <h2 id={titleId} className={styles.title}>
              {titleField && data && !deleted ? (
                <button
                  type="button"
                  className={styles.titleButton}
                  aria-label={`Edit ${titleField.name}: ${title}`}
                  disabled={saving || !!editing.editing}
                  onClick={() => editing.begin(titleField)}
                >
                  {title}
                </button>
              ) : (
                title
              )}
            </h2>
          )}
          <div className={styles.headerActions}>
            <CopyEntryIdButton entryId={entryId} className={styles.headerAction} />
            {data && !deleted && (
              <button
                type="button"
                className={`${styles.headerAction} ${styles.headerDelete}`}
                aria-label="Delete entry"
                title="Delete entry"
                disabled={saving || !!editing.editing || !!deleting}
                onClick={() => setDeleting({ id: data.entry.id, revision: data.entry.revision })}
              >
                <TrashIcon />
              </button>
            )}
            <button
              type="button"
              className={styles.headerAction}
              aria-label="Close entry"
              onClick={onClose}
            >
              <svg
                viewBox="0 0 24 24"
                width={16}
                height={16}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </header>
        {titleField && editing.errorFieldId === titleField.id && fieldError && (
          <p className={styles.fieldError} role="alert">
            {fieldError}
          </p>
        )}
        <div className={styles.body}>
          {deleted && (
            <p className={styles.deleted} role="status">
              This row was deleted.
            </p>
          )}
          {loadError ? (
            <div className={styles.loadError} role="alert">
              <p>{loadError}</p>
              <Button size="sm" onClick={editing.reload}>
                Retry
              </Button>
            </div>
          ) : !data ? (
            !deleted && <p className={styles.loading}>Loading entry…</p>
          ) : (
            <>
              <dl className={styles.properties}>
                {visible.map((field) => (
                  <EntryPropertyRow
                    key={field.id}
                    editing={editing}
                    field={field}
                    entryTitle={title}
                    classes={styles}
                  />
                ))}
              </dl>
              {repeating.length > 0 && (
                <div className={styles.repeats}>
                  {repeating.map((field) => (
                    <RepeatSection
                      key={field.id}
                      tableId={tableId}
                      entryId={entryId}
                      field={field}
                    />
                  ))}
                </div>
              )}
              {remindable.map((field) => (
                <ReminderSettingsControl
                  key={field.id}
                  className={styles.reminders}
                  item={{ kind: 'table_entry', tableId, entryId, fieldId: field.id }}
                  label={`Notify · ${field.name}`}
                />
              ))}
            </>
          )}
        </div>
      </div>
      {deleting && (
        <TableEntryDelete
          tableId={tableId}
          entries={[deleting]}
          immediate
          onCancel={() => setDeleting(null)}
          onReload={editing.reload}
          onDeleted={(ids) => {
            // The board or grid behind drops the row now, not on the server's echo.
            if (ids[0])
              emitTableEvent({
                type: 'table.entries.changed',
                tableId,
                entryId: ids[0],
                entryIds: ids,
              });
            onClose();
          }}
        />
      )}
    </div>
  );
}
