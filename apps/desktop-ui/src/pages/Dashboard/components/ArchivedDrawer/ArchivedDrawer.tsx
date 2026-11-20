import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { getErrorMessage, elapsedMs } from '@snaglet/shared/utils';
import { archiveApi, tablesApi } from '@desktop/utils/api';
import type { ArchivedNode, ArchiveTreeResponse } from '@desktop/utils/api';
import { automationsApi } from '@desktop/utils/api/automations';
import { loadAutomations, upsertAutomation } from '@desktop/features/automations/automationsStore';
import { Button, Modal } from '@desktop/components';
import { ConfirmModal } from '@desktop/components/Modal';
import { showToast } from '@desktop/utils/toast';
import {
  AgentsViewIcon,
  BoxIcon,
  ChatBubbleIcon,
  ColumnIcon,
  DocIcon,
  ImageIcon,
  MemoryIcon,
  MessageIcon,
  SwirlIcon,
  TableIcon,
  TrashFillIcon,
} from '@desktop/components/Icons';
import { cn } from '@desktop/utils/classNames';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import {
  linkedFieldsConflict,
  restoreNameConflict,
  restoredTableEntry,
  type LinkedFieldsConflict,
} from '@desktop/features/database/tableLifecycle';
import { RestoreTableNameModal } from './RestoreTableNameModal';
import {
  ArchiveKindFilter,
  ArchiveResultCount,
  ArchiveSearchBar,
  Highlighted,
} from './ArchiveSearchControls';
import {
  ARCHIVE_KINDS,
  buildArchiveIndex,
  itemTitle,
  parseArchiveQuery,
  searchArchive,
  type ArchiveEntry,
  type ArchiveSort,
} from './archiveSearch';
import styles from './ArchivedDrawer.module.scss';

/** The Automations view's swirl, at the other row icons' 14px. */
const AutomationIcon: React.FC = () => <SwirlIcon size={14} />;

// `node.type` never comes back as 'project' — a project is a container
// (category='project') node-side, so it already renders through the
// `container` entry below, and a separate 'project' key would wrongly give
// projects their own icon treatment.
const TYPE_ICON: Record<string, React.FC> = {
  container: BoxIcon,
  doc: DocIcon,
  thread: ChatBubbleIcon,
  agent: AgentsViewIcon,
  memory: MemoryIcon,
  image: ImageIcon,
  message: MessageIcon,
  // Custom Database tables: catalog entries, not nodes (always roots).
  table: TableIcon,
  // An archived column of a custom table (under its table, or `table › column`).
  table_field: ColumnIcon,
  // A deleted automation (a row of the builtin Automations table; always a root).
  automation: AutomationIcon,
};

/** Archived custom tables are kept until deleted; the TTL sweep skips them. */
const isTable = (node: ArchivedNode) => node.type === 'table';
/**
 * An archived column; `container_id` is its table's id. Kept until deleted,
 * like a table; restore and delete go through the table's field routes.
 */
const isTableField = (node: ArchivedNode) => node.type === 'table_field';
/**
 * A deleted automation. Kept until deleted, like a table; restore and delete
 * go through /api/automations (people's routes), never the generic archive
 * routes. Restore brings it back as it was (paused stays paused).
 */
const isAutomation = (node: ArchivedNode) => node.type === 'automation';

/** A column row's own name: the part after `table › ` when its table is active. */
function columnName(node: ArchivedNode): string {
  const title = itemTitle(node);
  const separator = title.lastIndexOf(' › ');
  return separator === -1 ? title : title.slice(separator + 3);
}

function relativeAge(iso: string | null): string {
  if (!iso) return '';
  const ms = elapsedMs(Date.parse(iso));
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function daysUntilTtl(iso: string | null, ttlDays = 30): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const elapsedDays = elapsedMs(ms) / 86_400_000;
  const remaining = Math.max(0, Math.ceil(ttlDays - elapsedDays));
  return remaining === 0 ? 'TTL imminent' : `TTL in ${remaining}d`;
}

