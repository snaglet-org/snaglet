/**
 * ArchiveService — the one archive/restore path behind the generic archive
 * routes (`/api/archive`) and the `archive_node` / `restore_node` tools.
 *
 * Workspace nodes archive and restore through the `nodes` flags (cascades live
 * in DB triggers); agents through
 * the agents table (routes only); custom Database tables (catalog ids) through
 * the table lifecycle, which records the step in the caller's undo history.
 *
 * Restoring a node whose container is still archived re-parents it to the
 * nearest live ancestor (or the root): left under the archived container, the
 * live node would be deleted with it by the TTL sweep's FK cascade, since the
 * delete trigger only unhooks archived children. A thread has no container:
 * it is scoped to a project (`nodes.project_id`) or flat, and restoring one
 * whose project is still archived makes it flat for the same reason. A
 * restore placement for a thread names a project (or null for flat).
 */
import { Containers, Docs, Projects, getDb, transaction, type DbQueryable } from '@snaglet/db';
import { TableLifecycle } from '@snaglet/db/tables/table_history';
import { Threads } from '@snaglet/db/tables/threads';
import { Agents } from '@snaglet/db/tables/agents';
import { NODE_KIND, GHOST_AGENT_ID } from '@snaglet/shared/constants';
import { ErrorCode, HTTP_STATUS, isTableCatalogId, type TableField } from '@snaglet/shared/types';
import type { Actor, WorkspaceNodeKind } from '@snaglet/shared/types/workspace-events';
import { AppError, isoNow } from '@snaglet/shared/utils';
import { toTableCatalogEntry, type TableCatalogRow } from '@snaglet/db/tables/table_catalog';
import { emitTableRemoved, emitTableRestored } from '@server/realtime/surfaces/tables';
import { afterTableWrite, historyContext } from '@server/domains/tables/tableHistory';
import {
  emitTreeNodeArchived,
  emitTreeNodeRestored,
  snapshotFromContainer,
  snapshotFromDoc,
  snapshotFromThread,
} from '@server/realtime/surfaces/tree';
import { emitThreadUpdated } from '@server/realtime/surfaces/threads';
import { agentService } from '@server/services/AgentService';
import { hooks } from '@server/services/HookService';
import { archiveTable, customTableRow, restoreTable } from '@server/domains/tables/tableLifecycle';
import { assertNoArchiveSweep } from '@server/services/ArchiveSweepGuard';
import { assertNoHomeThreads, HOME_THREAD_ARCHIVE_MESSAGE } from '@server/services/homeThreadGuard';

/** One row of the archive listing; agents and tables are shaped to fit. */
export interface ArchiveNodeRow {
  id: string;
  type: string;
  title: string | null;
  archived: boolean;
  archived_at: string | null;
  /**
   * The row's parent in the archive listing — the folder for a tree node,
   * the project for a project thread, the table for a field — so a cohort
   * nests under the item that took it along. Null for a root.
   */
  container_id: string | null;
  /** Thread rows only: the project scope, or null for a flat thread. */
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

export const ARCHIVE_NODE_COLUMNS = `n.id, n.type, n.archived, n.archived_at,
              COALESCE(n.container_id, n.project_id) AS container_id, n.project_id,
              n.sort_order, n.created_at, n.updated_at,
              COALESCE(
                c.name, d.title, t.title,
                i.alt_text, m.memory_key
              ) AS title`;

export const ARCHIVE_NODE_JOINS = `LEFT JOIN containers  c  ON c.id  = n.id AND n.type = 'container'
    LEFT JOIN docs        d  ON d.id  = n.id AND n.type = 'doc'
    LEFT JOIN threads     t  ON t.id  = n.id AND n.type = 'thread'
    LEFT JOIN images      i  ON i.id  = n.id AND n.type = 'image'
    LEFT JOIN memories    m  ON m.id  = n.id AND n.type = 'memory'`;

/**
 * Where each node sits: its own name and its ancestors', outermost first,
 * keyed by node id. Ids that are not nodes are left out. The walk up stops at
 * an id it has already visited, so a malformed (cyclic) tree still ends.
 */
export async function loadNodeLocations(ids: Iterable<string>): Promise<Map<string, string[]>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await getDb().query<{ id: string; location: string[] }>(
    `WITH RECURSIVE chain AS (
       SELECT n.id AS start_id, n.id, COALESCE(n.container_id, n.project_id) AS parent_id,
              0 AS depth, ARRAY[n.id] AS visited
         FROM nodes n
        WHERE n.id = ANY($1::text[])
       UNION ALL
       SELECT chain.start_id, up.id, COALESCE(up.container_id, up.project_id), chain.depth + 1,
              chain.visited || up.id
         FROM chain
         JOIN nodes up ON up.id = chain.parent_id
        WHERE up.id <> ALL(chain.visited)
     )
     SELECT chain.start_id AS id,
            array_agg(COALESCE(c.name, d.title, t.title, 'Untitled') ORDER BY chain.depth DESC)
              AS location
       FROM chain
       LEFT JOIN containers c ON c.id = chain.id
       LEFT JOIN docs d ON d.id = chain.id
       LEFT JOIN threads t ON t.id = chain.id
      GROUP BY chain.start_id`,
    [unique]
  );
  return new Map(rows.map((row) => [row.id, row.location]));
}

