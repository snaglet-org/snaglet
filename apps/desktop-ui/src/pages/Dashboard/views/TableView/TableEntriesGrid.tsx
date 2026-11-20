import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { flushSync } from 'react-dom';
import {
  TABLE_RELATION_MAX_LINKS,
  type TableColumnSummary,
  type TableEntry,
  type TableEntrySort,
  type TableEntryValue,
  type TableEntryWhere,
  type TableField,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Checkbox, type CheckboxModifiers } from '@desktop/components';
import { PlusIcon, RefreshIcon } from '@desktop/components/Icons';
import { emitTableEvent } from '@desktop/features/database';
import { newestTableStep, stepTableHistory } from '@desktop/features/database/tableHistory';
import {
  usePaneFindMemory,
  usePaneFindShortcut,
  usePaneIsActive,
} from '@desktop/features/pane-find/PaneFindContext';
import { primeEntryPositions, untitledEntryLabel } from '@desktop/features/table-entries';
import { tablesApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { nodeToChipMarkdown, type NodeChipData } from '@desktop/utils/nodeChip';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { EntryCellEditor } from './cells/EntryCellEditor';
import { SelectEntryPicker } from './SelectEntryPicker';
import { EntryCell } from './cells/EntryCell';
import { CheckboxCellValue } from './cells/CheckboxCellValue';
import { RELATION_LIMIT_PROBLEM, relatedChipEntryId, type ChipDropResult } from './cells/chipDrop';
import { entryValueList } from './entryValueList';
import { pageRowNumbers } from './entryRows';
import { RelationEntryPicker, entryLabel } from './RelationEntryPicker';
import { TableEntryValueView } from './TableEntryValueView';
import { RepeatCellText } from './repeat/RepeatCellText';
import { cellWall } from './repeat/useEntryRepeats';
import { cellRepeatKey, useTableRepeats } from './repeat/useTableRepeats';
import { TableEntryDelete } from './TableEntryDelete';
import { EntryReferenceControl } from './EntryReferenceControl';
import { TableGrid } from './TableGrid';
import { TablePagerBar } from './TablePagerBar';
import { TableEntrySearch } from './TableEntrySearch';
import { TableHiddenFields } from './TableHiddenFields';
import { TableUndoButtons } from './TableUndoButtons';
import { isTextEditingTarget, useTableUndo } from './tableUndo';
import { useTableEntries } from './useTableEntries';
import { useEntryDraft } from './useEntryDraft';
import { useFieldView } from './useFieldView';
import { nextRowSelection, type RowSelectionAnchor } from './rowSelection';
import {
  clearTextSelection,
  copyRows,
  hasCopiedRows,
  pasteValues,
  readCopiedRows,
  useRowClipboardShortcuts,
  type RowClipboardHandlers,
} from './rowClipboard';
import styles from './TableEntries.module.scss';

interface Props {
  tableId: string;
  focusEntryId?: string;
  focusRequestId?: number;
  columns: TableColumnSummary[];
  fields: TableField[];
  onEditField?: (field: TableField, trigger: HTMLButtonElement) => void;
  onRemoveField?: (field: TableField, trigger: HTMLButtonElement) => void;
  onAddField?: (trigger: HTMLButtonElement, beforeFieldId?: string) => void;
  onRefreshFields?: () => void;
  fieldEditorId?: string;
  editingFieldId?: string;
  insertingFieldBoundary?: string;
  fieldControlsDisabled?: boolean;
  editingDisabled?: boolean;
  editingDisabledReason?: string;
  /** Preview a saved entry in the pane's entry modal. */
  onOpenEntry?: (entryId: string) => void;
  /** Sort levels; empty keeps the table's row order. */
  sort?: TableEntrySort[];
  /** Header sort toggles call this with the whole new sort. */
  onSortChange?: (sort: TableEntrySort[]) => void;
  /** Field filters; every one must match. */
  where?: TableEntryWhere[];
  /** The view's whole filter (incomplete conditions too), shown on the header filters. */
  viewFilter?: TableEntryWhere[];
  /** Header filters call this with the whole new filter. */
  onFilterChange?: (where: TableEntryWhere[]) => void;
}

function orderFields(fields: TableField[], ids: string[]): TableField[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...fields].sort(
    (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length)
  );
}

const cellKey = (entryId: string, fieldId: string) => `${entryId}:${fieldId}`;

const rowCount = (count: number) => `${count} ${count === 1 ? 'row' : 'rows'}`;

/** Controls that act on the open cell (its save-error actions) keep it open. */
const KEEPS_CELL = '[data-active-cell], [data-keeps-cell]';

/**
 * A custom table's entries, edited in place like a spreadsheet. A click edits
 * one cell and the row autosaves; Enter, Tab or a click elsewhere in the grid
 * leaves the cell, Escape reverts it, and clicks outside the grid (browsing
 * for chips) keep it open. New rows are created at once. Headers drag to
 * reorder and resize fields. Row checkboxes select rows (Shift for a range,
 * Cmd/Ctrl to toggle one) for copy and paste (see rowClipboard.ts). The
 * toolbar search filters on the server across every page; a row created or
 * edited while searching stays listed until the search changes.
 */
