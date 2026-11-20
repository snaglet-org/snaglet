import { useCallback, useEffect, useId, useRef, useState, type FC, type ReactNode } from 'react';
import {
  AUTOMATIONS_TABLE_ID,
  type TableCatalogEntry,
  type TableDetailResponse,
  type TableEntrySort,
  type TableEntryWhere,
  type TableField,
} from '@snaglet/shared/types';
import { formatTableName, getErrorMessage } from '@snaglet/shared/utils';
import { Button, Chip, Cluster, EmptyState, Segmented, Select } from '@desktop/components';
import { subscribeTableEvents, useTableRename } from '@desktop/features/database';
import { tableEntryState } from '@desktop/features/database/tableLifecycle';
import { useLiveTableName } from '@desktop/features/database/tableNameCache';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { TableEntryModal } from './TableEntryModal';
import { RenameInput } from '@desktop/features/workspace-tree/RenameInput';
import { archivedDrawerReachable, requestArchivedDrawer } from '../archivedDrawerRequest';
import { TableGrid } from './TableGrid';
import { AutomationsGrid } from '@desktop/features/automations/AutomationsGrid';
import { CustomTableFields } from './CustomTableFields';
import { TableProjectControl } from './TableProjectControl';
import { TableSemanticControl } from './TableSemanticControl';
import { TableSortBar, TableSortControl } from './TableSortControl';
import { TableFilterBar, TableFilterControl } from './TableFilterControl';
import { isComplete } from './tableFilterRules';
import {
  boardCandidateFields,
  boardUnavailableReason,
  readBoardFieldId,
  liveFilter,
  liveSort,
  readTableFilter,
  readTableSort,
  readTableViewMode,
  resolveBoardField,
  writeBoardFieldId,
  writeTableFilter,
  writeTableSort,
  writeTableViewMode,
  type TableViewMode,
} from './boardViewPreference';
import {
  stepActionLabel,
  TableUndoProvider,
  useTableUndoController,
  type TableUndoController,
} from './tableUndo';
import styles from './TableView.module.scss';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; detail: TableDetailResponse }
  | { status: 'archived' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

interface TableViewProps {
  tableId: string;
  focusEntryId?: string;
  /** Open this entry's window over the table (a quick search pick). */
  openEntryId?: string;
  focusRequestId?: number;
  /** Catalog entry cached on the selection — paints the title while loading. */
  initial?: TableCatalogEntry;
  /** Offered once the table is archived or gone, when the pane can close. */
  onClosePane?: () => void;
}

function entryCountLabel(count: number): string {
  return count === 1 ? '1 entry' : `${count.toLocaleString()} entries`;
}

/**
 * A saved Database table: custom fields and entries, or metadata-only Snaglet
 * columns. A custom table's title renames in place (double-click or F2; Enter
 * or blur saves, Escape discards); Snaglet tables keep a plain title. Archiving the
 * table turns the pane into a notice that opens the Archived drawer. A custom
 * table's pane offers the table undo history (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z,
 * the toolbar, and "Undo archive" / "Undo delete" on those notices). The
 * header's `TableProjectControl` links the table to a project, and
 * `TableSemanticControl` turns search by meaning on or off. Renames and
 * links made anywhere arrive as `table.updated`.
 */
export const TableView: FC<TableViewProps> = ({
  tableId,
  initial,
  focusEntryId,
  openEntryId,
  focusRequestId,
  onClosePane,
}) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const liveName = useLiveTableName(tableId).name;
  const rename = useTableRename();
  const editing = rename.tableId !== null;
  const renameErrorId = useId();
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasEditingRef = useRef(false);
  // A rename heard while the detail is still loading wins over the response,
  // the same merge rule the sidebar catalog applies to its first load.
  const heardRef = useRef<TableCatalogEntry | null>(null);
  const origin = state.status === 'ready' ? state.detail.table.origin : initial?.origin;
  const undo = useTableUndoController(tableId, origin !== 'builtin');
  // Grid or Board, and the Board's select field, remembered per table.
  const [view, setView] = useState<TableViewMode>(() => readTableViewMode(tableId));
  const [boardFieldId, setBoardFieldId] = useState<string | null>(() => readBoardFieldId(tableId));
  const [schemaFields, setSchemaFields] = useState<TableField[]>([]);
  const groupByLabelId = useId();

  useEffect(() => {
    setView(readTableViewMode(tableId));
    setBoardFieldId(readBoardFieldId(tableId));
    setSchemaFields([]);
  }, [tableId]);

  useEffect(() => {
    if (!focusEntryId) return;
    setView('grid');
  }, [focusEntryId, focusRequestId]);

  const chooseView = (next: TableViewMode) => {
    setView(next);
    writeTableViewMode(tableId, next);
  };
  const chooseBoardField = (fieldId: string) => {
    setBoardFieldId(fieldId);
    writeBoardFieldId(tableId, fieldId);
  };
  // A Board card or a Grid row's open control previews its entry in a
  // pane-contained modal; the view stays where it was.
  const [previewEntryId, setPreviewEntryId] = useState<string | null>(null);
  const openEntry = useCallback((entryId: string) => setPreviewEntryId(entryId), []);
  const closePreview = useCallback(() => setPreviewEntryId(null), []);
  useEffect(() => setPreviewEntryId(null), [tableId]);
  // After the reset above, so a pane opened on an entry starts with its window.
  useEffect(() => {
    if (openEntryId) setPreviewEntryId(openEntryId);
  }, [openEntryId, focusRequestId]);
  const boardCandidates = boardCandidateFields(schemaFields);
  const boardField = resolveBoardField(schemaFields, boardFieldId);
  const boardUnavailable = schemaFields.length ? boardUnavailableReason(schemaFields) : null;
  const effectiveView: TableViewMode = view === 'board' && boardField ? 'board' : 'grid';
  // Sort levels, remembered per table and per view (Grid and Board each their own).
  const [sorts, setSorts] = useState<{
    tableId: string;
    grid: TableEntrySort[];
    board: TableEntrySort[];
  }>(() => ({
    tableId,
    grid: readTableSort(tableId, 'grid'),
    board: readTableSort(tableId, 'board'),
  }));
  const storedSorts =
    sorts.tableId === tableId
      ? sorts
      : { tableId, grid: readTableSort(tableId, 'grid'), board: readTableSort(tableId, 'board') };
  // Until the fields load, levels are kept as saved; then dropped fields fall away.
  const viewSort = schemaFields.length
    ? liveSort(storedSorts[effectiveView], schemaFields)
    : storedSorts[effectiveView];
  const chooseSort = (next: TableEntrySort[]) => {
    setSorts({ ...storedSorts, [effectiveView]: next });
    writeTableSort(tableId, effectiveView, next);
  };
  // Filters, remembered per table and per view like sorts. Incomplete rows
  // (a blank value) stay in the panel but are not sent.
  const [filters, setFilters] = useState<{
    tableId: string;
    grid: TableEntryWhere[];
    board: TableEntryWhere[];
  }>(() => ({
    tableId,
    grid: readTableFilter(tableId, 'grid'),
    board: readTableFilter(tableId, 'board'),
  }));
  const storedFilters =
    filters.tableId === tableId
      ? filters
      : {
          tableId,
          grid: readTableFilter(tableId, 'grid'),
          board: readTableFilter(tableId, 'board'),
        };
  const viewFilter = schemaFields.length
    ? liveFilter(storedFilters[effectiveView], schemaFields)
    : storedFilters[effectiveView];
  const appliedFilter = viewFilter.filter((condition) =>
    isComplete(
      condition,
      schemaFields.find((field) => field.id === condition.fieldId)
    )
  );
  const chooseFilter = (next: TableEntryWhere[]) => {
    setFilters({ ...storedFilters, [effectiveView]: next });
    writeTableFilter(tableId, effectiveView, next);
  };

  useEffect(() => {
    let canceled = false;
    setState({ status: 'loading' });
    tablesApi
      .get(tableId)
      .then((detail) => {
        if (canceled) return;
        // An archived table still answers, marked `state: 'archived'`.
        const lifecycle = tableEntryState(detail.table);
        if (lifecycle !== 'active') {
          setState({ status: lifecycle === 'archived' ? 'archived' : 'missing' });
          return;
        }
        const heard = heardRef.current?.id === tableId ? heardRef.current : null;
        setState({ status: 'ready', detail: heard ? { ...detail, table: heard } : detail });
      })
      .catch((err: unknown) => {
        if (canceled) return;
        if (err instanceof FetchError && err.status === 404) {
          setState({ status: 'missing' });
          return;
        }
        setState({ status: 'error', message: getErrorMessage(err, 'Could not load this table') });
      });
    return () => {
      canceled = true;
    };
  }, [tableId, reload]);

  useEffect(
    () =>
      subscribeTableEvents((event) => {
        if (event.type === 'table.removed' && event.tableId === tableId) {
          setState({ status: event.state === 'archived' ? 'archived' : 'missing' });
          return;
        }
        if (event.type === 'table.restored' && event.table.id === tableId) {
          // Reload: the restore may carry a new name, and the pane may have
          // been showing the archived notice.
          heardRef.current = event.table;
          setReload((value) => value + 1);
          return;
        }
        if (event.type !== 'table.updated' || event.table.id !== tableId) return;
        heardRef.current = event.table;
        setState((previous) =>
          previous.status === 'ready'
            ? { status: 'ready', detail: { ...previous.detail, table: event.table } }
            : previous
        );
      }),
    [tableId]
  );

  // Focus the field when editing starts; when it ends with focus left
  // nowhere (Enter or Escape), hand it back to the title.
  useEffect(() => {
    if (editing) {
      wasEditingRef.current = true;
      return;
    }
    if (!wasEditingRef.current) return;
    wasEditingRef.current = false;
    const focused = document.activeElement;
    if (!focused || focused === document.body) titleButtonRef.current?.focus();
  }, [editing]);

  if (state.status === 'archived') {
    const offerArchive = archivedDrawerReachable();
    const undoArchive = lifecycleUndo(undo, tableId, 'table.archive');
    return (
      <TableUndoProvider value={undo}>
        <EmptyState
          title="This table is archived"
          body="Restore it from the Archived drawer to use it again."
          action={
            offerArchive || onClosePane || undoArchive ? (
              <Cluster gap={2}>
                {undoArchive}
                {offerArchive && (
                  <Button variant="neutral" size="sm" onClick={requestArchivedDrawer}>
                    Open Archived
                  </Button>
                )}
                {onClosePane && (
                  <Button variant="ghost" size="sm" onClick={onClosePane}>
                    Close pane
                  </Button>
                )}
              </Cluster>
            ) : undefined
          }
        />
      </TableUndoProvider>
    );
  }

  if (state.status === 'missing') {
    const undoDelete = lifecycleUndo(undo, tableId, 'table.delete');
    return (
      <TableUndoProvider value={undo}>
        <EmptyState
          title="Table unavailable"
          body="It may have been removed. Select another table from the Database sidebar."
          action={
            onClosePane || undoDelete ? (
              <Cluster gap={2}>
                {undoDelete}
                {onClosePane && (
                  <Button variant="ghost" size="sm" onClick={onClosePane}>
                    Close pane
                  </Button>
                )}
              </Cluster>
            ) : undefined
          }
        />
      </TableUndoProvider>
    );
  }

  const loaded = state.status === 'ready' ? state.detail.table : initial;
  const table =
    loaded && liveName && liveName !== loaded.name ? { ...loaded, name: liveName } : loaded;
  // Only a loaded custom table offers rename; its origin is then canonical.
  const renamable = state.status === 'ready' && state.detail.table.origin === 'custom';

  let title: ReactNode;
  if (editing) {
    title = (
      <div className={styles.titleField}>
        <RenameInput
          className={styles.titleInput}
          initialValue={rename.originalName ?? table?.name ?? ''}
          onCommit={rename.submit}
          onCancel={rename.cancel}
          onValueChange={rename.change}
          format={formatTableName}
          busy={rename.saving}
          errorId={rename.error ? renameErrorId : undefined}
        />
        {rename.error && (
          <p className={styles.renameError} role="alert" id={renameErrorId}>
            {rename.error}
          </p>
        )}
      </div>
    );
  } else if (renamable && table) {
    title = (
      <h1 className={styles.title}>
        <button
          ref={titleButtonRef}
          type="button"
          className={styles.titleButton}
          title="Double-click to rename"
          onDoubleClick={() => rename.begin(table)}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault();
              rename.begin(table);
            }
          }}
        >
          {table.name}
        </button>
      </h1>
    );
  } else {
    title = <h1 className={styles.title}>{table?.name ?? 'Table'}</h1>;
  }

  return (
    <TableUndoProvider value={undo}>
      <div className={styles.shell}>
        <header className={styles.header}>
          {table?.origin === 'builtin' ? (
            <div className={styles.heading}>
              {title}
              <Chip size="xs" tone="muted">
                Snaglet managed
              </Chip>
            </div>
          ) : renamable ? (
            <div className={styles.heading}>
              {title}
              <TableProjectControl table={state.detail.table} />
              <TableSemanticControl table={state.detail.table} />
              <div className={styles.viewControls}>
                {schemaFields.length > 0 && (
                  <TableFilterControl
                    fields={schemaFields}
                    where={viewFilter}
                    onChange={chooseFilter}
                  />
                )}
                {schemaFields.length > 0 && (
                  <TableSortControl fields={schemaFields} sort={viewSort} onChange={chooseSort} />
                )}
                {boardCandidates.length > 1 && effectiveView === 'board' && boardField && (
                  <label className={styles.groupBy}>
                    <span id={groupByLabelId} className={styles.groupByLabel}>
                      Group by
                    </span>
                    <Select
                      size="sm"
                      aria-labelledby={groupByLabelId}
                      value={boardField.id}
                      onChange={(event) => chooseBoardField(event.target.value)}
                    >
                      {boardCandidates.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <Segmented
                  size="sm"
                  aria-label="Table view"
                  value={effectiveView}
                  onChange={(next) => chooseView(next === 'board' ? 'board' : 'grid')}
                >
                  <Segmented.Option value="grid">Grid</Segmented.Option>
                  <Segmented.Option
                    value="board"
                    disabled={!!boardUnavailable || !schemaFields.length}
                    title={boardUnavailable ?? undefined}
                  >
                    Board
                  </Segmented.Option>
                </Segmented>
                {boardUnavailable && (
                  <span className={styles.viewHint} role="note">
                    {boardUnavailable}
                  </span>
                )}
              </div>
            </div>
          ) : (
            title
          )}
          {renamable && schemaFields.length > 0 && (
            <TableFilterBar fields={schemaFields} where={viewFilter} onChange={chooseFilter} />
          )}
          {renamable && schemaFields.length > 0 && (
            <TableSortBar fields={schemaFields} sort={viewSort} onChange={chooseSort} />
          )}
        </header>
        <div className={styles.body}>
          {state.status === 'loading' && <StateHint>Loading table…</StateHint>}
          {state.status === 'error' && (
            <StateHint variant="error">
              <p>{state.message}</p>
              <Button size="sm" onClick={() => setReload((value) => value + 1)}>
                Retry loading table
              </Button>
            </StateHint>
          )}
          {state.status === 'ready' && (
            <TableBody
              detail={state.detail}
              focusEntryId={focusEntryId}
              focusRequestId={focusRequestId}
              view={effectiveView}
              boardField={boardField}
              sort={viewSort}
              onSortChange={chooseSort}
              where={appliedFilter}
              viewFilter={viewFilter}
              onFilterChange={chooseFilter}
              onFieldsLoaded={setSchemaFields}
              onOpenEntry={openEntry}
            />
          )}
        </div>
        {state.status === 'ready' && previewEntryId && schemaFields.length > 0 && (
          <TableEntryModal
            key={previewEntryId}
            tableId={tableId}
            entryId={previewEntryId}
            fields={schemaFields}
            onClose={closePreview}
          />
        )}
      </div>
    </TableUndoProvider>
  );
};

/**
 * "Undo archive" / "Undo delete" for this table's notice, when that is the
 * user's next undo step; null otherwise.
 */
function lifecycleUndo(
  undo: TableUndoController,
  tableId: string,
  kind: 'table.archive' | 'table.delete'
): ReactNode {
  const step = undo.undo;
  if (!step || step.kind !== kind || !step.tableIds.includes(tableId)) return null;
  return (
    <Button
      variant="neutral"
      size="sm"
      disabled={undo.busy}
      title={stepActionLabel('Undo', step)}
      onClick={() => void undo.run('undo', step)}
    >
      {kind === 'table.archive' ? 'Undo archive' : 'Undo delete'}
    </Button>
  );
}

const TableBody: FC<{
  detail: TableDetailResponse;
  focusEntryId?: string;
  focusRequestId?: number;
  view: TableViewMode;
  boardField: TableField | null;
  sort: TableEntrySort[];
  onSortChange: (sort: TableEntrySort[]) => void;
  where: TableEntryWhere[];
  viewFilter: TableEntryWhere[];
  onFilterChange: (where: TableEntryWhere[]) => void;
  onFieldsLoaded: (fields: TableField[]) => void;
  onOpenEntry: (entryId: string) => void;
}> = ({
  detail,
  focusEntryId,
  focusRequestId,
  view,
  boardField,
  sort,
  onSortChange,
  where,
  viewFilter,
  onFilterChange,
  onFieldsLoaded,
  onOpenEntry,
}) => {
  const { table, columns, rowCount } = detail;
  // The Automations table has its own read-only grid with row actions.
  if (table.id === AUTOMATIONS_TABLE_ID) return <AutomationsGrid />;
  if (table.origin === 'builtin') {
    return (
      <TableGrid
        columns={columns}
        emptyTitle={entryCountLabel(rowCount)}
        emptyNote="Snaglet manages this table. Browsing its entries comes later."
      />
    );
  }
  return (
    <CustomTableFields
      key={table.id}
      detail={detail}
      focusEntryId={focusEntryId}
      focusRequestId={focusRequestId}
      view={view}
      boardField={boardField}
      sort={sort}
      onSortChange={onSortChange}
      where={where}
      viewFilter={viewFilter}
      onFilterChange={onFilterChange}
      onFieldsLoaded={onFieldsLoaded}
      onOpenEntry={onOpenEntry}
    />
  );
};
