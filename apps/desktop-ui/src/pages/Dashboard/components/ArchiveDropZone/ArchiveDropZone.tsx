import React, { useCallback, useEffect, useState } from 'react';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { archiveApi, tablesApi } from '@desktop/utils/api';
import { automationsApi } from '@desktop/utils/api/automations';
import { upsertAutomation } from '@desktop/features/automations/automationsStore';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { readChipDragData, type NodeChipData } from '@desktop/utils/nodeChip';
import { showToast } from '@desktop/utils/toast';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import {
  readTableFieldDragPayload,
  type TableFieldDragPayload,
} from '@desktop/features/database/tableFieldDrag';
import {
  announceTableArchive,
  archiveTables,
  type ArchivingTable,
} from '@desktop/features/database/tableArchive';
import { isArchivableTableId } from '@desktop/features/database/tableLifecycle';
import { getCachedTableEntry } from '@desktop/features/database/tableNameCache';
import { TrashFillIcon } from '@desktop/components/Icons';
import { MoveHookToTrashModal } from '@desktop/components/Modal';
import { NODE_KIND } from '@snaglet/shared/constants';
import styles from './ArchiveDropZone.module.scss';

const TREE_NODE_MIME = 'application/x-snaglet-tree-node';

/**
 * The Database table chip being dragged, if that is what this drag carries.
 * Database sidebar rows (and table chips anywhere) drag as `table` chips, not
 * tree nodes. A tree-node drag always takes the tree path, and every other
 * chip kind is left alone. `readChipDragData` checks the in-memory drag store
 * first, so this also answers during dragover, when the DataTransfer hides
 * its payload, and in the desktop webview, which drops custom MIME types.
 */
function draggedTableChip(dataTransfer: DataTransfer): NodeChipData | null {
  if (dataTransfer.types.includes(TREE_NODE_MIME)) return null;
  const chip = readChipDragData(dataTransfer);
  return chip?.kind === 'table' ? chip : null;
}

/**
 * The table column being dragged (from its header's trash handle), if that
 * is what this drag carries. Only custom fields have the handle, so a
 * managed column never arrives here.
 */
function draggedTableField(dataTransfer: DataTransfer): TableFieldDragPayload | null {
  if (dataTransfer.types.includes(TREE_NODE_MIME)) return null;
  return readTableFieldDragPayload(dataTransfer);
}

interface DragPayload {
  id: string;
  kind: string;
  /** Tree rows stamp their name and slot at dragstart (see the tree's DragPayload). */
  label?: string;
  sortOrder?: number;
}

/** A dragged table row as the archive helper takes it. */
function archivingTable(payload: DragPayload): ArchivingTable {
  return {
    id: payload.id,
    name: payload.label?.trim() || getCachedTableEntry(payload.id)?.name || 'table',
    ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
  };
}

// Allowlist of kinds POST /api/archive/:id can act on. NODE_KIND covers every
// kind with a `nodes` row; 'agent' is added explicitly because agents are
// actors (no node row) that regained a soft-archive path — the
// archive route special-cases an agent id to the agents-table archive
// operation. 'table' is a workspace-tree Tables group row: the route
// archives a custom catalog table by its id (built-in tables are refused
// below, before any request). 'automation' is an Automations view row: it archives
// through the automation's own delete (`automationsApi.remove`, status
// canceled), which the Archive drawer then lists. Any other actor-like kind
// without an archive path stays excluded automatically.
const ARCHIVABLE_KINDS: ReadonlySet<string> = new Set([
  ...Object.values(NODE_KIND),
  'agent',
  'table',
  'automation',
]);

/** Kinds that are not workspace-tree nodes: the library tree need not hear of them. */
const OFF_TREE_KINDS: ReadonlySet<string> = new Set(['automation']);

/**
 * Splits hook payloads off from everything else. Hooks are NOT archivable —
 * they're folders on the local machine, not workspace nodes — so a dropped
 * hook opens the explanatory move-to-Trash modal instead of ever reaching
 * `partitionArchivable`/the archive endpoint. Pure so it's unit-testable
 * without simulating DataTransfer/drag events in jsdom (same reasoning as
 * `partitionArchivable`).
 */
function splitHookPayloads(payloads: DragPayload[]): {
  hooks: DragPayload[];
  rest: DragPayload[];
} {
  const hooks: DragPayload[] = [];
  const rest: DragPayload[] = [];
  for (const p of payloads) {
    (p.kind === 'hook' ? hooks : rest).push(p);
  }
  return { hooks, rest };
}

/**
 * Splits dragged payloads into ones the archive endpoint can act on vs.
 * everything else (currently just 'agent'). Pure so it's unit-testable
 * without simulating DataTransfer/drag events in jsdom.
 */
