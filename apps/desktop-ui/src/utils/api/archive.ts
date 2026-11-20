import type { ArchivedTablesResponse, TableLinkedField } from '@snaglet/shared/types';
import { fetchData, getApiUrl } from './core';
import { getPanelJsonHeaders } from '../panelToken';

export interface ArchivedNode {
  id: string;
  type: string;
  title: string | null;
  archived: boolean;
  archived_at: string | null;
  /**
   * Tree placement: parent container for folders/docs/images, the table for
   * an archived column — and, for an archived thread, its project id, so the
   * drawer nests the thread under the project it belongs to.
   */
  container_id: string | null;
  /** Threads only: the project the thread is scoped to (null when flat). */
  project_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /**
   * A root whose parent is still active: the names of that parent and its
   * ancestors, outermost first (for a column of an active table, the table's
   * project). Absent on every other row.
   */
  location?: string[];
}

export interface ArchiveCascadeCounts {
  sub_containers: number;
  docs: number;
  projects: number;
  threads: number;
  messages: number;
  memories: number;
}

interface ArchiveCountsResponse {
  node: ArchivedNode;
  counts: ArchiveCascadeCounts;
}

export interface ArchiveTreeResponse {
  roots: ArchivedNode[];
  children: ArchivedNode[];
}

interface ArchiveActionResponse {
  node: ArchivedNode | null;
  affected: number;
  alreadyArchived?: boolean;
  alreadyActive?: boolean;
}

interface RestoreOptions {
  containerId?: string | null;
  /**
   * Custom tables only: restore under this name when the original name is
   * taken (the restore is otherwise a 409).
   */
  name?: string;
}

interface HardDeleteOptions {
  /**
   * Custom tables only: also delete relation fields in other tables that
   * link to it (the delete is otherwise a 409 while any do).
   */
  clearReferences?: boolean;
}

export const archiveApi = {
  list: () => fetchData<ArchiveTreeResponse>(getApiUrl('/archive')),

  /**
   * Archived custom Database tables, newest first — catalog entries carrying
   * `state: 'archived'`, so chips and pane titles can keep showing the name.
   */
  tables: () => fetchData<ArchivedTablesResponse>(getApiUrl('/tables/archived')),

  counts: (id: string) => fetchData<ArchiveCountsResponse>(getApiUrl(`/archive/counts/${id}`)),

  archive: (id: string) =>
    fetchData<ArchiveActionResponse>(getApiUrl(`/archive/${id}`), {
      method: 'POST',
    }),

  restore: (id: string, opts: RestoreOptions = {}) =>
    fetchData<ArchiveActionResponse>(getApiUrl(`/archive/${id}/restore`), {
      method: 'POST',
      body: JSON.stringify({
        ...('containerId' in opts ? { container_id: opts.containerId ?? null } : {}),
        ...(opts.name !== undefined ? { name: opts.name } : {}),
      }),
    }),

  // For an agent, hard delete is the ghost purge: the agent + member rows
  // are deleted for real, its private trash destroyed, and its kept references
  // repointed to the permanent `ghost` system agent. For a node it's a row
  // delete; for a custom table it drops the table and its entries.
  hardDelete: (id: string, opts: HardDeleteOptions = {}) =>
    fetchData<{
      id: string;
      deleted: number;
      was: ArchivedNode;
      /** Custom tables: relation fields in other tables deleted with it. */
      deletedLinkedFields?: TableLinkedField[];
    }>(getApiUrl(`/archive/${id}${opts.clearReferences ? '?clearReferences=true' : ''}`), {
      method: 'DELETE',
    }),

  ttlSweep: () =>
    fetchData<{
      result: { deletedContainers: number; deletedOther: number };
      ranAt: string;
    }>(getApiUrl('/archive/ttl-sweep'), { method: 'POST' }),

  // `deletedAgents` — archived agents are actors, not nodes, so they're purged
  // (ghost-repointed then deleted) separately from the node TTL sweep.
  // `deletedTables` / `skippedTables` — archived custom tables go too, except
  // those other tables' relation fields still link to (kept for an explicit
  // per-table delete). `deletedFields` — archived columns of tables still
  // listed after that, dropped for good on their own. `deletedAutomations` —
  // deleted (archived) automations, purged with their run logs; the route
  // needs the panel token for them.
  sweepAll: () =>
    fetchData<{
      result: {
        deletedContainers: number;
        deletedOther: number;
        deletedAgents?: number;
        /** Deleted (archived) automations, purged with their run logs. */
        deletedAutomations?: number;
        deletedTables?: number;
        deletedFields?: number;
        skippedTables?: string[];
      };
      ranAt: string;
    }>(getApiUrl('/archive/sweep-all'), { method: 'POST', headers: getPanelJsonHeaders() }),
};