/** Rows past this many matches wait behind "Show more". */
const PAGE_SIZE = 200;

const rowIndent = (depth: number) => ({ paddingLeft: `${12 + depth * 16}px` });

const NO_TERMS: readonly string[] = [];

interface ArchivedRowProps {
  node: ArchivedNode;
  depth?: number;
  onRestore: (node: ArchivedNode) => void;
  onHardDelete: (node: ArchivedNode) => void;
  busy: boolean;
  /** Query words to mark in the title and location. */
  terms?: readonly string[];
  /** Where the item sits: the folders or project above it. */
  location?: string | null;
}

const ArchivedRow = React.memo(function ArchivedRow({
  node,
  depth = 0,
  onRestore,
  onHardDelete,
  busy,
  terms = NO_TERMS,
  location = null,
}: ArchivedRowProps) {
  const Icon = TYPE_ICON[node.type];
  const displayTitle = itemTitle(node);
  const table = isTable(node);
  const column = isTableField(node);
  const automation = isAutomation(node);
  return (
    <li className={styles.row} style={rowIndent(depth)}>
      <div className={styles.rowMain}>
        <span className={styles.rowIcon} aria-hidden>
          {Icon ? <Icon /> : '•'}
        </span>
        <div className={styles.rowLabel}>
          <span className={styles.label} title={displayTitle}>
            <Highlighted text={displayTitle} terms={terms} />
          </span>
          <span className={styles.idHint} title={node.id}>
            {node.id}
          </span>
        </div>
      </div>
      <div className={styles.rowMeta}>
        <span title={node.archived_at ?? ''}>{relativeAge(node.archived_at)}</span>
        <span className={styles.ttl}>
          {table || column || automation ? 'Kept until deleted' : daysUntilTtl(node.archived_at)}
        </span>
        {location && (
          <span className={styles.location} title={`in ${location}`}>
            in <Highlighted text={location} terms={terms} />
          </span>
        )}
      </div>
      <div className={styles.rowActions}>
        <Button
          variant="neutral"
          size="sm"
          disabled={busy}
          onClick={() => onRestore(node)}
          title={
            table
              ? 'Restore — the table returns to the workspace tree'
              : column
                ? 'Restore — the column returns to its table with its values'
                : automation
                  ? 'Restore — the automation returns as it was (a paused one stays paused)'
                  : 'Restore — set archived=false, cascade-restores cohort'
          }
        >
          Restore
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() => onHardDelete(node)}
          title={
            table
              ? 'Delete forever — drops the table and its entries'
              : column
                ? 'Delete forever — drops the column and every value in it'
                : automation
                  ? 'Delete forever — removes the automation and its run log'
                  : 'Hard delete — irreversible, cascades FK + triggers'
          }
        >
          Delete
        </Button>
      </div>
    </li>
  );
});

interface ArchivedContextRowProps {
  entry: ArchiveEntry;
  terms: readonly string[];
  /** Matches listed below it. */
  matchesInside: number;
}

/** An ancestor shown only so the matches below it keep their place. */
const ArchivedContextRow: React.FC<ArchivedContextRowProps> = ({ entry, terms, matchesInside }) => {
  const Icon = TYPE_ICON[entry.node.type];
  return (
    <li className={cn(styles.row, styles.contextRow)} style={rowIndent(entry.depth)}>
      <div className={styles.rowMain}>
        <span className={styles.rowIcon} aria-hidden>
          {Icon ? <Icon /> : '•'}
        </span>
        <span className={styles.contextLabel} title={entry.title}>
          <Highlighted text={entry.title} terms={terms} />
        </span>
      </div>
      <span className={styles.contextCount}>
        {matchesInside} {matchesInside === 1 ? 'match' : 'matches'} inside
      </span>
    </li>
  );
};

interface ArchivedDrawerProps {
  open: boolean;
  onClose: () => void;
}