export async function loadArchiveNode(id: string): Promise<ArchiveNodeRow | null> {
  const { rows } = await getDb().query<ArchiveNodeRow>(
    `SELECT ${ARCHIVE_NODE_COLUMNS}
       FROM nodes n
       ${ARCHIVE_NODE_JOINS}
      WHERE n.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Shape an agent as an archive row. Agents are actors, not nodes: they have
 * no `nodes` row, container or sort order, so those fields are synthesized.
 * `type: 'agent'` is a response-only kind; it is never written to `nodes`.
 */
export function agentToArchiveNode(agent: {
  id: string;
  name: string;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}): ArchiveNodeRow {
  return {
    id: agent.id,
    type: 'agent',
    title: agent.name,
    archived: agent.archived,
    archived_at: agent.archivedAt,
    container_id: null,
    project_id: null,
    sort_order: 0,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt ?? agent.createdAt,
  };
}

/**
 * Shape an automation as an archive row (`type: 'automation'`, a
 * response-only kind). Automations are rows of the builtin Automations
 * table, not nodes: a deleted (canceled) one is an archived one, always a
 * root, and its archive time is its `updatedAt` (a deleted row is never
 * written until it is restored or purged). Its restore and delete go through
 * /api/automations, never the generic archive routes.
 */
export function automationToArchiveNode(automation: {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}): ArchiveNodeRow {
  const archived = automation.status === 'cancelled';
  return {
    id: automation.id,
    type: 'automation',
    title: automation.name,
    archived,
    archived_at: archived ? automation.updatedAt : null,
    container_id: null,
    project_id: null,
    sort_order: 0,
    created_at: automation.createdAt,
    updated_at: automation.updatedAt,
  };
}

/**
 * Shape a custom Database table as an archive row (`type: 'table'`, a
 * response-only kind). Tables are catalog entries, not nodes: a root, unless
 * `nestUnderProject` (the listing, for a table whose project is archived
 * too), which parents it to its project. `project_id` is its project home.
 * `archived` is true only for an archived table.
 */
export function tableToArchiveNode(
  table: TableCatalogRow,
  opts: { nestUnderProject?: boolean } = {}
): ArchiveNodeRow {
  return {
    id: table.id,
    type: 'table',
    title: table.name,
    archived: table.state === 'archived',
    archived_at: table.state === 'archived' ? table.stateChangedAt : null,
    container_id: opts.nestUnderProject ? table.projectId : null,
    project_id: table.projectId,
    sort_order: 0,
    created_at: table.createdAt,
    updated_at: table.stateChangedAt ?? table.createdAt,
  };
}

/** The archive listing's kind for an archived custom-table field (response-only). */
const TABLE_FIELD_ARCHIVE_TYPE = 'table_field';

/**
 * Shape an archived custom-table field as an archive row (`type:
 * 'table_field'`, a response-only kind). `container_id` is its table's
 * catalog id, so a field of an archived table nests under that table's row
 * and the drawer can address its lifecycle routes; a field of an active
 * table is a root titled `<table> › <field>`.
 */
export function tableFieldToArchiveNode(field: TableField, table: TableCatalogRow): ArchiveNodeRow {
  const archivedAt = field.archivedAt ?? null;
  return {
    id: field.id,
    type: TABLE_FIELD_ARCHIVE_TYPE,
    title: table.state === 'archived' ? field.name : `${table.name} › ${field.name}`,
    archived: field.state === 'archived',
    archived_at: archivedAt,
    container_id: table.id,
    project_id: null,
    sort_order: field.position,
    created_at: archivedAt ?? table.createdAt,
    updated_at: archivedAt ?? table.createdAt,
  };
}

export function toWorkspaceNodeKind(type: string | null): WorkspaceNodeKind | null {
  if (type === NODE_KIND.DOC || type === NODE_KIND.CONTAINER || type === NODE_KIND.THREAD) {
    return type;
  }
  return null;
}

async function emitRestoredNodeSnapshot(type: string, id: string): Promise<void> {
  if (type === NODE_KIND.DOC) {
    const doc = await Docs.findById(id);
    if (doc) emitTreeNodeRestored(snapshotFromDoc(doc));
    return;
  }
  if (type === NODE_KIND.CONTAINER) {
    const container = await Containers.findById(id);
    if (container) emitTreeNodeRestored(snapshotFromContainer(container));
    return;
  }
  if (type === NODE_KIND.THREAD) {
    const thread = await Threads.findById(id);
    if (thread) {
      emitTreeNodeRestored(snapshotFromThread(thread));
      // The restore may have made the thread flat (its project was still
      // archived), so the patch carries the project it now has.
      emitThreadUpdated({
        id,
        status: 'active',
        projectId: thread.projectId,
        updatedAt: thread.updatedAt ?? thread.createdAt,
      });
    }
    return;
  }
}

function notFound(message = 'Node not found'): AppError {
  return new AppError(message, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

export interface ArchiveOptions {
  /** Whose request this is (recorded as `archivedBy` for hooks); the ambient actor otherwise. */
  actor?: Actor;
  /** Also archive/restore agents by id (the routes; agent tools do not). */
  includeAgents?: boolean;
  /** Fire the `node:archive` / `node:restore` hooks (tool calls). */
  emitHooks?: boolean;
  hookOrigin?: { kind: 'hook'; hookName: string };
}

export interface ArchiveOutcome {
  node: ArchiveNodeRow | null;
  type: string;
  archivedAt: string | null;
  /** Items archived by this call (0 when it was already archived). */
  affected: number;
  cohortIds: string[];
  alreadyArchived: boolean;
  /** Containers: custom tables of the archived projects, archived with them. */
  tableIds?: string[];
}

export interface RestoreOutcome {
  node: ArchiveNodeRow | null;
  type: string;
  /** Items restored by this call (0 when it was already active). */
  affected: number;
  cohortIds: string[];
  alreadyActive: boolean;
  /**
   * Where the node sits now: its container, a thread's project, or null (the
   * root, a flat thread, or a kind without placement).
   */
  containerId: string | null;
  /**
   * The still-archived container (or, for a thread, project) it was moved
   * out of, when auto-placement re-parented it to {@link containerId};
   * absent otherwise.
   */
  reparentedFrom?: string;
  /** Containers: custom tables archived with the projects it brought back. */
  tableIds?: string[];
  /**
   * Containers: tables archived with those projects that stayed archived
   * because their name was taken meanwhile; restore each under a new name.
   */
  skippedTableIds?: string[];
}

async function archiveNodeRow(
  before: ArchiveNodeRow,
  opts: ArchiveOptions
): Promise<ArchiveOutcome> {
  const pool = getDb();
  const id = before.id;
  if (before.archived)
    return {
      node: before,
      type: before.type,
      archivedAt: before.archived_at,
      affected: 0,
      cohortIds: [],
      alreadyArchived: true,
    };
  if (before.type === NODE_KIND.TOOL) {
    const { rows } = await pool.query<{ type: string | null }>(
      'SELECT type FROM tools WHERE id = $1',
      [id]
    );
    if (rows[0]?.type === 'builtin')
      throw new AppError(
        `Cannot archive node ${id}: built-in tools cannot be archived.`,
        ErrorCode.FORBIDDEN,
        HTTP_STATUS.FORBIDDEN
      );
  }
  // An archived thread expires into a delete; the home thread never goes.
  if (before.type === NODE_KIND.THREAD)
    await assertNoHomeThreads([id], undefined, HOME_THREAD_ARCHIVE_MESSAGE);
  const { rows: nowRows } = await pool.query<{ now: string }>('SELECT now()::text AS now');
  const archivedAt = nowRows[0]?.now ?? isoNow();
  // A container takes the custom tables homed in the projects it archives
  // (itself or ones inside it) along, in the same transaction and cohort.
  const archive = async (runner: DbQueryable) =>
    runner.query('UPDATE nodes SET archived = true, archived_at = $1 WHERE id = $2', [
      archivedAt,
      id,
    ]);
  let tables: TableCatalogRow[] = [];
  if (before.type === NODE_KIND.CONTAINER)
    tables = await transaction(async (tx) => {
      await archive(tx);
      return archiveCohortTables(id, archivedAt, tx);
    });
  else await archive(pool);
  announceTablesArchived(tables);
  const kind = toWorkspaceNodeKind(before.type);
  if (kind) emitTreeNodeArchived(id, kind, archivedAt);
  if (before.type === NODE_KIND.THREAD)
    emitThreadUpdated({ id, status: 'archived', updatedAt: archivedAt });

  // What the cascade archived in this cohort.
  const { rows: cohort } = await pool.query<{ id: string }>(
    'SELECT id FROM nodes WHERE archived = true AND archived_at = $1 ORDER BY id',
    [archivedAt]
  );
  const cohortIds = cohort.map((row) => row.id);
  if (opts.emitHooks)
    hooks.emit('node:archive', {
      rootId: id,
      rootKind: before.type,
      cohortIds,
      count: cohortIds.length,
      archivedBy: opts.actor?.actorId ?? null,
      ...(opts.hookOrigin ? { origin: opts.hookOrigin } : {}),
    });
  return {
    node: await loadArchiveNode(id),
    type: before.type,
    archivedAt,
    affected: (cohortIds.length || 1) + tables.length,
    cohortIds,
    alreadyArchived: false,
    ...(tables.length ? { tableIds: tables.map((table) => table.id) } : {}),
  };
}

/** Project containers archived in cohort `stamp` (the root and any inside it). */
async function cohortProjects(
  stamp: string,
  tx: DbQueryable
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await tx.query<{ id: string; name: string }>(
    `SELECT n.id, c.name
       FROM nodes n
       JOIN containers c ON c.id = n.id
      WHERE n.type = 'container' AND c.category = 'project'
        AND n.archived = true AND n.archived_at = $1::timestamptz
      ORDER BY n.id`,
    [stamp]
  );
  return rows;
}

async function containerName(id: string, tx: DbQueryable): Promise<string> {
  const { rows } = await tx.query<{ name: string }>('SELECT name FROM containers WHERE id = $1', [
    id,
  ]);
  return rows[0]?.name ?? id;
}

/**
 * Archive the active custom tables homed in the projects of cohort
 * `archivedAt` (the root container just archived, and projects inside it),
 * as one step in the caller's table history.
 */
async function archiveCohortTables(
  rootId: string,
  archivedAt: string,
  tx: DbQueryable
): Promise<TableCatalogRow[]> {
  const projects = await cohortProjects(archivedAt, tx);
  if (!projects.length) return [];
  const history = historyContext();
  const result = await TableLifecycle.archiveProjectTables(
    projects.map((project) => project.id),
    archivedAt,
    await containerName(rootId, tx),
    history,
    tx
  );
  return result.item;
}

function announceTablesArchived(tables: readonly TableCatalogRow[]): void {
  if (!tables.length) return;
  for (const table of tables) emitTableRemoved(table.id, 'archived');
  void afterTableWrite(historyContext().actor);
}

/**
 * The nearest live (not archived) node on the container chain starting at
 * `containerId` (itself included), or null for the root when every ancestor
 * is archived or gone.
 */
async function nearestLiveContainer(containerId: string): Promise<string | null> {
  const { rows } = await getDb().query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT n.id, n.container_id, n.archived, 0 AS depth FROM nodes n WHERE n.id = $1
       UNION ALL
       SELECT parent.id, parent.container_id, parent.archived, chain.depth + 1
         FROM nodes parent JOIN chain ON parent.id = chain.container_id
        WHERE chain.archived AND chain.depth < 1000
     )
     SELECT id FROM chain WHERE NOT archived ORDER BY depth LIMIT 1`,
    [containerId]
  );
  return rows[0]?.id ?? null;
}

