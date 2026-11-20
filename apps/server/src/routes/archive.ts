/**
 * Archive API: archive, restore, hard-delete, list and preview counts for any
 * node, plus admin TTL sweeps. Node cascades live in DB triggers, so the HTTP
 * layer is thin; archive and restore go through ArchiveService (shared with
 * the archive tools). Agents and custom tables are not nodes and are handled
 * separately: a table's archive and restore are undo steps, its delete is for
 * good. Archived table fields and canceled automations are listed here too,
 * but restore and delete through their own routes (automations need the panel
 * token).
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { panelAuthMiddleware } from '@server/middleware/panelAuth';
import { sendOk } from '@server/utils/http';
import { AppError, isoNow } from '@snaglet/shared/utils';
import { NODE_KIND, GHOST_AGENT_ID } from '@snaglet/shared/constants';
import { HTTP_STATUS, ErrorCode, isTableCatalogId } from '@snaglet/shared/types';
import { getDb } from '@snaglet/db';
import {
  helperThreadContentExclusionSql,
  helperThreadExclusionSql,
} from '@snaglet/db/tables/threads/visibility';
import { Agents } from '@snaglet/db/tables/agents';
import { Automations } from '@snaglet/db/tables/automations';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { agentService } from '@server/services/AgentService';
import { automationService } from '@server/services/automations/AutomationService';
import { archiveTtlSweeper } from '@server/services/ArchiveTtlSweeper';
import { purgeExpiredArchivedNodes } from '@server/services/ArchivePurge';
import { emitTreeNodeDeleted } from '@server/realtime/surfaces/tree';
import { emitThreadDeleted } from '@server/realtime/surfaces/threads';
import { getCurrentActor } from '@server/realtime/actorContext';
import {
  ARCHIVE_NODE_COLUMNS,
  ARCHIVE_NODE_JOINS,
  agentToArchiveNode,
  archiveItem,
  automationToArchiveNode,
  loadArchiveNode as loadNode,
  loadNodeLocations,
  restoreItem,
  tableFieldToArchiveNode,
  tableToArchiveNode,
  toWorkspaceNodeKind,
  type ArchiveNodeRow,
} from '@server/services/ArchiveService';
import {
  announceProjectTablesDrop,
  archiveTableCounts,
  dropTablesOfDeletedContainer,
  listAllArchivedTableFields,
  purgeArchivedTable,
  purgeTableField,
  type ProjectTablesDrop,
} from '@server/domains/tables/tableLifecycle';
import {
  listThreadIdsInNodeSubtree,
  lockThreadIdsInNodeSubtree,
  withThreadExecutionPurge,
} from '@server/services/ThreadExecutionPurgeService';

const router = Router();

// GET /api/archive — archived tree + flat orphan list

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const pool = getDb();

    // A node's archive parent is its container, or for a thread its project
    // (flat threads have neither). Roots: no parent, or a parent that is not
    // archived — items inside a still-active container or project show as
    // roots of the archived view too. Parent-node lookup uses the `np` alias
    // to avoid colliding with the kind aliases bound inside ARCHIVE_NODE_JOINS.
    // Subagent helper threads carry their parent's project, so archiving a
    // project archives them too; they are never listed (nor is anything in
    // them).
    const { rows: roots } = await pool.query<ArchiveNodeRow>(
      `SELECT ${ARCHIVE_NODE_COLUMNS}
         FROM nodes n
         ${ARCHIVE_NODE_JOINS}
    LEFT JOIN nodes np ON np.id = COALESCE(n.container_id, n.project_id)
        WHERE n.archived = true
          AND (np.id IS NULL OR np.archived = false)
          AND ${helperThreadContentExclusionSql('n.id')}
     ORDER BY n.archived_at DESC NULLS LAST`
    );

    // Children: archived nodes whose parent is also archived (cohort grouping).
    const { rows: children } = await pool.query<ArchiveNodeRow>(
      `SELECT ${ARCHIVE_NODE_COLUMNS}
         FROM nodes n
         ${ARCHIVE_NODE_JOINS}
         JOIN nodes np ON np.id = COALESCE(n.container_id, n.project_id)
        WHERE n.archived = true
          AND np.archived = true
          AND ${helperThreadContentExclusionSql('n.id')}
     ORDER BY n.sort_order, n.id`
    );

    // Archived agents are actors, not nodes: they live in
    // public.agents, so the nodes query above can't see them. Fetch them
    // separately and append as roots (agents have no container). The drawer
    // renders them by `type: 'agent'` (🤖) with the same restore/delete actions.
    const archivedAgents = await Agents.listArchived();
    const agentRoots = archivedAgents.map(agentToArchiveNode);
    // Deleted (canceled) automations are archived ones: rows of the builtin
    // Automations table, not nodes, so always roots, most recently deleted
    // first. The drawer restores and deletes them through /api/automations.
    const automationRoots = (await Automations.listCanceled()).map(automationToArchiveNode);
    // Archived custom tables are catalog entries, not nodes. One homed in an
    // archived project nests under it (it was archived with it, or before it);
    // the rest are roots.
    const archivedTables = await TableCatalog.listTables({ origin: 'custom', state: 'archived' });
    const archivedIds = new Set([...roots, ...children].map((row) => row.id));
    const tableRoots: ArchiveNodeRow[] = [];
    for (const table of archivedTables) {
      const homeArchived = table.projectId !== null && archivedIds.has(table.projectId);
      const row = tableToArchiveNode(table, { nestUnderProject: homeArchived });
      (homeArchived ? children : tableRoots).push(row);
    }
    // Archived fields (`type: 'table_field'`) nest under their archived
    // table's row, or stand as `<table> › <field>` roots when the table is
    // active. Their restore and delete go through /api/tables/:id/fields.
    const archivedFields = await listAllArchivedTableFields();
    const fieldRoots: ArchiveNodeRow[] = [];
    const fieldChildren: ArchiveNodeRow[] = [];
    // A root under a still-active parent carries that parent's location, so
    // the drawer can say (and search) where it was.
    const activeParents = new Map<ArchiveNodeRow, string>();
    for (const row of roots) if (row.container_id) activeParents.set(row, row.container_id);
    for (const row of tableRoots) if (row.project_id) activeParents.set(row, row.project_id);
    for (const { field, table } of archivedFields) {
      const row = tableFieldToArchiveNode(field, table);
      if (table.state === 'archived') {
        fieldChildren.push(row);
        continue;
      }
      fieldRoots.push(row);
      if (table.projectId) activeParents.set(row, table.projectId);
    }
    const locations = await loadNodeLocations(activeParents.values());
    for (const [row, parentId] of activeParents) {
      const location = locations.get(parentId);
      if (location) row.location = location;
    }

    sendOk(res, {
      roots: [...roots, ...agentRoots, ...automationRoots, ...tableRoots, ...fieldRoots],
      children: [...children, ...fieldChildren],
    });
  })
);

// GET /api/archive/counts/:id — preview counts for the archive confirmation modal

router.get(
  '/counts/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const pool = getDb();

    // A table's counts: its entries and fields, and the relation fields
    // elsewhere that link to it (kept; their links show as unavailable).
    if (isTableCatalogId(id)) {
      const { table, counts } = await archiveTableCounts(id);
      sendOk(res, {
        node: tableToArchiveNode(table),
        counts: {
          sub_containers: 0,
          docs: 0,
          projects: 0,
          threads: 0,
          messages: 0,
          memories: 0,
          ...counts,
        },
      });
      return;
    }

    const node = await loadNode(id);
    if (!node) {
      throw new AppError('Node not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    // Recursive descendant counts via the container_id chain, plus the live
    // threads scoped to any project container in it (the root included) —
    // the archive cascade follows project_id as well. Type-specific children
    // (messages, memories) join their semantic FK. Subagent helper threads
    // (and so their messages) are archived along but not counted.
    const { rows } = await pool.query<{
      sub_containers: number;
      docs: number;
      projects: number;
      threads: number;
      messages: number;
      memories: number;
    }>(
      `WITH RECURSIVE subtree AS (
         SELECT id, type, container_id FROM nodes WHERE id = $1
         UNION ALL
         SELECT n.id, n.type, n.container_id
           FROM nodes n
           JOIN subtree s ON n.container_id = s.id
          WHERE n.archived = false
       ),
       threads_in_scope AS (
         SELECT id FROM subtree WHERE type = 'thread'
         UNION
         SELECT n.id FROM nodes n
          WHERE n.type = 'thread'
            AND n.archived = false
            AND n.project_id IN (SELECT id FROM subtree WHERE type = 'container')
            AND ${helperThreadExclusionSql('n.id')}
       )
       SELECT
         COUNT(*) FILTER (WHERE type = 'container' AND id <> $1)::int AS sub_containers,
         COUNT(*) FILTER (WHERE type = 'doc')::int                    AS docs,
         (SELECT COUNT(*)::int FROM containers c
           WHERE c.id IN (SELECT id FROM subtree WHERE type = 'container')
             AND c.category = 'project')                              AS projects,
         (SELECT COUNT(*)::int FROM threads_in_scope)                 AS threads,
         (SELECT COUNT(*)::int FROM messages m
            JOIN nodes n ON n.id = m.id
           WHERE m.thread_id IN (SELECT id FROM threads_in_scope)
             AND n.archived = false)                                  AS messages,
         (SELECT COUNT(*)::int FROM memories m
            JOIN nodes n ON n.id = m.id
           WHERE m.source_thread_id IN (SELECT id FROM threads_in_scope)
             AND n.archived = false)                                  AS memories
       FROM subtree`,
      [id]
    );

    sendOk(res, {
      node,
      counts: rows[0] ?? {
        sub_containers: 0,
        docs: 0,
        projects: 0,
        threads: 0,
        messages: 0,
        memories: 0,
      },
    });
  })
);

// POST /api/archive/ttl-sweep: admin, force an out-of-cycle TTL sweep.
// Declared before `POST /:id`, which would otherwise take "ttl-sweep" as an id.

router.post(
  '/ttl-sweep',
  asyncHandler(async (_req, res) => {
    const result = await archiveTtlSweeper.tick();
    sendOk(res, {
      result: result ?? { deletedContainers: 0, deletedOther: 0 },
      ranAt: isoNow(),
    });
  })
);

// POST /api/archive/sweep-all: hard-delete every archived node, ignoring the
// TTL (archive_ttl_sweep with a zero interval). Needs the panel token: it
// deletes archived automations and their run logs, which only people may.
// When the node sweep stops partway, the error says so and nothing after it
// runs: the archived tables below would include those of projects not swept.

router.post(
  '/sweep-all',
  panelAuthMiddleware,
  asyncHandler(async (_req, res) => {
    const swept = await purgeExpiredArchivedNodes('0 seconds');

    // archive_ttl_sweep only touches public.nodes — agents are actors, not nodes
    // so the SQL sweep above never sees them and the drawer's "Sweep"
    // button appeared to do nothing to archived agents (the reported bug). Purge
    // every archived agent here too, via the same ghost purge the per-row Delete
    // uses. listArchived already excludes ghost, so it is never swept; the
    // real agent rows are deleted (their kept references repointed to ghost).
    // An agent whose DM threads cannot go yet (a run still active in one is a
    // 409) is kept for a later sweep, like a linked table below, instead of
    // aborting the sweep after earlier agents were already purged.
    const archivedAgents = await Agents.listArchived();
    let deletedAgents = 0;
    const skippedAgents: string[] = [];
    for (const agent of archivedAgents) {
      if (agent.id === GHOST_AGENT_ID) continue; // never sweep ghost (belt)
      try {
        const purged = await agentService.purge(agent.id);
        if (purged) deletedAgents += 1;
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== HTTP_STATUS.CONFLICT) throw error;
        skippedAgents.push(agent.id);
      }
    }

    // Deleted (archived) automations go for good, with their kept schedules
    // and run logs; the wakes they posted stay in their threads.
    const deletedAutomations = await automationService.purgeArchived({ kind: 'person' });

    // Archived tables go too, except those other tables' relation fields
    // still link to: dropping them would change those tables' schemas, so
    // they stay for an explicit per-table delete.
    const archivedTables = await TableCatalog.listTables({ origin: 'custom', state: 'archived' });
    let deletedTables = swept.tables.dropped.length;
    const skippedTables: string[] = [];
    for (const table of archivedTables) {
      try {
        await purgeArchivedTable(table.id, { clearReferences: false });
        deletedTables += 1;
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== HTTP_STATUS.CONFLICT) throw error;
        skippedTables.push(table.id);
      }
    }

    // Archived fields go the same way as archived tables: a field of a
    // table purged above went with it; one whose table is still listed
    // (active, or an archived table kept for its links) is dropped for good
    // on its own, since only its own table's schema changes.
    let deletedFields = 0;
    for (const { field, table } of await listAllArchivedTableFields()) {
      await purgeTableField(table.id, field.id);
      deletedFields += 1;
    }

    sendOk(res, {
      result: {
        deletedContainers: swept.deletedContainers,
        deletedOther: swept.deletedOther,
        deletedAgents,
        deletedAutomations,
        deletedTables,
        deletedFields,
        skippedTables,
        skippedAgents,
      },
      ranAt: isoNow(),
    });
  })
);

// POST /api/archive/:id — set archived=true (cascade via triggers)

router.post(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await archiveItem(req.params.id, {
      actor: getCurrentActor(),
      includeAgents: true,
    });
    sendOk(res, {
      node: result.node,
      affected: result.affected,
      alreadyArchived: result.alreadyArchived,
    });
  })
);

// POST /api/archive/:id/restore — set archived=false (cascade via triggers)
// Optional body: { container_id?: string | null } — when present overrides the
// auto-placement (drag-to-restore): a container id, or for a thread a project
// id; null is the root (a flat thread). When omitted, the node keeps its
// container (a thread its project) while that is live, and otherwise moves to
// the nearest live ancestor (a thread goes flat); `reparented_from` says so.

router.post(
  '/:id/restore',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { container_id?: unknown; name?: unknown };
    const containerId = body.container_id;
    if (
      'container_id' in body &&
      containerId !== null &&
      (typeof containerId !== 'string' || !containerId)
    )
      throw new AppError(
        'container_id must be a container id (a project id for a thread) or null',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    if (body.name !== undefined && typeof body.name !== 'string')
      throw new AppError(
        'name must be a string',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    const result = await restoreItem(req.params.id, {
      actor: getCurrentActor(),
      includeAgents: true,
      ...('container_id' in body ? { containerId: containerId as string | null } : {}),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
    });
    sendOk(res, {
      node: result.node,
      affected: result.affected,
      alreadyActive: result.alreadyActive,
      container_id: result.containerId,
      ...(result.reparentedFrom !== undefined ? { reparented_from: result.reparentedFrom } : {}),
    });
  })
);

// DELETE /api/archive/:id — hard-delete (FK cascades + trigger cleanup)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;

    // A custom table: dropped for good with its data (not undoable). Relation
    // fields of other tables that link to it are a 409 unless
    // `?clearReferences=true`, which drops them too.
    if (isTableCatalogId(id)) {
      const clear = req.query.clearReferences;
      if (clear !== undefined && clear !== 'true' && clear !== 'false')
        throw new AppError(
          'clearReferences must be true or false',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      const { table, linked } = await purgeArchivedTable(id, {
        clearReferences: clear === 'true',
      });
      sendOk(res, {
        id,
        deleted: 1,
        was: tableToArchiveNode(table),
        deletedLinkedFields: linked,
      });
      return;
    }

    const before = await loadNode(id);
    if (!before) {
      // Agents are actors, not nodes. Hard delete is the ghost purge:
      // agentService.purge deletes the agent's memories and thread summaries,
      // repoints every kept reference (messages, runs, attribution) to the
      // permanent `ghost` agent, then deletes the agent and member rows.
      const agent = await Agents.findById(id);
      if (agent) {
        // Ghost is undeletable; the service and a DB trigger guard this too.
        if (agent.id === GHOST_AGENT_ID) {
          throw new AppError(
            'The ghost system agent is permanent and cannot be deleted',
            ErrorCode.FORBIDDEN,
            HTTP_STATUS.FORBIDDEN
          );
        }
        const purged = await agentService.purge(id);
        // null: already deleted, so an idempotent 404.
        if (!purged) {
          throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
        sendOk(res, {
          id,
          deleted: 1,
          purged,
          was: agentToArchiveNode(agent),
        });
        return;
      }
      throw new AppError('Node not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    const clear = req.query.clearReferences;
    if (clear !== undefined && clear !== 'true' && clear !== 'false')
      throw new AppError(
        'clearReferences must be true or false',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    const threadIds = await listThreadIdsInNodeSubtree(id);
    // A container takes the custom tables of the projects it deletes along
    // (409 while other tables link to them, unless clearReferences).
    let tables: ProjectTablesDrop | null = null;
    const deleted = await withThreadExecutionPurge(
      threadIds,
      async ({ tx }) => {
        if (before.type === NODE_KIND.CONTAINER)
          tables = await dropTablesOfDeletedContainer(
            id,
            { clearReferences: clear === 'true' },
            tx
          );
        return tx.query(`DELETE FROM nodes WHERE id = $1`, [id]);
      },
      // Same guard as DELETE /api/containers/:id: re-list the cohort under
      // lock, so a thread scoped into the subtree after the preflight read
      // aborts the delete instead of cascading away unpurged.
      { lockAndListThreadIds: (tx) => lockThreadIdsInNodeSubtree(id, tx) }
    );
    if (tables) announceProjectTablesDrop(tables);
    const { rowCount } = deleted.value;
    const kind = toWorkspaceNodeKind(before.type);
    if (kind) {
      emitTreeNodeDeleted(id, kind);
    }
    if (before.type === NODE_KIND.THREAD) {
      emitThreadDeleted(id);
    }
    sendOk(res, { id, deleted: rowCount ?? 0, was: before });
  })
);

export default router;