function formatArchivedItemCount(count: number): string {
  return `${count} archived ${count === 1 ? 'item' : 'items'}`;
}

/**
 * Centered modal listing every archived item in the workspace, with restore
 * and hard-delete actions. Uses the shared `Modal` (Esc + backdrop dismiss)
 * with an `unstyled` panel sized for the list. Named "Drawer" though it
 * renders as a modal.
 */
export const ArchivedDrawer: React.FC<ArchivedDrawerProps> = ({ open, onClose }) => {
  const [tree, setTree] = useState<ArchiveTreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<ArchivedNode | null>(null);
  const [sweepConfirmationOpen, setSweepConfirmationOpen] = useState(false);
  /** An archived table whose old name is taken: restore asks for a new one. */
  const [renameTarget, setRenameTarget] = useState<{
    node: ArchivedNode;
    message: string;
  } | null>(null);
  /** A table delete refused while other tables' relation fields link to it. */
  const [referencesTarget, setReferencesTarget] = useState<{
    node: ArchivedNode;
    conflict: LinkedFieldsConflict;
  } | null>(null);

  const beginAction = useCallback(() => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }, []);
  const endAction = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await archiveApi.list();
      setTree(data);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load archived items'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState<ArchiveSort>('default');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const searchRef = useRef<HTMLInputElement>(null);

  // The dialog focuses its first control in a microtask queued from its own
  // mount effect, which runs before this one; the search box takes over after.
  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (active) searchRef.current?.focus();
    });
    return () => {
      active = false;
    };
  }, [open]);

  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setLimit(PAGE_SIZE);
  }, []);
  const changeKind = useCallback((next: string) => {
    setKind(next);
    setLimit(PAGE_SIZE);
  }, []);
  const changeSort = useCallback((next: ArchiveSort) => {
    setSort(next);
    setLimit(PAGE_SIZE);
  }, []);
  const clearSearch = useCallback(() => {
    changeQuery('');
    setKind('all');
    searchRef.current?.focus();
  }, [changeQuery]);
  const close = useCallback(() => {
    changeQuery('');
    setKind('all');
    onClose();
  }, [changeQuery, onClose]);

  const confirmationOpen =
    deleteTarget !== null ||
    sweepConfirmationOpen ||
    renameTarget !== null ||
    referencesTarget !== null;

  // One key, one layer: Escape clears an active search before it closes the
  // drawer, wherever focus is (a click on a row leaves it on the dialog; a
  // list reload drops it to the page). On the document, a layer inside the
  // drawer still takes Escape first, and the dialog's window listener skips
  // the event once it is handled here.
  const escapeClearsSearch = open && !confirmationOpen && query !== '';
  useEffect(() => {
    if (!escapeClearsSearch) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      changeQuery('');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [changeQuery, escapeClearsSearch]);

  // Typing stays responsive on a large archive: the list filters at a lower priority.
  const searchedQuery = useDeferredValue(query);
  const index = useMemo(() => (tree ? buildArchiveIndex(tree, sort) : []), [tree, sort]);
  const terms = useMemo(() => parseArchiveQuery(searchedQuery), [searchedQuery]);
  const kindTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const entry of index) totals.set(entry.kind, (totals.get(entry.kind) ?? 0) + 1);
    return totals;
  }, [index]);
  // A kind whose last item went (restored, deleted) is no longer offered: the
  // choice goes back to all, so it doesn't return with a later item of that kind.
  if (tree && kind !== 'all' && !kindTotals.has(kind)) setKind('all');
  const activeKind = kindTotals.has(kind) ? kind : 'all';
  const results = useMemo(
    () => searchArchive(index, { terms, kind: activeKind, limit }),
    [index, terms, activeKind, limit]
  );
  const filtering = terms.length > 0 || activeKind !== 'all';
  const kindOptions = useMemo(
    () => [
      { value: 'all', label: 'All', count: results.queryTotal },
      ...ARCHIVE_KINDS.filter((option) => kindTotals.has(option.kind)).map((option) => ({
        value: option.kind,
        label: option.label,
        count: results.kindCounts.get(option.kind) ?? 0,
      })),
    ],
    [kindTotals, results]
  );

  const requestHardDelete = useCallback((node: ArchivedNode) => {
    setError(null);
    setDeleteTarget(node);
  }, []);

  /**
   * Restore an archived table, under `name` when given. Announces the entry
   * on the table bus so the workspace tree shows it again and open panes
   * reload. Rejects on failure; the caller decides where the error shows.
   */
  const restoreTable = useCallback(
    async (row: ArchivedNode, name?: string) => {
      const result = await archiveApi.restore(row.id, name === undefined ? {} : { name });
      const restored = result.node ?? { ...row, title: name ?? row.title };
      const entry = restoredTableEntry(restored);
      emitTableEvent(
        entry ? { type: 'table.restored', table: entry } : { type: 'tables.invalidated' }
      );
      await refresh();
    },
    [refresh]
  );

  /**
   * Restore an archived column to its table, under `name` when given. Open
   * panes of the table reload their columns. Rejects on failure.
   */
  const restoreField = useCallback(
    async (row: ArchivedNode, name?: string) => {
      const tableId = row.container_id;
      if (!tableId) throw new Error('This column no longer names its table.');
      const result = await tablesApi.restoreField(
        tableId,
        row.id,
        name === undefined ? {} : { name }
      );
      emitTableEvent({ type: 'table.fields.changed', tableId });
      await refresh();
      if (result.madeOptional)
        showToast(
          `Restored “${result.field.name}” as optional: entries added meanwhile have no value for it.`,
          { durationMs: 5000 }
        );
    },
    [refresh]
  );

  const handleRestore = useCallback(
    async (row: ArchivedNode) => {
      if (!beginAction()) return;
      setError(null);
      try {
        if (isAutomation(row)) {
          // Back in the Automations view as it was; the store hears it now,
          // and again on the server's `automations:changed`.
          const { automation } = await automationsApi.restore(row.id);
          upsertAutomation(automation);
          await refresh();
          return;
        }
        if (isTable(row)) {
          await restoreTable(row);
          return;
        }
        if (isTableField(row)) {
          await restoreField(row);
          return;
        }
        await archiveApi.restore(row.id);
        // Tell the workspace tree (and any other archive-aware surface)
        // that this node is now active again. `reload: true` because
        // the restored id wasn't in the local tree — the optimistic
        // prune is a no-op for it, so a tree refetch is the only way
        // to bring the row back in its new placement.
        emitLibraryEvent({ type: 'archive-changed', ids: [row.id], reload: true });
        await refresh();
      } catch (err) {
        // A table or column whose name was taken meanwhile restores under a new one.
        const conflict = isTable(row) || isTableField(row) ? restoreNameConflict(err) : null;
        if (conflict) setRenameTarget({ node: row, message: conflict.message });
        else setError(getErrorMessage(err, 'Restore failed'));
      } finally {
        endAction();
      }
    },
    [beginAction, endAction, refresh, restoreField, restoreTable]
  );

  // The rename prompt shows its own failures inline (rethrown), including a
  // second taken name; on success it closes here.
  const confirmRestoreRenamed = useCallback(
    async (name: string) => {
      if (!renameTarget || !beginAction()) return;
      try {
        if (isTableField(renameTarget.node)) await restoreField(renameTarget.node, name);
        else await restoreTable(renameTarget.node, name);
        setRenameTarget(null);
        showToast(`Restored as “${name}”.`);
      } finally {
        endAction();
      }
    },
    [beginAction, endAction, renameTarget, restoreField, restoreTable]
  );

  const announceTableDeleted = useCallback(
    (row: ArchivedNode, linkedTableIds: Iterable<string | null>) => {
      emitTableEvent({ type: 'table.removed', tableId: row.id, state: 'deleted' });
      // Relation fields deleted with it change those tables' columns.
      for (const tableId of new Set(linkedTableIds)) {
        if (tableId && tableId !== row.id)
          emitTableEvent({ type: 'table.fields.changed', tableId });
      }
    },
    []
  );

  // Confirmed actions run from inside ConfirmModal: a rejection renders
  // inline in the dialog (which stays open for retry/cancel), so failures
  // are rethrown rather than routed into the drawer's own error banner.
  // On success the dialog is closed here, per ConfirmModal's contract.
  const confirmHardDelete = useCallback(async () => {
    if (!deleteTarget || !beginAction()) return;
    const target = deleteTarget;
    try {
      if (isTable(target)) {
        let linkedTableIds: string[];
        try {
          const deleted = await archiveApi.hardDelete(target.id);
          linkedTableIds = (deleted.deletedLinkedFields ?? []).map((field) => field.tableId);
        } catch (err) {
          // Other tables' relation fields link to it: a second confirm
          // explains that they go too, then retries with clearReferences.
          const conflict = linkedFieldsConflict(err);
          if (!conflict) throw err;
          setDeleteTarget(null);
          setReferencesTarget({ node: target, conflict });
          return;
        }
        announceTableDeleted(target, linkedTableIds);
      } else if (isTableField(target)) {
        const tableId = target.container_id;
        if (!tableId) throw new Error('This column no longer names its table.');
        await tablesApi.purgeField(tableId, target.id);
        // Open panes of the table drop the column for good.
        emitTableEvent({ type: 'table.fields.changed', tableId });
      } else if (isAutomation(target)) {
        await automationsApi.purge(target.id);
        // Gone from the shared list too (the Automations grid lists deleted ones).
        void loadAutomations();
      } else {
        await archiveApi.hardDelete(target.id);
        // Hard delete removes the node entirely — same downstream
        // refresh requirement as restore: any tree/sidebar/agent rail
        // that still cached the row needs to drop it.
        emitLibraryEvent({ type: 'archive-changed', ids: [target.id] });
      }
      await refresh();
      setDeleteTarget(null);
      showToast(`Permanently deleted “${itemTitle(target)}”.`);
    } finally {
      endAction();
    }
  }, [announceTableDeleted, beginAction, deleteTarget, endAction, refresh]);

  const confirmDeleteWithReferences = useCallback(async () => {
    if (!referencesTarget || !beginAction()) return;
    const { node: target, conflict } = referencesTarget;
    try {
      const deleted = await archiveApi.hardDelete(target.id, { clearReferences: true });
      announceTableDeleted(target, [
        ...conflict.fields.map((field) => field.tableId),
        ...(deleted.deletedLinkedFields ?? []).map((field) => field.tableId),
      ]);
      await refresh();
      setReferencesTarget(null);
      showToast(`Permanently deleted “${itemTitle(target)}”.`);
    } finally {
      endAction();
    }
  }, [announceTableDeleted, beginAction, endAction, referencesTarget, refresh]);

  const handleSweepAll = useCallback(async () => {
    if (!beginAction()) return;
    try {
      const result = await archiveApi.sweepAll().catch(async (error: unknown) => {
        // A sweep that stopped partway has deleted some items for good: show
        // the list as it is now; the confirmation shows the error.
        emitLibraryEvent({ type: 'archive-changed', ids: [], reload: true });
        await refresh();
        throw error;
      });
      const deletedCount =
        result.result.deletedContainers +
        result.result.deletedOther +
        (result.result.deletedAgents ?? 0) +
        (result.result.deletedAutomations ?? 0) +
        (result.result.deletedTables ?? 0) +
        (result.result.deletedFields ?? 0);
      // Archived tables other tables still link to survive a sweep; they
      // need an explicit Delete, which asks about the links.
      const kept = result.result.skippedTables?.length ?? 0;
      // Agents are actors, not nodes, so the tree-oriented archive-changed event
      // won't cover a purged agent — but refresh() re-fetches the drawer list,
      // and a purged agent's row is deleted for real, so it disappears.
      emitLibraryEvent({ type: 'archive-changed', ids: [], reload: true });
      if (result.result.deletedAutomations) void loadAutomations();
      await refresh();
      setSweepConfirmationOpen(false);
      const summary = `Permanently deleted ${formatArchivedItemCount(deletedCount)}.`;
      if (kept === 0) showToast(summary);
      else
        showToast(
          `${summary} Kept ${kept} linked ${kept === 1 ? 'table' : 'tables'}; delete ${kept === 1 ? 'it' : 'them'} one at a time.`,
          { durationMs: 5000 }
        );
    } finally {
      endAction();
    }
  }, [beginAction, endAction, refresh]);

  if (!open) return null;

  const listedCount = (tree?.roots.length ?? 0) + (tree?.children.length ?? 0);

  const searchedText = searchedQuery.trim();
  const kindLabel = ARCHIVE_KINDS.find((option) => option.kind === activeKind)?.label;
  const noMatches = `No archived ${kindLabel ? kindLabel.toLowerCase() : 'items'} ${
    searchedText ? `match “${searchedText}”` : 'here'
  }.`;

  return (
    <>
      <Modal
        onClose={confirmationOpen ? () => undefined : close}
        unstyled
        className={styles.overlay}
        aria-label="Archived items"
      >
        <div className={styles.panel}>
          <header className={styles.header}>
            <span className={styles.title}>
              <span className={styles.titleIcon} aria-hidden>
                <TrashFillIcon />
              </span>
              Archived
            </span>
            <div className={styles.headerActions}>
              <Button
                variant="neutral"
                size="md"
                onClick={refresh}
                disabled={loading || busy}
                title="Refresh list"
              >
                Refresh
              </Button>
              <Button
                variant="neutral"
                size="md"
                onClick={() => {
                  setError(null);
                  setSweepConfirmationOpen(true);
                }}
                disabled={busy || loading || !tree}
                title="Force TTL sweep (admin)"
              >
                Sweep
              </Button>
              <Button
                variant="neutral"
                size="md"
                iconOnly
                onClick={close}
                title="Close"
                aria-label="Close archived items"
              >
                ✕
              </Button>
            </div>
          </header>
          <div className={styles.toolbar}>
            <ArchiveSearchBar
              query={query}
              onQueryChange={changeQuery}
              sort={sort}
              onSortChange={changeSort}
              inputRef={searchRef}
            />
            <div className={styles.filterRow}>
              {index.length > 0 && (
                <ArchiveKindFilter options={kindOptions} value={activeKind} onChange={changeKind} />
              )}
              <ArchiveResultCount
                status={
                  !tree
                    ? ''
                    : filtering
                      ? `${results.total} ${results.total === 1 ? 'match' : 'matches'}`
                      : formatArchivedItemCount(index.length)
                }
              />
            </div>
          </div>
          <div className={styles.body}>
            {loading && <p className={styles.message}>Loading…</p>}
            {error && <p className={styles.error}>{error}</p>}
            {!loading && tree && tree.roots.length === 0 && (
              <p className={styles.message}>Nothing archived. The trash is empty.</p>
            )}
            {!loading && tree && tree.roots.length > 0 && results.total === 0 && (
              <div className={styles.noMatches}>
                <p className={styles.noMatchesText}>{noMatches}</p>
                <Button variant="neutral" size="sm" onClick={clearSearch}>
                  Clear search
                </Button>
              </div>
            )}
            {!loading && tree && tree.roots.length > 0 && results.total > 0 && (
              <>
                <ul className={styles.list}>
                  {results.rows.map(({ entry, context }) =>
                    context ? (
                      <ArchivedContextRow
                        key={entry.id}
                        entry={entry}
                        terms={terms}
                        matchesInside={results.insideCounts.get(entry.id) ?? 0}
                      />
                    ) : (
                      <ArchivedRow
                        key={entry.id}
                        node={entry.node}
                        depth={entry.depth}
                        terms={terms}
                        location={
                          // Nesting shows a child's place until a filter hides its parents.
                          entry.path.length > 0 && (filtering || entry.parent === -1)
                            ? entry.path.join(' › ')
                            : null
                        }
                        onRestore={handleRestore}
                        onHardDelete={requestHardDelete}
                        busy={busy}
                      />
                    )
                  )}
                </ul>
                {results.total > results.shown && (
                  <div className={styles.more}>
                    <span>{`Showing ${results.shown} of ${results.total}`}</span>
                    <Button
                      variant="neutral"
                      size="sm"
                      onClick={() => setLimit((current) => current + PAGE_SIZE)}
                    >
                      Show more
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </Modal>
      {deleteTarget && (
        <ConfirmModal
          title="Permanently delete archived item?"
          destructive
          confirmLabel="Permanently delete"
          confirmingLabel="Deleting…"
          onConfirm={confirmHardDelete}
          onCancel={() => setDeleteTarget(null)}
        >
          {isTable(deleteTarget)
            ? [
                `Delete the table “${itemTitle(deleteTarget)}” from Archived.`,
                'This drops the table and every entry in it.',
                'This action cannot be undone.',
              ]
            : isTableField(deleteTarget)
              ? [
                  `Delete the column “${itemTitle(deleteTarget)}” from Archived.`,
                  'This drops the column and every value in it.',
                  'This action cannot be undone.',
                ]
              : isAutomation(deleteTarget)
                ? [
                    `Delete the automation “${itemTitle(deleteTarget)}” from Archived.`,
                    'This removes it and its run log. The wakes it posted stay in their thread.',
                    'This action cannot be undone.',
                  ]
                : [
                    `Delete “${itemTitle(deleteTarget)}” (${deleteTarget.type}) from Archived.`,
                    'This removes the item and any data covered by its permanent-deletion cascade.',
                    'This action cannot be undone.',
                  ]}
        </ConfirmModal>
      )}
      {referencesTarget && (
        <ConfirmModal
          title="Delete linked relation fields too?"
          destructive
          confirmLabel="Delete table and fields"
          confirmingLabel="Deleting…"
          onConfirm={confirmDeleteWithReferences}
          onCancel={() => setReferencesTarget(null)}
        >
          <p className={styles.confirmMessage}>
            {referencesTarget.conflict.fields.length > 0
              ? `Other tables link to “${itemTitle(referencesTarget.node)}” through these relation fields:`
              : referencesTarget.conflict.message}
          </p>
          {referencesTarget.conflict.fields.length > 0 && (
            <ul className={styles.linkedFields}>
              {referencesTarget.conflict.fields.map((field) => (
                <li key={`${field.tableName}.${field.fieldName}`}>
                  <code>
                    {field.tableName}.{field.fieldName}
                  </code>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.confirmMessage}>
            Deleting the table also deletes these fields and the links they hold. This action cannot
            be undone.
          </p>
        </ConfirmModal>
      )}
      {renameTarget && (
        <RestoreTableNameModal
          kind={isTableField(renameTarget.node) ? 'field' : 'table'}
          tableName={
            isTableField(renameTarget.node)
              ? columnName(renameTarget.node)
              : itemTitle(renameTarget.node)
          }
          message={renameTarget.message}
          onRestore={confirmRestoreRenamed}
          onCancel={() => setRenameTarget(null)}
        />
      )}
      {sweepConfirmationOpen && (
        <ConfirmModal
          title="Sweep all archived items?"
          destructive
          confirmLabel="Sweep permanently"
          confirmingLabel="Sweeping…"
          onConfirm={handleSweepAll}
          onCancel={() => setSweepConfirmationOpen(false)}
        >
          {[
            `Permanently delete ${formatArchivedItemCount(listedCount)} currently listed in Archived.`,
            'The sweep applies across this workspace, including archived items not grouped at the root.',
            'This action cannot be undone.',
          ]}
        </ConfirmModal>
      )}
    </>
  );
};
