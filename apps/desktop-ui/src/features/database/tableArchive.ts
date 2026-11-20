/**
 * Archiving custom tables from the sidebar trash, as one undoable step.
 *
 * A dropped table chip or a dragged selection of table rows (the workspace
 * tree's Tables groups, the Database sidebar) archives through the generic
 * archive route, one table after another, with no confirmation. The toast
 * names what went ("Archived “budget”", "Archived 3 tables") and its Undo
 * restores every table the drop archived, back in its group.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { archiveApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { emitTableEvent } from './tableEvents';
import { isArchivableTableId, restoredTableEntry } from './tableLifecycle';

/** A custom table to archive, as the surface it was dragged from knows it. */
export interface ArchivingTable {
  id: string;
  name: string;
  /** Its slot in its list, so an undo puts the row back where it was. */
  sortOrder?: number;
}

interface TableArchiveResult {
  /** Tables this call archived, in the order given. */
  archived: ArchivingTable[];
  /** Tables that were archived already; an undo leaves them archived. */
  alreadyArchived: ArchivingTable[];
  /** How many tables the server refused. */
  failed: number;
  /** The first refusal's message, or null when none was refused. */
  error: string | null;
}

/**
 * Archive custom tables one after another. Each archived table leaves every
 * table surface at once (`table.removed`; the server's own echo is a no-op)
 * and takes its archived name from the server. A refusal keeps that table
 * listed and the rest still go; built-in ids never send a request.
 */
export async function archiveTables(
  tables: readonly ArchivingTable[]
): Promise<TableArchiveResult> {
  const result: TableArchiveResult = { archived: [], alreadyArchived: [], failed: 0, error: null };
  for (const table of tables) {
    if (!isArchivableTableId(table.id)) continue;
    try {
      const response = await archiveApi.archive(table.id);
      const done = { ...table, name: response.node?.title?.trim() || table.name };
      if (response.alreadyArchived) {
        result.alreadyArchived.push(done);
        continue;
      }
      result.archived.push(done);
      emitTableEvent({ type: 'table.removed', tableId: table.id, state: 'archived' });
    } catch (err) {
      result.failed += 1;
      result.error ??= getErrorMessage(err, `Failed to archive ${table.name}`);
    }
  }
  return result;
}

/**
 * Restore tables archived together, one after another; each shows again in
 * its group. A refusal (its old name was taken since) is a toast, and the
 * rest are still restored.
 */
async function restoreTables(tables: readonly ArchivingTable[]): Promise<void> {
  for (const table of tables) {
    try {
      const response = await archiveApi.restore(table.id);
      const entry = response.node ? restoredTableEntry(response.node) : null;
      emitTableEvent(
        entry
          ? {
              type: 'table.restored',
              table: { ...entry, sortOrder: table.sortOrder ?? entry.sortOrder },
            }
          : { type: 'tables.invalidated' }
      );
    } catch (err) {
      showToast(`Couldn't restore “${table.name}”: ${getErrorMessage(err, 'restore failed')}`);
    }
  }
}

function archivedLabel(tables: readonly ArchivingTable[]): string {
  return tables.length === 1 ? `“${tables[0].name}”` : `${tables.length} tables`;
}

/**
 * The toast for an archive: what went, with an Undo that restores all of it
 * as one step. Tables that were archived already are only named.
 */
export function announceTableArchive({ archived, alreadyArchived }: TableArchiveResult): void {
  if (archived.length > 0) {
    showToast(`Archived ${archivedLabel(archived)}`, {
      action: { label: 'Undo', run: () => void restoreTables(archived) },
    });
    return;
  }
  if (alreadyArchived.length > 0) {
    showToast(
      `${archivedLabel(alreadyArchived)} ${alreadyArchived.length === 1 ? 'is' : 'are'} already archived`
    );
  }
}
