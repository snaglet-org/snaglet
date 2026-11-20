import { useCallback, useEffect, useId, useRef, useState, type FC } from 'react';
import type {
  TableDetailResponse,
  TableEntrySort,
  TableEntryWhere,
  TableField,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { RemoveTableFieldModal } from '@desktop/components/Modal';
import { emitTableEvent, subscribeTableEvents } from '@desktop/features/database';
import { tablesApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { TableFieldEditor } from './TableFieldEditor';
import { FieldEditorPopover } from './FieldEditorPopover';
import { TableEntriesGrid } from './TableEntriesGrid';
import { TableBoard } from './TableBoard';
import type { TableViewMode } from './boardViewPreference';
import styles from './TableView.module.scss';

interface EditorState {
  field?: TableField;
  beforeFieldId?: string;
  trigger: HTMLButtonElement;
}

/**
 * Keyed by table id by the pane so drafts never transfer to another table.
 * Shows the entries as the Grid, or as the Board grouped by `boardField`
 * when the pane asks for it; field settings open from the Grid's headers.
 */
export const CustomTableFields: FC<{
  detail: TableDetailResponse;
  focusEntryId?: string;
  focusRequestId?: number;
  view?: TableViewMode;
  boardField?: TableField | null;
  /** Sort levels of the shown view; empty keeps row order. */
  sort?: TableEntrySort[];
  /** A Grid header's sort toggle asks for a new sort of the shown view. */
  onSortChange?: (sort: TableEntrySort[]) => void;
  where?: TableEntryWhere[];
  /** The view's whole filter (incomplete conditions too) for the Grid headers' filters. */
  viewFilter?: TableEntryWhere[];
  /** A Grid header's filter asks for a new filter of the shown view. */
  onFilterChange?: (where: TableEntryWhere[]) => void;
  /** The table's current field list, each time it loads. */
  onFieldsLoaded?: (fields: TableField[]) => void;
  /** A Board card asks the pane to open its entry. */
  onOpenEntry?: (entryId: string) => void;
}> = ({
  detail,
  focusEntryId,
  focusRequestId,
  view = 'grid',
  boardField = null,
  sort,
  onSortChange,
  where,
  viewFilter,
  onFilterChange,
  onFieldsLoaded,
  onOpenEntry,
}) => {
  const tableId = detail.table.id;
  const onFieldsLoadedRef = useRef(onFieldsLoaded);
  onFieldsLoadedRef.current = onFieldsLoaded;
  const [snapshot, setSnapshot] = useState({ detail, fields: [] as TableField[] });
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentsRef = useRef<HTMLDivElement>(null);
  const fieldEditorId = useId();
  const requestCloseRef = useRef<(() => void) | null>(null);
  const savedFieldId = useRef<string | null>(null);
  const cancelPendingFocus = useRef<(() => void) | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  /** The column whose header trash was clicked: archive or delete forever? */
  const [removeTarget, setRemoveTarget] = useState<TableField | null>(null);
  const anchorFieldId = editor?.field?.id;

  // Both choices tell every pane of this table (the server's own
  // `table.fields.changed` echo is a no-op after this) and close the dialog;
  // a rejection stays inline in it.
  const archiveRemoveTarget = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    await tablesApi.archiveField(tableId, target.id);
    emitTableEvent({ type: 'table.fields.changed', tableId });
    setRemoveTarget(null);
    showToast(`Archived column “${target.name}”. Restore it from Archived, or undo.`, {
      durationMs: 3000,
    });
  };
  const deleteRemoveTarget = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    await tablesApi.purgeField(tableId, target.id);
    emitTableEvent({ type: 'table.fields.changed', tableId });
    setRemoveTarget(null);
    showToast(`Permanently deleted column “${target.name}”.`, { durationMs: 3000 });
  };
  const initialTrigger = editor?.trigger;
  const findFieldTrigger = useCallback((fieldId: string) => {
    const header = Array.from(
      contentsRef.current?.querySelectorAll<HTMLElement>('[data-field-id]') ?? []
    ).find((element) => element.dataset.fieldId === fieldId);
    const current = header?.querySelector<HTMLButtonElement>('[data-field-edit-trigger]');
    return current?.isConnected ? current : null;
  }, []);
  const resolveEditorTrigger = useCallback(() => {
    const fieldId = savedFieldId.current ?? anchorFieldId;
    const current = fieldId ? findFieldTrigger(fieldId) : null;
    if (current) return current;
    return initialTrigger?.isConnected ? initialTrigger : null;
  }, [anchorFieldId, initialTrigger, findFieldTrigger]);

  const openEditor = (next: EditorState) => {
    if (editor) {
      if (
        (next.field && next.field.id === (savedFieldId.current ?? editor.field?.id)) ||
        next.trigger === editor.trigger
      ) {
        requestCloseRef.current?.();
      }
      return;
    }
    savedFieldId.current = null;
    cancelPendingFocus.current?.();
    setEditor(next);
  };

  const restoreEditorFocus = () => {
    const fieldId = savedFieldId.current ?? anchorFieldId;
    const current = fieldId ? findFieldTrigger(fieldId) : null;
    const previous = initialTrigger?.isConnected ? initialTrigger : null;
    (current ?? previous)?.focus({ preventScroll: true });
    const contents = contentsRef.current;
    if (!fieldId || current || !contents?.isConnected) return;
    // Creation can close before either schema query renders the new header.
    // Observe the actual grid commit, bounded and canceled if the user moves on.
    cancelPendingFocus.current?.();
    const observer = new MutationObserver(() => {
      if (document.activeElement !== document.body && document.activeElement !== previous) {
        cancel();
        return;
      }
      const target = findFieldTrigger(fieldId);
      if (target && !target.disabled) {
        cancel();
        target.focus({ preventScroll: true });
      }
    });
    const cancel = () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      if (cancelPendingFocus.current === cancel) cancelPendingFocus.current = null;
    };
    const timeout = window.setTimeout(cancel, 2000);
    cancelPendingFocus.current = cancel;
    observer.observe(contents, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
  };

  useEffect(() => {
    const cancel = () => cancelPendingFocus.current?.();
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
    };
  }, []);

  useEffect(
    () =>
      subscribeTableEvents((event) => {
        if (
          event.type === 'tables.invalidated' ||
          (event.type === 'table.fields.changed' && event.tableId === tableId)
        ) {
          setNonce((value) => value + 1);
        }
      }),
    [tableId]
  );

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    Promise.all([tablesApi.get(tableId), tablesApi.fields(tableId)])
      .then(([nextDetail, { fields }]) => {
        if (canceled) return;
        setSnapshot({ detail: nextDetail, fields });
        setLoaded(true);
        onFieldsLoadedRef.current?.(fields);
      })
      .catch((err: unknown) => {
        if (!canceled) setError(getErrorMessage(err, 'Could not load fields'));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [tableId, nonce]);

  return (
    <div className={styles.customTable}>
      {loading && !loaded && <StateHint>Loading fields…</StateHint>}
      {error && (
        <StateHint variant="error">
          {error}{' '}
          <Button size="sm" onClick={() => setNonce((value) => value + 1)}>
            Retry fields
          </Button>
        </StateHint>
      )}
      <div className={styles.fieldLayout}>
        <div ref={contentsRef} className={styles.tableContents}>
          {view === 'board' && boardField ? (
            <TableBoard
              tableId={tableId}
              field={boardField}
              fields={snapshot.fields}
              sort={sort}
              where={where}
              onOpenEntry={(entryId) => onOpenEntry?.(entryId)}
              onRefreshFields={() => setNonce((value) => value + 1)}
            />
          ) : (
            <TableEntriesGrid
              tableId={tableId}
              focusEntryId={focusEntryId}
              focusRequestId={focusRequestId}
              onOpenEntry={onOpenEntry}
              sort={sort}
              onSortChange={onSortChange}
              where={where}
              viewFilter={viewFilter}
              onFilterChange={onFilterChange}
              columns={snapshot.detail.columns}
              fields={snapshot.fields}
              onEditField={
                editor || (loaded && !error)
                  ? (field, trigger) => openEditor({ field, trigger })
                  : undefined
              }
              onRemoveField={loaded && !error ? (field) => setRemoveTarget(field) : undefined}
              onAddField={(trigger, beforeFieldId) => openEditor({ trigger, beforeFieldId })}
              onRefreshFields={() => setNonce((value) => value + 1)}
              fieldControlsDisabled={loading || !loaded || !!error || !!editor}
              fieldEditorId={fieldEditorId}
              editingFieldId={editor ? (savedFieldId.current ?? editor.field?.id) : undefined}
              insertingFieldBoundary={
                editor && !editor.field && !savedFieldId.current
                  ? (editor.beforeFieldId ?? 'append')
                  : undefined
              }
              // A background schema reload keeps rows editable: drafts carry
              // their own schema version, and autosave rejects a stale one.
              editingDisabled={!!editor || !loaded || !!error}
              editingDisabledReason={editor ? 'Close field settings to edit entries.' : undefined}
            />
          )}
        </div>
        {editor && (
          <FieldEditorPopover
            id={fieldEditorId}
            label={
              editor.field || savedFieldId.current
                ? `Field settings: ${
                    snapshot.fields.find(
                      (field) => field.id === (savedFieldId.current ?? editor.field?.id)
                    )?.name ??
                    editor.field?.name ??
                    'New field'
                  }`
                : 'New field'
            }
            anchor={editor.trigger}
            resolveAnchor={resolveEditorTrigger}
            onRequestClose={() => requestCloseRef.current?.()}
          >
            <TableFieldEditor
              tableId={tableId}
              field={editor.field}
              beforeFieldId={editor.beforeFieldId}
              requestCloseRef={requestCloseRef}
              returnFocusTo={resolveEditorTrigger}
              onRestoreFocus={restoreEditorFocus}
              onPersisted={(field) => {
                savedFieldId.current = field.id;
              }}
              onClose={() => setEditor(null)}
            />
          </FieldEditorPopover>
        )}
      </div>
      {removeTarget && (
        <RemoveTableFieldModal
          fieldName={removeTarget.name}
          entryCount={snapshot.detail.rowCount}
          onArchive={archiveRemoveTarget}
          onDelete={deleteRemoveTarget}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
};
