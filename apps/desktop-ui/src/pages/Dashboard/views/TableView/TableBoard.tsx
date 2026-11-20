import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type {
  TableEntry,
  TableEntrySort,
  TableEntryWhere,
  TableField,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { PlusIcon, RefreshIcon } from '@desktop/components/Icons';
import { emitTableEvent } from '@desktop/features/database';
import {
  usePaneFindMemory,
  usePaneFindShortcut,
} from '@desktop/features/pane-find/PaneFindContext';
import { primeEntryPositions, untitledEntryLabel } from '@desktop/features/table-entries';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { useScrollEdges } from '@desktop/hooks/useScrollEdges';
import { groupBoardEntries, hasCardValue, NO_VALUE_KEY, type BoardGroup } from './boardGroups';
import { BOARD_CARDS_ATTR, BOARD_COLUMN_ATTR, startCardDrag } from './cardDrag';
import { entryLabel } from './RelationEntryPicker';
import { newEntryValues, pageRowNumbers } from './entryRows';
import { noteRepeatAdvance } from './repeatAdvanceToast';
import { SelectOptionTag } from './SelectOptionTag';
import { TableBoardCard, CARD_FIELD_LIMIT } from './TableBoardCard';
import { TableEntryDelete } from './TableEntryDelete';
import { useTableRepeats } from './repeat/useTableRepeats';
import { TableEntrySearch } from './TableEntrySearch';
import { TablePagerBar } from './TablePagerBar';
import { TableUndoButtons } from './TableUndoButtons';
import { useTableEntries } from './useTableEntries';
import { entryValueProblem } from './dateRange';
import styles from './TableBoard.module.scss';

interface Props {
  tableId: string;
  /** The single-choice select field the columns stand for. */
  field: TableField;
  /** The table's fields as the pane loaded them; the page's own list wins once read. */
  fields: TableField[];
  /** Opens an entry the way the pane prefers (Grid, focused on it). */
  onOpenEntry: (entryId: string) => void;
  onRefreshFields?: () => void;
  /** Orders cards within each column; columns keep the option order. */
  sort?: TableEntrySort[];
  /** Field filters; every one must match. */
  where?: TableEntryWhere[];
}

/**
 * A custom table's entries as a Board: one column per option of a select
 * field, plus "No <field>" for rows without one. Dragging a card (or its
 * "Move" menu) writes that one field through the same entry update the grid
 * uses — revision-checked, a step in the user's undo history, announced as
 * `table.entries.changed` — and the card moves at once, returning to its
 * column if the server refuses. "+ New" under a column creates a row with
 * that option preset. Rows come from the same paged, searchable read as the
 * grid: the Board shows the current page, filtered by the toolbar's search.
 * A card's trash icon deletes its row through the grid's delete
 * (TableEntryDelete, immediate): revision-checked, a step in the undo history,
 * with the grid's dialog only on a conflict.
 */
export function TableBoard({
  tableId,
  field,
  fields: initialFields,
  onOpenEntry,
  onRefreshFields,
  sort,
  where,
}: Props) {
  const [rememberedQuery, rememberQuery] = usePaneFindMemory(`table-entries:${tableId}`);
  const query = useTableEntries(tableId, { initialQuery: rememberedQuery, sort, where });
  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** Moves sent to the server, by entry id, so cards render in their new column meanwhile. */
  const [pendingMoves, setPendingMoves] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The card being deleted, frozen at its shown revision (TableEntryDelete). */
  const [deleting, setDeleting] = useState<Pick<TableEntry, 'id' | 'revision'> | null>(null);
  const suppressOpen = useRef(false);
  const cancelDrag = useRef<(() => void) | null>(null);

  useEffect(() => rememberQuery(query.q), [query.q, rememberQuery]);
  usePaneFindShortcut(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });
  useEffect(() => () => cancelDrag.current?.(), []);

  const result = query.result;
  // Faded board edges hint at columns scrolled out of view.
  const scrollEdges = useScrollEdges(scrollerRef, Boolean(result));
  const fields = result?.fields ?? initialFields;
  // The pane's field list may be newer than the page's (a renamed option).
  const liveField = fields.find((item) => item.id === field.id) ?? field;
  const samePage = result?.page === query.page && result?.pageSize === query.pageSize;
  const entries = samePage ? result.entries : [];
  const nameField = fields.find((item) => item.isTitle && !item.managed);
  const cardFields = fields.filter(
    (item) => !item.managed && item.id !== liveField.id && item.id !== nameField?.id
  );
  const groups = groupBoardEntries(entries, liveField, pendingMoves);
  const repeats = useTableRepeats(
    tableId,
    fields.some((item) => item.recurrence)
  );
  const positions = new Map(samePage ? pageRowNumbers(result) : []);
  // A background reload keeps the Board usable, as it does the grid; only a
  // missing page or a failed read blocks it.
  const blocked = !result || !!query.error;
  const lastPage = Math.max(1, Math.ceil((result?.totalCount ?? 0) / query.pageSize));
  const noMatches = samePage && query.filtered && result.totalCount === 0;

  // Chips of this table's entries elsewhere reuse the page's row numbers.
  useEffect(() => {
    if (result) primeEntryPositions(tableId, pageRowNumbers(result));
  }, [tableId, result]);

  async function move(entry: TableEntry, toKey: string) {
    if (!result) return;
    const value = toKey === NO_VALUE_KEY ? null : toKey;
    setError(null);
    setPendingMoves((current) => new Map(current).set(entry.id, value));
    try {
      const saved = await tablesApi.updateEntry(tableId, entry.id, {
        values: { [liveField.id]: value },
        schemaVersion: result.schemaVersion,
        expectedRevision: entry.revision,
      });
      emitTableEvent({ type: 'table.entries.changed', tableId, entryId: saved.entry.id });
      // A repeating row set to Done comes straight back to To do: say why.
      void noteRepeatAdvance({
        tableId,
        fields: result.fields,
        before: entry,
        after: saved.entry,
        patch: { [liveField.id]: value },
      });
      query.keepEntry(saved.entry.id);
      query.upsertEntry(saved.entry);
    } catch (err) {
      setError(
        err instanceof FetchError && err.status === 409
          ? 'This entry changed elsewhere, so it was not moved. The Board has been refreshed.'
          : getErrorMessage(err, 'Could not move this entry')
      );
      if (err instanceof FetchError && err.status === 409) query.reload();
    } finally {
      setPendingMoves((current) => {
        const next = new Map(current);
        next.delete(entry.id);
        return next;
      });
    }
  }

  async function create(group: BoardGroup) {
    if (!result || creating) return;
    const values = { ...newEntryValues(result.fields), [liveField.id]: group.value };
    const problem = result.fields
      .filter((item) => !item.managed)
      .map((item) => entryValueProblem(item, values[item.id] ?? null))
      .find((message): message is string => !!message);
    if (problem) {
      setError(`${problem} Add this row in Grid view.`);
      return;
    }
    setError(null);
    setCreating(group.key);
    try {
      const saved = await tablesApi.createEntry(tableId, {
        id: crypto.randomUUID(),
        values,
        schemaVersion: result.schemaVersion,
      });
      emitTableEvent({ type: 'table.entries.changed', tableId, entryId: saved.entry.id });
      query.keepEntry(saved.entry.id);
      query.upsertEntry(saved.entry, {});
    } catch (err) {
      setError(getErrorMessage(err, 'Could not add an entry'));
    } finally {
      setCreating(null);
    }
  }

  const beginDrag = (entry: TableEntry, fromKey: string, event: ReactPointerEvent<HTMLElement>) => {
    const card = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-board-card]');
    const scroller = scrollerRef.current;
    if (!card || !scroller || blocked) return;
    cancelDrag.current?.();
    cancelDrag.current = startCardDrag({
      scroller,
      card,
      fromKey,
      startX: event.clientX,
      startY: event.clientY,
      onStart: () => setDragging(true),
      onDrop: (toKey) => void move(entry, toKey),
      onEnd: (dragged) => {
        cancelDrag.current = null;
        setDragging(false);
        if (!dragged) return;
        // The click that follows a drop must not open the entry.
        suppressOpen.current = true;
        window.setTimeout(() => {
          suppressOpen.current = false;
        }, 0);
      },
    });
  };

  const open = (entryId: string) => {
    if (suppressOpen.current) return;
    onOpenEntry(entryId);
  };

  return (
    <div className={styles.board} data-table-board="" aria-label="Table board">
      <div className={styles.toolbar} role="toolbar" aria-label="Board actions">
        <div className={styles.toolbarGroup}>
          <TableEntrySearch query={query.q} onQueryChange={query.setQuery} inputRef={searchRef} />
        </div>
        <div className={styles.toolbarGroup}>
          <span className={styles.groupedBy}>
            Grouped by <strong>{liveField.name}</strong>
          </span>
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
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {lastPage > 1 && result && (
        <p className={styles.pageNote}>
          Showing page {result.page} of {lastPage}. Cards move within the table; other pages hold
          the rest.
        </p>
      )}
      {result && (
        <div
          ref={scrollerRef}
          className={styles.columns}
          data-board-dragging={dragging || undefined}
          {...scrollEdges}
        >
          {groups.map((group) => (
            <section
              key={group.key}
              className={styles.column}
              {...{ [BOARD_COLUMN_ATTR]: group.key }}
              aria-label={`${group.label} (${group.entries.length})`}
            >
              <header className={styles.columnHeader}>
                {group.option ? (
                  <SelectOptionTag label={group.label} color={group.option.color} />
                ) : (
                  <span className={styles.columnLabel}>{group.label}</span>
                )}
                <span className={styles.columnCount} aria-hidden>
                  {group.entries.length}
                </span>
              </header>
              <ul className={styles.cards} {...{ [BOARD_CARDS_ATTR]: '' }}>
                {group.entries.map((entry) => {
                  const untitled = untitledEntryLabel(positions.get(entry.id));
                  const label = entryLabel(entry, fields, untitled);
                  const shown = cardFields
                    .filter((item) => hasCardValue(item, entry.values[item.id] ?? null))
                    .slice(0, CARD_FIELD_LIMIT);
                  return (
                    <TableBoardCard
                      key={entry.id}
                      entry={entry}
                      label={label}
                      nameField={nameField}
                      fields={shown}
                      groups={groups}
                      currentKey={group.key}
                      relatedEntries={result.relatedEntries}
                      relatedItems={result.relatedItems}
                      repeats={repeats}
                      pending={pendingMoves.has(entry.id)}
                      disabled={blocked}
                      onOpen={() => open(entry.id)}
                      onMove={(toKey) => void move(entry, toKey)}
                      onDelete={() => {
                        // One delete at a time: TableEntryDelete owns its entries until it settles.
                        if (!deleting) setDeleting({ id: entry.id, revision: entry.revision });
                      }}
                      onDragStart={(event) => beginDrag(entry, group.key, event)}
                    />
                  );
                })}
              </ul>
              <button
                type="button"
                className={styles.newCard}
                disabled={blocked || creating !== null}
                aria-label={`New entry in ${group.label}`}
                onClick={() => void create(group)}
              >
                <PlusIcon />
                <span>{creating === group.key ? 'Adding…' : 'New'}</span>
              </button>
            </section>
          ))}
        </div>
      )}
      {result && (
        <TablePagerBar
          page={query.page}
          pageSize={query.pageSize}
          totalCount={result.totalCount}
          filtered={query.filtered}
          disabled={query.loading}
          onPageChange={query.setPage}
          onPageSizeChange={query.changePageSize}
        />
      )}
      {deleting && (
        <TableEntryDelete
          key={deleting.id}
          tableId={tableId}
          entries={[deleting]}
          immediate
          onCancel={() => setDeleting(null)}
          onReload={query.reload}
          onDeleted={(ids) => {
            setDeleting(null);
            query.removeEntries(ids);
            query.reload();
          }}
        />
      )}
      {noMatches && (
        <StateHint>
          <p>No entries match “{query.q}”.</p>
          <Button size="sm" variant="ghost" onClick={() => query.setQuery('')}>
            Clear search
          </Button>
        </StateHint>
      )}
    </div>
  );
}