/** Whether `id` exists and is not archived. */
async function isLiveNode(id: string): Promise<boolean> {
  const { rows } = await getDb().query<{ archived: boolean }>(
    'SELECT archived FROM nodes WHERE id = $1',
    [id]
  );
  return rows[0]?.archived === false;
}

async function restoreNodeRow(
  before: ArchiveNodeRow,
  containerId: string | null | undefined,
  opts: ArchiveOptions
): Promise<RestoreOutcome> {
  const pool = getDb();
  const id = before.id;
  if (!before.archived)
    return {
      node: before,
      type: before.type,
      affected: 0,
      cohortIds: [],
      alreadyActive: true,
      containerId: before.container_id,
    };
  const cohortStamp = before.archived_at;
  const { rows: cohortBefore } = await pool.query<{ id: string }>(
    'SELECT id FROM nodes WHERE archived = true AND archived_at = $1 ORDER BY id',
    [cohortStamp]
  );
  const cohortIds = cohortBefore.map((row) => row.id);

  let target: string | null;
  let reparentedFrom: string | undefined;
  let restoredTables: { restored: TableCatalogRow[]; skipped: TableCatalogRow[] } | null = null;
  if (before.type === NODE_KIND.THREAD) {
    // A thread's placement is its project. An explicit target must be a live
    // project (or null for flat); otherwise the thread keeps its project while
    // that is live and goes flat when the project is still archived — left
    // scoped to it, the TTL sweep's FK cascade would delete the live thread
    // with the project.
    if (containerId !== undefined) {
      await Projects.assertProjectContainer(containerId);
      target = containerId;
    } else if (before.project_id === null) target = null;
    else {
      target = (await isLiveNode(before.project_id)) ? before.project_id : null;
      if (target === null) reparentedFrom = before.project_id;
    }
    // One UPDATE: the archived-row guard allows a scope change only together
    // with the restore.
    await pool.query(
      'UPDATE nodes SET archived = false, archived_at = NULL, project_id = $1 WHERE id = $2',
      [target, id]
    );
  } else if (before.type === NODE_KIND.CONTAINER) {
    if (containerId !== undefined) target = containerId;
    else if (before.container_id === null) target = null;
    else {
      target = await nearestLiveContainer(before.container_id);
      if (target !== before.container_id) reparentedFrom = before.container_id;
    }
    // The custom tables archived with the projects this restore brings back
    // come back with them, in the same transaction.
    const restoreTarget = target;
    restoredTables = await transaction(async (tx) => {
      await tx.query(
        'UPDATE nodes SET archived = false, archived_at = NULL, container_id = $1 WHERE id = $2',
        [restoreTarget, id]
      );
      return cohortStamp ? restoreCohortTables(id, cohortStamp, tx) : null;
    });
  } else {
    if (containerId !== undefined) target = containerId;
    else if (before.container_id === null) target = null;
    else {
      target = await nearestLiveContainer(before.container_id);
      if (target !== before.container_id) reparentedFrom = before.container_id;
    }
    // One UPDATE: the archived-row guard allows a move only together with the restore.
    await pool.query(
      'UPDATE nodes SET archived = false, archived_at = NULL, container_id = $1 WHERE id = $2',
      [target, id]
    );
  }

  if (restoredTables) announceTablesRestored(restoredTables.restored);
  let affected = 1;
  if (cohortStamp) {
    // Direct children brought back by the cascade: placed nodes and, for a
    // project, its threads.
    const { rows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM nodes
        WHERE archived = false AND (container_id = $1 OR project_id = $1)`,
      [id]
    );
    affected = (rows[0]?.count ?? 0) + 1 + (restoredTables?.restored.length ?? 0);
  }
  const node = await loadArchiveNode(id);
  await emitRestoredNodeSnapshot(before.type, id);
  if (opts.emitHooks)
    hooks.emit('node:restore', {
      rootId: id,
      rootKind: before.type,
      cohortIds,
      count: cohortIds.length,
      archivedBy: opts.actor?.actorId ?? null,
      ...(opts.hookOrigin ? { origin: opts.hookOrigin } : {}),
    });
  return {
    node,
    type: before.type,
    affected,
    cohortIds,
    alreadyActive: false,
    containerId: node?.container_id ?? target,
    ...(reparentedFrom !== undefined ? { reparentedFrom } : {}),
    ...(restoredTables?.restored.length
      ? { tableIds: restoredTables.restored.map((table) => table.id) }
      : {}),
    ...(restoredTables?.skipped.length
      ? { skippedTableIds: restoredTables.skipped.map((table) => table.id) }
      : {}),
  };
}

/**
 * Restore the custom tables archived with the projects of cohort `stamp` that
 * the restore of `rootId` just brought back (it may restore only part of the
 * cohort), as one step in the caller's table history. Must run after the
 * node UPDATE, in its transaction.
 */
async function restoreCohortTables(
  rootId: string,
  stamp: string,
  tx: DbQueryable
): Promise<{ restored: TableCatalogRow[]; skipped: TableCatalogRow[] }> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT n.id
       FROM nodes n
       JOIN containers c ON c.id = n.id
      WHERE n.type = 'container' AND c.category = 'project' AND n.archived = false
        AND n.id IN (
          WITH RECURSIVE subtree AS (
            SELECT id FROM nodes WHERE id = $1
            UNION ALL
            SELECT child.id FROM nodes child JOIN subtree s ON child.container_id = s.id
          )
          SELECT id FROM subtree
        )`,
    [rootId]
  );
  const projectIds = rows.map((row) => row.id);
  if (!projectIds.length) return { restored: [], skipped: [] };
  const result = await TableLifecycle.restoreProjectTables(
    projectIds,
    stamp,
    await containerName(rootId, tx),
    historyContext(),
    tx
  );
  return { restored: result.item, skipped: result.skipped };
}

function announceTablesRestored(tables: readonly TableCatalogRow[]): void {
  if (!tables.length) return;
  for (const table of tables) emitTableRestored(toTableCatalogEntry(table));
  void afterTableWrite(historyContext().actor);
}

/** Archive a custom table (an undoable step in the caller's history). */
async function archiveTableItem(id: string): Promise<ArchiveOutcome> {
  const result = await archiveTable(id);
  const row = await customTableRow(id);
  return {
    node: tableToArchiveNode(row),
    type: 'table',
    archivedAt: row.stateChangedAt,
    affected: result.changed ? 1 : 0,
    cohortIds: result.changed ? [id] : [],
    alreadyArchived: !result.changed,
  };
}

async function restoreTableItem(id: string, name: string | undefined): Promise<RestoreOutcome> {
  const result = await restoreTable(id, name === undefined ? {} : { name });
  const row = await customTableRow(id);
  return {
    node: tableToArchiveNode(row),
    type: 'table',
    affected: result.changed ? 1 : 0,
    cohortIds: result.changed ? [id] : [],
    alreadyActive: !result.changed,
    containerId: null,
  };
}

/**
 * Archive any archivable item by id: a custom table (catalog id), a workspace
 * node, or (with `includeAgents`) an agent. Unknown ids are 404.
 */
export async function archiveItem(id: string, opts: ArchiveOptions = {}): Promise<ArchiveOutcome> {
  if (isTableCatalogId(id)) return archiveTableItem(id);
  const before = await loadArchiveNode(id);
  if (before) {
    return archiveNodeRow(before, opts);
  }
  if (opts.includeAgents) {
    const agent = await Agents.findById(id);
    if (agent) {
      // Ghost is a permanent system actor (route-layer guard; the service guards too).
      if (agent.id === GHOST_AGENT_ID)
        throw new AppError(
          'The ghost system agent is permanent and cannot be archived',
          ErrorCode.FORBIDDEN,
          HTTP_STATUS.FORBIDDEN
        );
      if (agent.archived)
        return {
          node: agentToArchiveNode(agent),
          type: 'agent',
          archivedAt: agent.archivedAt,
          affected: 0,
          cohortIds: [],
          alreadyArchived: true,
        };
      // The agent keeps its history but drops out of dispatch and rosters.
      const archived = await agentService.archive(id);
      const node = agentToArchiveNode(archived ?? agent);
      return {
        node,
        type: 'agent',
        archivedAt: node.archived_at,
        affected: 1,
        cohortIds: [id],
        alreadyArchived: false,
      };
    }
  }
  throw notFound();
}

/**
 * Restore any archived item by id. `containerId` (nodes only) overrides the
 * placement: a container id, or null for the root — for a thread, a project
 * id or null for flat. Left undefined, a node keeps its container (a thread
 * its project) while that is live, and otherwise moves to the nearest live
 * ancestor (a thread goes flat). `name` renames a table whose old name is
 * taken.
 */
export async function restoreItem(
  id: string,
  opts: ArchiveOptions & { containerId?: string | null; name?: string } = {}
): Promise<RestoreOutcome> {
  assertNoArchiveSweep();
  if (isTableCatalogId(id)) return restoreTableItem(id, opts.name);
  const before = await loadArchiveNode(id);
  if (before) return restoreNodeRow(before, opts.containerId, opts);
  if (opts.includeAgents) {
    const agent = await Agents.findById(id);
    if (agent) {
      if (!agent.archived)
        return {
          node: agentToArchiveNode(agent),
          type: 'agent',
          affected: 0,
          cohortIds: [],
          alreadyActive: true,
          containerId: null,
        };
      const restored = await agentService.restore(id);
      return {
        node: agentToArchiveNode(restored ?? agent),
        type: 'agent',
        affected: 1,
        cohortIds: [id],
        alreadyActive: false,
        containerId: null,
      };
    }
  }
  throw notFound();
}