export function partitionArchivable(payloads: DragPayload[]): {
  archivable: DragPayload[];
  rejected: DragPayload[];
} {
  const archivable: DragPayload[] = [];
  const rejected: DragPayload[] = [];
  for (const p of payloads) {
    const ok = ARCHIVABLE_KINDS.has(p.kind) && (p.kind !== 'table' || isArchivableTableId(p.id));
    (ok ? archivable : rejected).push(p);
  }
  return { archivable, rejected };
}

interface ArchiveDropZoneProps {
  /** Click handler — toggles the archived drawer in the parent. */
  onToggleDrawer: () => void;
  /** Whether the drawer is currently open (controls active visual state). */
  drawerOpen: boolean;
}

export const ArchiveDropZone: React.FC<ArchiveDropZoneProps> = ({ onToggleDrawer, drawerOpen }) => {
  const [hovering, setHovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** hookName of a dropped hook awaiting the move-to-Trash modal decision. */
  const [hookToTrash, setHookToTrash] = useState<string | null>(null);

  // Auto-clear flash messages after a moment so the icon isn't permanently
  // labeled with stale state.
  useEffect(() => {
    if (!lastResult && !error) return;
    const id = window.setTimeout(() => {
      setLastResult(null);
      setError(null);
    }, 4000);
    return () => window.clearTimeout(id);
  }, [lastResult, error]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    // Only accept the LibraryTree drag MIME, Database table chips and table
    // columns — pane drags, other chips and arbitrary browser drags should
    // fall through.
    if (
      !e.dataTransfer.types.includes(TREE_NODE_MIME) &&
      !draggedTableChip(e.dataTransfer) &&
      !draggedTableField(e.dataTransfer)
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setHovering(true);
  }, []);

  const archiveTable = useCallback(async (chip: NodeChipData) => {
    const knownName = chip.title?.trim() || chip.name?.trim() || getCachedTableEntry(chip.id)?.name;
    if (!isArchivableTableId(chip.id)) {
      // Snaglet's built-in tables are seed-managed; only your own tables archive.
      setLastResult(null);
      setError("Snaglet tables can't be archived");
      return;
    }
    setBusy(true);
    setError(null);
    setLastResult(null);
    // The sidebar drops the row and open table panes show it as archived;
    // the toast's Undo brings it back.
    const result = await archiveTables([{ id: chip.id, name: knownName ?? 'table' }]);
    setBusy(false);
    if (result.error) setError(result.error);
    announceTableArchive(result);
  }, []);

  /**
   * Archive dragged table rows — a Tables group or Database sidebar
   * selection — as one step: one toast, one Undo for all of them.
   */
  const archiveTableRows = useCallback(async (rows: DragPayload[], skipped: number) => {
    setBusy(true);
    setError(null);
    setLastResult(null);
    const result = await archiveTables(rows.map(archivingTable));
    setBusy(false);
    if (result.error) setError(result.error);
    else if (skipped > 0) setLastResult(`Skipped ${skipped}`);
    announceTableArchive(result);
    // Archive-aware surfaces hear it like any other trash drop; tables are
    // not tree nodes, so nothing reloads.
    const ids = [...result.archived, ...result.alreadyArchived].map((table) => table.id);
    if (ids.length > 0) emitLibraryEvent({ type: 'archive-changed', ids, reload: false });
  }, []);

  /** Archive a dropped column: hidden, kept, restorable from Archived (an undoable step). */
  const archiveField = useCallback(async (payload: TableFieldDragPayload) => {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const result = await tablesApi.archiveField(payload.tableId, payload.fieldId);
      const name = result.field.name || payload.name;
      // Open panes of the table drop the column; the server's own
      // `table.fields.changed` echo is a no-op after this.
      emitTableEvent({ type: 'table.fields.changed', tableId: payload.tableId });
      showToast(
        result.changed
          ? `Archived column “${name}”. Restore it from Archived, or undo.`
          : `Column “${name}” is already archived.`,
        { durationMs: 3000 }
      );
    } catch (err) {
      setError(getErrorMessage(err, `Failed to archive column ${payload.name}`));
    } finally {
      setBusy(false);
    }
  }, []);

  const onDragLeave = useCallback(() => {
    setHovering(false);
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      setHovering(false);
      const raw = e.dataTransfer.getData(TREE_NODE_MIME);
      if (!raw) {
        const column = draggedTableField(e.dataTransfer);
        if (column) {
          e.preventDefault();
          await archiveField(column);
          return;
        }
        const table = draggedTableChip(e.dataTransfer);
        if (!table) return;
        e.preventDefault();
        await archiveTable(table);
        return;
      }
      e.preventDefault();

      const parsed = safeJsonParse<DragPayload | DragPayload[] | undefined>(raw, undefined);
      if (parsed === undefined) {
        setError('Could not read dragged item');
        return;
      }
      const payloads = Array.isArray(parsed) ? parsed : [parsed];

      if (payloads.length === 0) return;

      // Hooks are not archivable — a dropped hook opens the explanatory
      // move-to-Trash modal instead of hitting the archive endpoint. Drags
      // from the Automations list are single-row, so acting on the first hook is the
      // whole gesture; the modal handles confirm/cancel from here.
      const { hooks, rest } = splitHookPayloads(payloads);
      if (hooks.length > 0) setHookToTrash(hooks[0].id);
      if (rest.length === 0) return;

      const { archivable, rejected } = partitionArchivable(rest);

      if (archivable.length === 0) {
        // Every dropped payload is a kind the archive endpoint can't act on
        // (e.g. a pane-only kind with no archive path). Show a clear notice and
        // skip the network call entirely; there's nothing for the server to
        // look up.
        setError("Can't archive this item");
        return;
      }

      // Only tables (a Tables group or Database sidebar selection): one
      // step, one Undo. A mixed drop keeps the per-item path below.
      if (archivable.every((p) => p.kind === 'table')) {
        await archiveTableRows(archivable, rejected.length);
        return;
      }

      const skippedSuffix = rejected.length > 0 ? `, skipped ${rejected.length}` : '';

      setBusy(true);
      setError(null);
      const archivedIds: string[] = [];
      let failed = 0;
      // The first refusal's message is the one the flash shows.
      let firstError: string | null = null;
      for (const p of archivable) {
        if (p.kind === 'automation') {
          // Deleted (status 'cancelled'): it never fires, leaves the
          // Automations view at once and waits in Archived, as it was, to be
          // restored. The server's `automations:changed` re-read confirms it.
          try {
            const { automation } = await automationsApi.remove(p.id);
            upsertAutomation(automation);
            archivedIds.push(p.id);
          } catch (err) {
            failed += 1;
            firstError ??= getErrorMessage(err, `Failed to archive ${p.label ?? p.id}`);
          }
          continue;
        }
        try {
          await archiveApi.archive(p.id);
          archivedIds.push(p.id);
          // A table row leaves every Tables group and shows as archived in
          // open panes; the server's own `table.removed` echo is a no-op.
          if (p.kind === 'table') {
            emitTableEvent({ type: 'table.removed', tableId: p.id, state: 'archived' });
          }
        } catch (err) {
          failed += 1;
          firstError ??= getErrorMessage(err, `Failed to archive ${p.id}`);
        }
      }
      const ok = archivedIds.length;

      setBusy(false);
      if (firstError) setError(firstError);
      setLastResult(
        failed === 0
          ? `Archived ${ok} item${ok === 1 ? '' : 's'}${skippedSuffix}`
          : `Archived ${ok}, failed ${failed}${skippedSuffix}`
      );
      // Tell the library tree (and other archive-aware surfaces) to refresh;
      // the tree prunes the explicit ids optimistically. A container or
      // project cascades to its children server-side, so archiving one asks
      // for a full tree refetch. Leaf archives skip it, which avoids a
      // loading flicker in every expanded group. Automations are not tree
      // nodes; they leave through the shared automations store.
      const offTreeIds = new Set(
        archivable.filter((p) => OFF_TREE_KINDS.has(p.kind)).map((p) => p.id)
      );
      const libraryIds = archivedIds.filter((id) => !offTreeIds.has(id));
      if (libraryIds.length > 0) {
        // Project containers cascade like any other container.
        const cascadingKinds = new Set(['container']);
        const archivedSet = new Set(libraryIds);
        const reload = payloads.some((p) => archivedSet.has(p.id) && cascadingKinds.has(p.kind));
        emitLibraryEvent({
          type: 'archive-changed',
          ids: libraryIds,
          reload,
        });
      }
    },
    [archiveField, archiveTable, archiveTableRows]
  );

  const flash = error ?? lastResult;

  return (
    <>
      <button
        type="button"
        data-testid="archive-drop-zone"
        className={[
          styles.zone,
          hovering ? styles.hovering : '',
          busy ? styles.busy : '',
          drawerOpen ? styles.active : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={onToggleDrawer}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
        aria-label="Archive — drop items, tables, table columns or automations here to archive them, click to view archived items"
        title="Drop items, tables, table columns or automations here to archive · click to toggle archived drawer"
        disabled={busy}
      >
        <span className={styles.icon} aria-hidden>
          <TrashFillIcon />
        </span>
        {flash && (
          <span
            className={`${styles.flash} ${error ? styles.flashError : styles.flashOk}`}
            role="status"
          >
            {flash}
          </span>
        )}
      </button>
      {hookToTrash && (
        <MoveHookToTrashModal
          hookName={hookToTrash}
          onTrashed={() => {
            // The modal calls this only after the DELETE succeeds, so hook
            // lists drop the row; flash the outcome here.
            setHookToTrash(null);
            setError(null);
            setLastResult(`Moved "${hookToTrash}" to the Trash`);
            emitLibraryEvent({ type: 'hook-deleted', hookName: hookToTrash });
          }}
          onCancel={() => setHookToTrash(null)}
        />
      )}
    </>
  );
};