export function TableEntriesGrid({
  tableId,
  focusEntryId,
  focusRequestId,
  columns: initialColumns,
  fields: initialFields,
  onEditField,
  onRemoveField,
  onAddField,
  onRefreshFields,
  fieldEditorId,
  editingFieldId,
  insertingFieldBoundary,
  fieldControlsDisabled,
  editingDisabled,
  editingDisabledReason,
  onOpenEntry,
  sort,
  onSortChange,
  where,
  viewFilter,
  onFilterChange,
}: Props) {
  const [rememberedQuery, rememberQuery] = usePaneFindMemory(`table-entries:${tableId}`);
  const query = useTableEntries(tableId, { initialQuery: rememberedQuery, sort, where });
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const restoreDeleteFocus = useRef(false);
  const returnFocus = useRef<string | null>(null);
  const checkboxCreateFocus = useRef<{ fieldId: string; origin: Element | null } | null>(null);
  const checkboxSavedFocus = useRef<{
    entryId: string;
    fieldId: string;
    origin: Element | null;
  } | null>(null);
  const reorderSeq = useRef(0);
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [insertHover, setInsertHover] = useState<string | null>(null);
  const [selection, setSelection] = useState({ page: '', ids: new Set<string>() });
  // The row a Shift-click ranges from, on the page it was set on.
  const selectionAnchor = useRef<(RowSelectionAnchor & { page: string }) | null>(null);
  const [deleteEntries, setDeleteEntries] = useState<Array<
    Pick<TableEntry, 'id' | 'revision'>
  > | null>(null);
  const [deleteImmediate, setDeleteImmediate] = useState(false);
  const [preparingDelete, setPreparingDelete] = useState(false);
  const [refreshingSchema, setRefreshingSchema] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null);
  const [highlightedEntry, setHighlightedEntry] = useState<string | null>(null);
  const prepareDeleteRef = useRef(false);
  const pastingRef = useRef(false);
  const entrySnapshot = useRef(new Map<string, TableEntry>());
  const edit = useEntryDraft(tableId, (saved, created, beforeEntryId) => {
    if (created && checkboxCreateFocus.current) {
      checkboxSavedFocus.current = { ...checkboxCreateFocus.current, entryId: saved.id };
      checkboxCreateFocus.current = null;
    }
    entrySnapshot.current.set(saved.id, saved);
    query.keepEntry(saved.id);
    query.upsertEntry(saved, created ? { beforeEntryId } : undefined);
  });
  const { draft } = edit;
  const closeRef = useRef(edit.close);
  closeRef.current = edit.close;
  const editRef = useRef(edit);
  editRef.current = edit;
  const seek = query.focusEntry;
  const setSearch = query.setQuery;

  useEffect(() => rememberQuery(query.q), [query.q, rememberQuery]);

  // Undo and redo first save the open row, then drop it so the grid shows
  // what the step leaves; a row that cannot save blocks the step.
  const undoPrepareRef = useTableUndo()?.prepareRef;
  useEffect(() => {
    if (!undoPrepareRef) return;
    const prepare = async () => {
      if (!editRef.current.draft) return 'ready' as const;
      if (!(await editRef.current.flush())) {
        editRef.current.focusFirstInvalid();
        showToast('Fix or discard the open row before undoing or redoing.', { durationMs: 4000 });
        return 'blocked' as const;
      }
      editRef.current.cancel();
      return 'saved' as const;
    };
    undoPrepareRef.current = prepare;
    return () => {
      if (undoPrepareRef.current === prepare) undoPrepareRef.current = null;
    };
  }, [undoPrepareRef]);
  usePaneFindShortcut(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });

  const requestEntryFocus = useCallback(
    async (id: string, canceled: () => boolean = () => false) => {
      setNavigationNotice(null);
      const startingDraftId = editRef.current.draft?.id;
      if (!(await editRef.current.flush())) {
        if (!canceled())
          setNavigationNotice('Save or discard this edit before opening the linked entry.');
        return;
      }
      if (canceled()) return;
      const latestDraft = editRef.current.draft;
      if (latestDraft && latestDraft.id !== startingDraftId) {
        setNavigationNotice('Save or discard this edit before opening the linked entry.');
        return;
      }
      editRef.current.cancel();
      seek(id);
    },
    [seek]
  );

  useEffect(() => {
    if (!focusEntryId) return;
    let canceled = false;
    void requestEntryFocus(focusEntryId, () => canceled);
    return () => {
      canceled = true;
    };
  }, [focusEntryId, focusRequestId, requestEntryFocus]);

  useEffect(() => {
    setHighlightedEntry(null);
    if (!query.focusedEntry) return;
    const id = query.focusedEntry.id;
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        rootRef.current?.querySelectorAll<HTMLTableRowElement>('[data-entry-id]') ?? []
      ).find((element) => element.dataset.entryId === id);
      row?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      row?.focus({ preventScroll: true });
      setHighlightedEntry(id);
    });
    const timer = window.setTimeout(() => setHighlightedEntry(null), 1800);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [query.focusedEntry]);

  const result = query.result;
  const baseFields = result?.fields ?? initialFields;
  const fieldView = useFieldView(tableId, baseFields, query.reload, {
    latestRequest: query.latestRequest,
    completedRequest: query.completedRequest,
  });
  // Validation may focus a field hidden before this draft began. Keep that
  // recovery editor visible without rewriting the saved view preference.
  const visibleFields = fieldView.fields.map((field) =>
    field.collapsed && field.id === draft?.focusFieldId ? { ...field, collapsed: false } : field
  );
  const fields = pendingOrder ? orderFields(visibleFields, pendingOrder) : visibleFields;
  // Hidden fields (saved as `collapsed`) leave the grid entirely; the
  // toolbar's Hidden fields menu shows them again.
  const shownFields = fields.filter((field) => !field.collapsed);
  const hiddenFields = fields.filter((field) => field.collapsed);
  // Repeating cells read as their next occurrence, marked when overdue.
  const tableRepeats = useTableRepeats(
    tableId,
    baseFields.some((field) => field.recurrence)
  );
  const columns = [
    ...shownFields.map((field) => ({
      name: field.columnName,
      dataType: field.type,
      nullable: field.nullable,
      managed: field.managed,
    })),
    ...initialColumns.filter((column) => !fields.some((field) => field.columnName === column.name)),
  ];
  const fieldByColumn = new Map(fields.map((field) => [field.columnName, field]));
  const editableFields = fields.filter((field) => !field.managed);
  // A background reload keeps the grid usable; only a missing page blocks it.
  const blocked =
    !!editingDisabled ||
    edit.reloading ||
    refreshingSchema ||
    query.seeking ||
    !!query.error ||
    !result;
  const blockedReason = editingDisabled
    ? editingDisabledReason
    : query.seeking
      ? 'Opening the linked entry…'
      : undefined;
  const samePage = result?.page === query.page && result?.pageSize === query.pageSize;
  const entries = samePage ? result.entries : [];
  // "Untitled N" labels use the global row number, so they match across pages.
  const positions = new Map(samePage ? pageRowNumbers(result) : []);
  const nameField = fields.find((field) => field.isTitle && !field.managed);
  const displayed =
    draft?.original && !entries.some((entry) => entry.id === draft.id)
      ? [...entries, draft.original]
      : entries;
  entrySnapshot.current = new Map(displayed.map((entry) => [entry.id, entry]));
  const unsaved = draft && !draft.original ? draft : null;
  const unsavedAt = unsaved?.beforeEntryId
    ? displayed.findIndex((entry) => entry.id === unsaved.beforeEntryId)
    : -1;
  const lastPage = Math.max(1, Math.ceil((result?.totalCount ?? 0) / query.pageSize));
  const noMatches =
    samePage && query.filtered && result.totalCount === 0 && !displayed.length && !unsaved;
  const showGhostRow = samePage && query.page >= lastPage && !noMatches;
  const activeKey = draft?.focusFieldId ? cellKey(draft.id, draft.focusFieldId) : null;
  const pageKey = `${query.page}:${query.pageSize}:${query.q}`;
  const selectedIds = selection.page === pageKey ? selection.ids : new Set<string>();
  const selectedCount = displayed.filter((entry) => selectedIds.has(entry.id)).length;
  const allSelected = displayed.length > 0 && selectedCount === displayed.length;

  // Backspace/Delete removes the checked rows in the active pane. Bound on
  // window (like the undo shortcuts) because clicking a row checkbox leaves
  // focus on the page body. Stands down while typing in any text field, in
  // the sidebar, with a dialog open, or while a delete is in flight.
  const paneActive = usePaneIsActive();
  const keyDelete = useRef({ ready: false, run: () => {} });
  keyDelete.current = {
    ready: selectedCount > 0 && !blocked && !preparingDelete && !deleteEntries,
    run: () => void confirmDelete(true),
  };
  useEffect(() => {
    if (!paneActive) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.defaultPrevented || !keyDelete.current.ready) return;
      if (document.querySelector('[role="dialog"]')) return;
      const focused = document.activeElement;
      if (isTextEditingTarget(event.target) || isTextEditingTarget(focused)) return;
      if (focused instanceof Element && focused.closest('#dashboard-sidebar')) return;
      event.preventDefault();
      keyDelete.current.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneActive]);

  useEffect(() => {
    if (deleteEntries || !restoreDeleteFocus.current) return;
    const frame = requestAnimationFrame(() => {
      restoreDeleteFocus.current = false;
      const target = selectAllRef.current;
      (target && !target.disabled ? target : rootRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [deleteEntries]);

  useEffect(() => {
    setSelection((current) =>
      current.page === pageKey ? current : { page: pageKey, ids: new Set<string>() }
    );
  }, [pageKey]);

  // Chips of this table's entries elsewhere reuse the page's row numbers.
  useEffect(() => {
    if (result) primeEntryPositions(tableId, pageRowNumbers(result));
  }, [tableId, result]);

  /** Shift ranges from the anchor in the order shown; see nextRowSelection. */
  function selectEntry(
    id: string,
    checked: boolean,
    modifiers: Pick<CheckboxModifiers, 'shiftKey' | 'metaKey' | 'ctrlKey'>
  ) {
    setDeleteNotice(null);
    clearTextSelection();
    const anchor = selectionAnchor.current;
    const next = nextRowSelection({
      order: displayed.map((entry) => entry.id),
      selected: selectedIds,
      anchor: anchor?.page === pageKey ? anchor : null,
      id,
      checked,
      modifiers,
    });
    selectionAnchor.current = { ...next.anchor, page: pageKey };
    setSelection({ page: pageKey, ids: next.ids });
  }

  /** Shift+Space on a focused row, or its checkbox, extends like a Shift-click. */
  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, id: string) {
    if (event.key !== ' ' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const target = event.target;
    const onRow =
      target === event.currentTarget ||
      (target instanceof HTMLInputElement && !!target.closest('[data-row-select]'));
    if (!onRow || blocked) return;
    event.preventDefault();
    selectEntry(id, !selectedIds.has(id), { shiftKey: true, metaKey: false, ctrlKey: false });
  }

  // Cmd/Ctrl+C and Cmd/Ctrl+V on the checked rows, in the active pane. Both
  // stand down while a cell is open; see rowClipboard.ts for the rest.
  const rowClipboard = useRef<RowClipboardHandlers>({ copy: () => false, paste: () => false });
  rowClipboard.current = {
    copy: () => {
      if (activeKey || !selectedCount) return false;
      const rows = displayed.filter((entry) => selectedIds.has(entry.id));
      void copyRows({
        tableId,
        entries: rows,
        fields: baseFields,
        visibleFields: fields.filter((field) => !field.collapsed),
        relations: { relatedEntries: result?.relatedEntries, relatedItems: result?.relatedItems },
      });
      showToast(`Copied ${rowCount(rows.length)}`);
      return true;
    },
    paste: () => {
      if (activeKey || !hasCopiedRows()) return false;
      void pasteRows();
      return true;
    },
  };
  useRowClipboardShortcuts(paneActive, rowClipboard);

  /**
   * New rows with the copied rows' values, in their order, right after the
   * last checked row (or the last copied one shown); appended when the grid
   * is sorted or neither is on this page. They come back checked, and the
   * toast's Undo takes back the paste's history step.
   */
  async function pasteRows() {
    if (pastingRef.current) return;
    pastingRef.current = true;
    try {
      const found = await readCopiedRows(tableId);
      if (!found) return;
      if (found.kind === 'otherTable') {
        showToast('Paste rows into the table they came from.');
        return;
      }
      if (found.kind === 'unverified') {
        showToast('Copy the rows again to paste them here.');
        return;
      }
      if (blocked || !result || deleteEntries || prepareDeleteRef.current) {
        showToast(blockedReason ?? 'Rows can’t be pasted right now. Try again in a moment.', {
          durationMs: 4000,
        });
        return;
      }
      if (draft && !(await edit.flush())) {
        edit.focusFirstInvalid();
        showToast('Fix or discard the open row before pasting rows.', { durationMs: 4000 });
        return;
      }
      const shown = displayed.map((entry) => entry.id);
      const anchor =
        [...shown].reverse().find((id) => selectedIds.has(id)) ??
        [...found.copy.sourceIds].reverse().find((id) => shown.includes(id));
      const sorted = !!sort?.length;
      const response = await tablesApi.createEntries(tableId, {
        entries: pasteValues(found.copy, result.fields).map((values) => ({
          id: crypto.randomUUID(),
          values,
        })),
        schemaVersion: result.schemaVersion,
        ...(anchor && !sorted ? { afterEntryId: anchor } : {}),
      });
      const ids = response.entries.map((entry) => entry.id);
      for (const id of ids) query.keepEntry(id);
      // Appended past this page: follow them to the last page and check them there.
      const follow = !anchor && !sorted;
      const landing = follow
        ? `${Math.max(1, Math.ceil((result.totalCount + ids.length) / query.pageSize))}:${query.pageSize}:${query.q}`
        : pageKey;
      query.insertEntries(response.entries, { afterEntryId: anchor, follow });
      setDeleteNotice(null);
      setSelection({ page: landing, ids: new Set(ids) });
      const last = ids[ids.length - 1];
      selectionAnchor.current = last ? { id: last, base: null, page: landing } : null;
      if (ids[0])
        emitTableEvent({ type: 'table.entries.changed', tableId, entryId: ids[0], entryIds: ids });
      const message = `Pasted ${rowCount(ids.length)}`;
      const step = await newestTableStep(tableId, 'entry.write');
      if (!step) {
        showToast(`${message}. To undo it, use the table's history.`, { durationMs: 6000 });
        return;
      }
      showToast(message, {
        action: {
          label: 'Undo',
          run: () => void stepTableHistory('undo', { expected: step, tableId }),
        },
      });
    } catch (err) {
      showToast(getErrorMessage(err, 'Could not paste the rows.'), { durationMs: 4000 });
    } finally {
      pastingRef.current = false;
    }
  }

  /** `immediate`: a keyboard delete, undoable, so no plain confirm (see TableEntryDelete). */
  async function confirmDelete(immediate = false) {
    if (prepareDeleteRef.current) return;
    const targets = displayed.filter((entry) => selectedIds.has(entry.id));
    if (!targets.length) return;
    prepareDeleteRef.current = true;
    setPreparingDelete(true);
    setDeleteNotice(null);
    try {
      const targetIds = new Set(targets.map((target) => target.id));
      const draftTouchesTargets =
        draft &&
        (targetIds.has(draft.id) || (draft.beforeEntryId && targetIds.has(draft.beforeEntryId)));
      if (draftTouchesTargets && !(await edit.flush())) {
        setDeleteNotice('Save or discard the edit affecting these entries before deleting.');
        edit.focusFirstInvalid();
        return;
      }
      if (draft && !draftTouchesTargets) setDeleteNotice('The separate row draft will be kept.');
      setDeleteImmediate(immediate);
      setDeleteEntries(
        targets.map((target) => {
          const entry = entrySnapshot.current.get(target.id) ?? target;
          return { id: entry.id, revision: entry.revision };
        })
      );
    } finally {
      prepareDeleteRef.current = false;
      setPreparingDelete(false);
    }
  }

  // A press elsewhere inside the grid leaves the active cell. Presses outside
  // it (the sidebar, another pane) keep the cell open for chip browsing, and
  // the save-error controls act on the open cell rather than closing it.
  useEffect(() => {
    if (!activeKey) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !rootRef.current?.contains(target)) return;
      if (target.closest(KEEPS_CELL)) return;
      void closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [activeKey]);

  // Enter and Escape hand focus back to the cell they closed.
  useEffect(() => {
    const key = returnFocus.current;
    if (!key || activeKey) return;
    returnFocus.current = null;
    rootRef.current?.querySelector<HTMLElement>(`[data-cell="${key}"]`)?.focus();
  });

  useEffect(() => {
    const target = checkboxSavedFocus.current;
    if (!target) return;
    checkboxSavedFocus.current = null;
    // A completed create follows the user into that row, unless they have
    // deliberately focused something else while it was saving.
    if (document.activeElement !== target.origin && document.activeElement !== document.body)
      return;
    rootRef.current
      ?.querySelector<HTMLInputElement>(
        `[data-entry-id="${target.entryId}"] [data-checkbox-field="${target.fieldId}"] input`
      )
      ?.focus({ preventScroll: true });
  });

  /** Open `fieldId` on the row; dropped `chips` (in order) are added to its value as it opens. */
  async function begin(
    entry: TableEntry | null,
    fieldId?: string,
    beforeEntryId?: string,
    chips: readonly NodeChipData[] = [],
    draftId?: string
  ): Promise<boolean> {
    if (blocked || !result) return false;
    const target =
      fieldId ??
      fields.find((field) => !field.managed && !field.collapsed)?.id ??
      editableFields[0]?.id;
    const targetField = fields.find((field) => field.id === target);
    const relatedEntryIds = chips.map((chip) => relatedChipEntryId(targetField, chip));
    if (targetField?.type !== 'text' && relatedEntryIds.some((id) => !id)) return false;
    if (targetField?.collapsed && !(await fieldView.toggle(targetField))) return false;
    const addChip = (previous: TableEntryValue, chip: NodeChipData, i: number): TableEntryValue => {
      const relatedEntryId = relatedEntryIds[i];
      if (relatedEntryId) {
        if (!targetField?.multiple) return relatedEntryId;
        const linked = entryValueList(previous);
        return linked.some((id) => id.toLowerCase() === relatedEntryId) ||
          linked.length >= TABLE_RELATION_MAX_LINKS
          ? linked
          : [...linked, relatedEntryId];
      }
      const text = typeof previous === 'string' ? previous : '';
      return `${text}${text && !/\s$/.test(text) ? ' ' : ''}${nodeToChipMarkdown(chip)}`;
    };
    return edit.begin(entry, result.fields, result.schemaVersion, target, {
      beforeEntryId,
      draftId,
      ...(chips.length > 0
        ? { updateValue: (previous) => chips.reduce<TableEntryValue>(addChip, previous) }
        : {}),
    });
  }

  const insertAtTop = () => void begin(null, undefined, entries[0]?.id);

  /** A multiple relation the new entries would overfill refuses them instead of failing its autosave. */
  function dropChip(
    entry: TableEntry | null,
    field: TableField,
    chips: NodeChipData[],
    draftId?: string
  ): Promise<ChipDropResult> {
    const relatedEntryIds = chips.flatMap((chip) => relatedChipEntryId(field, chip) ?? []);
    if (relatedEntryIds.length > 0 && field.multiple) {
      const rowDraft = draft && draft.id === (entry?.id ?? draftId) ? draft : null;
      const linked = entryValueList(
        (rowDraft ? rowDraft.values[field.id] : entry?.values[field.id]) ?? null
      );
      const adding = new Set(
        relatedEntryIds.filter((relatedEntryId) =>
          linked.every((id) => id.toLowerCase() !== relatedEntryId)
        )
      );
      if (linked.length + adding.size > TABLE_RELATION_MAX_LINKS)
        return Promise.resolve(RELATION_LIMIT_PROBLEM);
    }
    return begin(entry, field.id, undefined, chips, draftId);
  }

  async function toggleCheckbox(entry: TableEntry | null, field: TableField, draftId?: string) {
    if (blocked || !result || deleteEntries || prepareDeleteRef.current) return;
    const origin = document.activeElement;
    const accepted = await edit.begin(entry, result.fields, result.schemaVersion, field.id, {
      draftId,
      editCell: false,
      updateValue: (previous) => previous !== true,
    });
    if (accepted && !entry) {
      checkboxCreateFocus.current = { fieldId: field.id, origin };
      if (!(await edit.flush())) {
        checkboxCreateFocus.current = null;
        edit.focusFirstInvalid();
      }
    }
  }

  async function toggleField(field: TableField) {
    // A failed/invalid draft must retain its visible recovery editor.
    if (!field.collapsed && draft && !(await edit.flush())) return;
    if (!field.collapsed) await edit.close();
    await fieldView.toggle(field);
  }

  async function reorderColumns(columnNames: string[]) {
    const shownIds = columnNames
      .map((name) => fieldByColumn.get(name)?.id)
      .filter((id): id is string => !!id);
    if (shownIds.length !== shownFields.length) return;
    // Hidden fields keep their slots; the shown ones fill theirs in the new order.
    const queue = [...shownIds];
    const ids = fields.map((field) => (field.collapsed ? field.id : (queue.shift() ?? field.id)));
    const seq = ++reorderSeq.current;
    const viewCheckpoint = fieldView.checkpoint();
    setPendingOrder(ids);
    setReorderError(null);
    try {
      const { fields: next } = await tablesApi.reorderFields(tableId, { fieldIds: ids });
      if (seq !== reorderSeq.current) return;
      query.replaceFields(fieldView.reconcile(next, viewCheckpoint));
      emitTableEvent({ type: 'table.fields.changed', tableId });
    } catch (err) {
      if (seq === reorderSeq.current)
        setReorderError(getErrorMessage(err, 'Could not reorder fields'));
    } finally {
      if (seq === reorderSeq.current) setPendingOrder(null);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      deleteEntries ||
      prepareDeleteRef.current ||
      !(event.target instanceof Node) ||
      !rootRef.current?.contains(event.target)
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      insertAtTop();
    }
  }

  function renderRow(entry: TableEntry | null) {
    const rowDraft = draft && (entry ? draft.id === entry.id : !draft.original) ? draft : null;
    const rowId = entry?.id ?? rowDraft?.id ?? '';
    const saved = rowDraft ? rowDraft.original : (entry ?? undefined);
    const untitled = untitledEntryLabel(saved ? positions.get(saved.id) : undefined);
    const rowLabel = saved ? entryLabel(saved, fields, untitled) : 'New entry';
    const savedName = saved && nameField ? saved.values[nameField.id] : null;
    const rowReference = !!saved && !!nameField?.collapsed;
    return (
      <tr
        key={rowId}
        className={insertHover === rowId ? styles.insertTarget : undefined}
        aria-label={saved ? undefined : 'New entry'}
        aria-selected={saved ? selectedIds.has(rowId) : undefined}
        data-entry-id={rowId}
        data-entry-focused={highlightedEntry === rowId || undefined}
        tabIndex={-1}
        onKeyDown={saved ? (event) => onRowKeyDown(event, rowId) : undefined}
      >
        <EntryCell
          blocked={blocked}
          rejectReason={blocked ? blockedReason : 'Drop links into a Text cell'}
          className={`${styles.selectionCell} ${nameField?.collapsed ? styles.withRowReference : ''}`}
          data-row-select=""
        >
          {entry && (
            <button
              type="button"
              className={styles.insertHandle}
              aria-label={`Insert a row above ${rowLabel}`}
              disabled={blocked}
              onPointerEnter={() => setInsertHover(entry.id)}
              onPointerLeave={() => setInsertHover(null)}
              onFocus={() => setInsertHover(entry.id)}
              onBlur={() => setInsertHover(null)}
              onClick={() => void begin(null, undefined, entry.id)}
            >
              <PlusIcon />
            </button>
          )}
          {saved && (
            <Checkbox
              size="sm"
              checked={selectedIds.has(rowId)}
              disabled={blocked}
              aria-label={`Select entry ${rowLabel}`}
              title={rowId}
              onChange={(checked, modifiers) => selectEntry(rowId, checked, modifiers)}
            />
          )}
          {saved && rowReference && (
            <EntryReferenceControl
              placement="row"
              tableId={tableId}
              entryId={saved.id}
              name={typeof savedName === 'string' ? savedName : ''}
              label={rowLabel}
            />
          )}
        </EntryCell>
        {columns.map((column) => {
          const field = fieldByColumn.get(column.name);
          if (!field || field.managed) {
            const value = saved && field ? (saved.values[field.id] ?? null) : null;
            return (
              <EntryCell
                key={column.name}
                field={field}
                blocked={blocked}
                rejectReason={blockedReason}
                data-column={column.name}
                data-system-column={field?.managed ? field.columnName : undefined}
                className={`${styles.cell} ${styles.managed}`}
              >
                <div
                  className={styles.cellValue}
                  title={typeof value === 'string' ? value : undefined}
                >
                  <TableEntryValueView field={field} value={value} />
                </div>
              </EntryCell>
            );
          }
          const key = cellKey(rowId, field.id);
          const value = rowDraft
            ? (rowDraft.values[field.id] ?? null)
            : (entry?.values[field.id] ?? null);
          if (field.type === 'checkbox') {
            return (
              <EntryCell
                key={field.id}
                field={field}
                blocked={blocked}
                rejectReason={blockedReason}
                data-column={column.name}
                data-checkbox-field={field.id}
                className={styles.cell}
              >
                <CheckboxCellValue
                  checked={value === true}
                  label={`${field.name} in ${rowLabel}`}
                  disabled={blocked}
                  onToggle={() => void toggleCheckbox(entry, field, rowDraft?.id)}
                />
              </EntryCell>
            );
          }
          if (rowDraft && key === activeKey) {
            const Editor =
              field.type === 'relation'
                ? RelationEntryPicker
                : field.type === 'select'
                  ? SelectEntryPicker
                  : EntryCellEditor;
            return (
              <EntryCell
                key={column.name}
                field={field}
                active
                blocked={blocked}
                rejectReason={blockedReason}
                data-column={column.name}
                data-title-field={field.isTitle || undefined}
                onChipDrop={(chips) => dropChip(entry, field, chips, rowDraft.id)}
                className={`${styles.cell} ${styles.activeCell}`}
                data-active-cell=""
                onBlur={(event: FocusEvent<HTMLTableCellElement>) => {
                  if (blocked) return;
                  // Tab or a click on another grid control leaves the cell.
                  const next = event.relatedTarget;
                  if (
                    next instanceof Element &&
                    !next.closest(KEEPS_CELL) &&
                    rootRef.current?.contains(next)
                  )
                    void edit.close();
                }}
              >
                <Editor
                  key={`${rowDraft.id}:${field.id}:${rowDraft.editorGeneration}`}
                  field={field}
                  rangePanel
                  repeat={
                    saved && field.recurrence
                      ? {
                          tableId,
                          entryId: saved.id,
                          onWritten: (written) => {
                            edit.adopt(written, field.id);
                            query.upsertEntry(written);
                          },
                        }
                      : undefined
                  }
                  value={value}
                  relatedEntries={result?.relatedEntries}
                  relatedItems={result?.relatedItems}
                  autoFocus
                  busy={blocked}
                  error={edit.fieldErrors[field.id]}
                  onCreateOption={async (label) => {
                    const added = await edit.addSelectOption(field.id, label);
                    if (!added) return null;
                    // Start any queued realtime refresh before our explicit
                    // barrier read; a newer read still satisfies the barrier.
                    flushSync(() => setRefreshingSchema(true));
                    try {
                      if (!(await query.refreshPage())) return null;
                      // Commit the fresh page (including every revision) and
                      // ready state before the picker's callbacks run.
                      flushSync(() => setRefreshingSchema(false));
                    } finally {
                      setRefreshingSchema(false);
                    }
                    // Write the label here, not through the picker's onChange,
                    // which is ignored while anything (such as a parent still
                    // reloading this schema change) blocks the grid.
                    if (!edit.chooseSelectLabel(rowDraft.id, field.id, added.option.label))
                      return null;
                    if (!field.multiple) {
                      returnFocus.current = key;
                      void edit.close();
                    }
                    return added.option;
                  }}
                  onChange={(next) => {
                    if (!blocked) edit.change(field.id, next);
                  }}
                  onCommit={(next) => {
                    if (blocked) return;
                    edit.change(field.id, next);
                    returnFocus.current = key;
                    void edit.close();
                  }}
                  onCancel={() => {
                    returnFocus.current = key;
                    edit.cancel();
                  }}
                />
              </EntryCell>
            );
          }
          const problem = rowDraft ? edit.fieldErrors[field.id] : undefined;
          const editCell = () => void begin(entry, field.id, undefined, undefined, rowDraft?.id);
          if (field.type === 'relation') {
            // Chips sit beside the edit button, not inside it: a chip opens its
            // entry, while the rest of the cell (or Enter on it) edits.
            return (
              <EntryCell
                key={column.name}
                field={field}
                blocked={blocked}
                rejectReason={blockedReason}
                data-column={column.name}
                onChipDrop={(chips) => dropChip(entry, field, chips, rowDraft?.id)}
                className={`${styles.cell} ${problem ? styles.invalidCell : ''}`}
                title={problem}
              >
                <div className={`${styles.cellContents} ${styles.relationCell}`}>
                  <button
                    type="button"
                    className={styles.relationEdit}
                    data-cell={key}
                    aria-label={`Edit ${field.name} in entry ${rowLabel}`}
                    aria-invalid={problem ? true : undefined}
                    disabled={blocked}
                    onClick={editCell}
                  />
                  <div
                    className={styles.relationValues}
                    onClick={(event) => {
                      if (event.target instanceof Element && event.target.closest('.md-chip'))
                        return;
                      editCell();
                    }}
                  >
                    <TableEntryValueView
                      field={field}
                      value={value}
                      relatedEntries={result?.relatedEntries}
                      relatedItems={result?.relatedItems}
                      interactive
                    />
                  </div>
                </div>
              </EntryCell>
            );
          }
          // A repeating row on its current occurrence reads as the repeat's text
          // (a range keeps its dates; a moved one shows where it went).
          const cellRepeat =
            !rowDraft && saved && field.recurrence && !field.range
              ? tableRepeats.get(cellRepeatKey(field.id, saved.id))
              : undefined;
          const repeatText =
            cellRepeat && cellWall(field, value) === cellRepeat.repeat.current ? cellRepeat : null;
          return (
            <EntryCell
              key={column.name}
              field={field}
              blocked={blocked}
              rejectReason={blockedReason}
              data-column={column.name}
              data-title-field={field.isTitle || undefined}
              onChipDrop={(chips) => dropChip(entry, field, chips, rowDraft?.id)}
              className={`${styles.cell} ${problem ? styles.invalidCell : ''}`}
              title={problem}
            >
              <div className={`${styles.cellContents} ${field.isTitle ? styles.nameCell : ''}`}>
                <button
                  type="button"
                  className={styles.cellButton}
                  data-cell={key}
                  aria-label={`Edit ${field.name} in entry ${rowLabel}`}
                  aria-invalid={problem ? true : undefined}
                  disabled={blocked}
                  onClick={editCell}
                >
                  {repeatText ? (
                    <RepeatCellText cellRepeat={repeatText} />
                  ) : (
                    <TableEntryValueView
                      field={field}
                      value={value}
                      relatedEntries={result?.relatedEntries}
                      relatedItems={result?.relatedItems}
                      untitledLabel={untitled}
                    />
                  )}
                </button>
                {field.isTitle && saved && onOpenEntry && (
                  <button
                    type="button"
                    className={styles.openEntry}
                    aria-label={`Open ${rowLabel}`}
                    title="Open entry"
                    onClick={() => onOpenEntry(saved.id)}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width={13}
                      height={13}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                      focusable="false"
                    >
                      <path d="M14 4h6v6M20 4l-8 8M10 5H5v14h14v-5" />
                    </svg>
                    Open
                  </button>
                )}
                {field.isTitle && saved && (
                  <EntryReferenceControl
                    tableId={tableId}
                    entryId={saved.id}
                    name={typeof value === 'string' ? value : ''}
                    label={rowLabel}
                  />
                )}
              </div>
            </EntryCell>
          );
        })}
      </tr>
    );
  }

  return (
    <div
      ref={rootRef}
      data-table-entries-grid=""
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Table entries"
    >
      <div className={styles.toolbar} role="toolbar" aria-label="Table actions">
        <div className={styles.toolbarGroup}>
          <TableEntrySearch query={query.q} onQueryChange={setSearch} inputRef={searchRef} />
          <TableHiddenFields
            fields={hiddenFields}
            onShow={(field) => void toggleField(field)}
            pendingFieldIds={fieldView.pendingFieldIds}
            disabled={blocked || fieldControlsDisabled}
          />
          {selectedCount > 0 && (
            <>
              <span className={styles.count} aria-live="polite">
                {selectedCount} selected
              </span>
              <Button
                size="sm"
                variant="ghost"
                data-keeps-cell=""
                disabled={blocked || preparingDelete}
                onClick={() => void confirmDelete()}
              >
                Delete selected
              </Button>
              {deleteNotice && (
                <span role="status" className={styles.deleteNotice}>
                  {deleteNotice}
                </span>
              )}
            </>
          )}
        </div>
        <div className={styles.toolbarGroup}>
          {edit.saveState !== 'idle' && (
            <span
              className={`${styles.saveStatus} ${edit.saveState === 'error' ? styles.error : ''}`}
              role={edit.saveState === 'error' ? 'alert' : 'status'}
            >
              {edit.saveState === 'dirty' && 'Waiting to save…'}
              {edit.saveState === 'saving' && 'Saving…'}
              {edit.saveState === 'saved' && 'Saved'}
              {edit.saveState === 'error' && 'Not saved'}
            </span>
          )}
          <TableUndoButtons />
          <button
            type="button"
            className={styles.quietButton}
            disabled={query.loading}
            aria-label="Refresh"
            title="Refresh entries"
            onClick={() => {
              query.reload();
              onRefreshFields?.();
            }}
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      {query.loading && !result && <StateHint>Loading entries…</StateHint>}
      {query.error && (
        <StateHint variant="error">
          {query.error}{' '}
          <Button size="sm" onClick={query.reload}>
            Retry entries
          </Button>
        </StateHint>
      )}
      {draft && result && draft.schemaVersion !== result.schemaVersion && (
        <p role="status" className={styles.feedback}>
          Fields changed while this row was open. Autosave will check the latest schema.
        </p>
      )}
      {reorderError && (
        <p role="alert" className={`${styles.feedback} ${styles.error}`}>
          {reorderError}
        </p>
      )}
      {fieldView.error && (
        <p role="alert" className={`${styles.feedback} ${styles.error}`}>
          {fieldView.error}
        </p>
      )}
      {(navigationNotice || query.focusError) && (
        <p role="alert" className={`${styles.feedback} ${styles.error}`}>
          {navigationNotice ?? query.focusError}
          {focusEntryId && (
            <Button size="sm" variant="ghost" onClick={() => void requestEntryFocus(focusEntryId)}>
              Retry opening entry
            </Button>
          )}
        </p>
      )}
      <TableGrid
        columns={columns}
        fields={fields}
        onEditField={onEditField}
        onRemoveField={onRemoveField}
        onAddField={onAddField}
        fieldEditorId={fieldEditorId}
        editingFieldId={editingFieldId}
        insertingFieldBoundary={insertingFieldBoundary}
        fieldControlsDisabled={fieldControlsDisabled}
        onHideField={(field) => void toggleField(field)}
        onResizeField={fieldView.resize}
        pendingFieldIds={fieldView.pendingFieldIds}
        wideLeading={!!nameField?.collapsed}
        leadingHeader={
          <Checkbox
            ref={selectAllRef}
            size="sm"
            aria-label="Select all displayed entries"
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            disabled={blocked || displayed.length === 0}
            onChange={(checked) => {
              setDeleteNotice(null);
              clearTextSelection();
              selectionAnchor.current = null;
              setSelection({
                page: pageKey,
                ids: new Set(checked ? displayed.map((entry) => entry.id) : []),
              });
            }}
          />
        }
        onReorderColumns={(names) => void reorderColumns(names)}
        sort={sort}
        onSortChange={onSortChange}
        where={viewFilter ?? where}
        onFilterChange={onFilterChange}
        editingDisabled={editingDisabled}
      >
        {displayed.flatMap((entry, index) =>
          unsaved && index === unsavedAt ? [renderRow(null), renderRow(entry)] : [renderRow(entry)]
        )}
        {unsaved && unsavedAt === -1 && renderRow(null)}
        {showGhostRow && (
          <tr className={`${styles.ghostRow} ${displayed.length === 0 ? styles.emptyRow : ''}`}>
            <EntryCell
              blocked={blocked}
              rejectReason={blocked ? blockedReason : 'Drop links into a Text cell'}
              className={`${styles.selectionCell} ${nameField?.collapsed ? styles.withRowReference : ''}`}
            >
              <button
                type="button"
                className={`${styles.insertHandle} ${styles.endInsert}`}
                aria-label={displayed.length ? 'Insert a row at end' : 'Insert first row'}
                title="Append a row to this table"
                disabled={blocked}
                onClick={() => void begin(null)}
              >
                <PlusIcon />
              </button>
            </EntryCell>
            {columns.map((column, index) => {
              const field = fieldByColumn.get(column.name);
              const editable = field && !field.managed ? field : undefined;
              return (
                <EntryCell
                  key={column.name}
                  field={field}
                  blocked={blocked}
                  rejectReason={
                    blocked
                      ? blockedReason
                      : field?.collapsed
                        ? 'Expand this column to add a link'
                        : undefined
                  }
                  data-column={column.name}
                  data-title-field={(!field?.collapsed && field?.isTitle) || undefined}
                  data-system-column={
                    field?.managed && !field.collapsed ? field.columnName : undefined
                  }
                  onChipDrop={(chips) => begin(null, editable?.id, undefined, chips)}
                  className={`${styles.cell} ${styles.ghostCell} ${field?.collapsed ? styles.collapsedCell : ''}`}
                >
                  {!field?.collapsed && field?.type === 'checkbox' ? (
                    <CheckboxCellValue
                      checked={false}
                      label={`New entry: ${field.name}`}
                      disabled={blocked}
                      onToggle={() => void toggleCheckbox(null, field)}
                    />
                  ) : (
                    !field?.collapsed && (
                      <button
                        type="button"
                        className={styles.ghostButton}
                        aria-label={editable ? `New entry: ${editable.name}` : 'New entry'}
                        tabIndex={index === 0 ? undefined : -1}
                        disabled={blocked}
                        onClick={() => void begin(null, editable?.id)}
                      >
                        {displayed.length === 0 && index === 0 && (
                          <span className={styles.emptyHint}>Add a row</span>
                        )}
                      </button>
                    )
                  )}
                </EntryCell>
              );
            })}
          </tr>
        )}
      </TableGrid>
      {noMatches && (
        <StateHint>
          {/* With no search text the view's filters emptied the page, so name them. */}
          <p>{query.q ? `No entries match “${query.q}”.` : 'No entries match the filters.'}</p>
          {query.q ? (
            <Button size="sm" variant="ghost" onClick={() => setSearch('')}>
              Clear search
            </Button>
          ) : (
            onFilterChange && (
              <Button size="sm" variant="ghost" onClick={() => onFilterChange([])}>
                Clear filters
              </Button>
            )
          )}
        </StateHint>
      )}
      {result && !editableFields.length && (
        <p className={styles.feedback}>Add a field to start filling in rows.</p>
      )}
      {edit.error && (
        <div className={`${styles.autosaveError} ${styles.error}`} role="alert" data-keeps-cell="">
          <span>{edit.error}</span>
          {edit.conflict && (
            <Button
              size="sm"
              disabled={edit.saving || edit.reloading}
              onClick={() => void edit.reloadLatest()}
            >
              Load latest row
            </Button>
          )}
        </div>
      )}
      {deleteEntries && (
        <TableEntryDelete
          tableId={tableId}
          entries={deleteEntries}
          immediate={deleteImmediate}
          onCancel={() => setDeleteEntries(null)}
          onReload={query.reload}
          onDeleted={(ids) => {
            const removed = new Set(ids);
            if (draft && removed.has(draft.id)) edit.cancel();
            setSelection((current) => ({
              ...current,
              ids: new Set([...current.ids].filter((id) => !removed.has(id))),
            }));
            selectionAnchor.current = null;
            setDeleteEntries(null);
            setDeleteNotice(null);
            restoreDeleteFocus.current = true;
            query.removeEntries(ids);
            query.reload();
          }}
        />
      )}
      {result && (
        <TablePagerBar
          page={query.page}
          pageSize={query.pageSize}
          totalCount={result?.totalCount ?? 0}
          filtered={query.filtered}
          disabled={query.loading || !result || edit.saving}
          onPageChange={(page) => {
            void (async () => {
              if (draft && !(await edit.flush())) return;
              edit.cancel();
              query.setPage(page);
            })();
          }}
          onPageSizeChange={(pageSize) => {
            void (async () => {
              if (draft && !(await edit.flush())) return;
              edit.cancel();
              query.changePageSize(pageSize);
            })();
          }}
        />
      )}
    </div>
  );
}
