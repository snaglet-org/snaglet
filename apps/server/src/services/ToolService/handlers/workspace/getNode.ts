import { getDb } from '@snaglet/db';
import { Threads } from '@snaglet/db/tables/threads';
import { activeRunMarker, getThreadActivity } from '@server/services/activeThreadRuns';
import {
  isArchived,
  filterArchived,
} from '@server/services/ToolService/tools/_shared/archiveGuard';

interface WorkspaceGetNodeInput {
  node_id: string;
  include_children?: boolean;
  include_archived?: boolean;
}

interface NodeRow {
  id: string;
  type: string;
  title: string | null;
  archived: boolean;
  archived_at: string | null;
  container_id: string | null;
  /** Threads only: the project the thread is scoped to, null when flat. */
  project_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  // Machine-readable annotations — nullable, and only populated for the kind
  // that carries them (category + project facets on containers). Surfaced so
  // agents can read a container's category or a project's facets without a
  // second fetch. (A doc's due_at/assigned_to/priority columns are not
  // surfaced: tasks are Database table rows.) The project facets
  // (folder_path/github_url/description) come straight off the containers row.
  category: string | null;
  folder_path: string | null;
  github_url: string | null;
  description: string | null;
  /**
   * Optimistic-concurrency revision token. The two kinds that carried one
   * (Sketch, Board posts) are both removed, so it is always null now; kept on
   * the row and output so the shape stays stable for any future revisioned kind.
   */
  revision: number | null;
}

/**
 * Canonical generic-node join map. Mirrors routes/archive.ts so that a node of
 * any kind resolves to a single human-readable title, plus the light
 * annotations (container category and project facets).
 */
const NODE_COLUMNS = `n.id, n.type, n.archived, n.archived_at, n.container_id,
    n.project_id, n.sort_order, n.created_at, n.updated_at,
    c.category AS category,
    c.folder_path AS folder_path, c.github_url AS github_url,
    c.description AS description,
    NULL::int AS revision,
    COALESCE(
      c.name, d.title, t.title,
      i.alt_text, m.memory_key
    ) AS title`;

const NODE_JOINS = `LEFT JOIN containers  c  ON c.id  = n.id AND n.type = 'container'
    LEFT JOIN docs        d  ON d.id  = n.id AND n.type = 'doc'
    LEFT JOIN threads     t  ON t.id  = n.id AND n.type = 'thread'
    LEFT JOIN images      i  ON i.id  = n.id AND n.type = 'image'
    LEFT JOIN memories    m  ON m.id  = n.id AND n.type = 'memory'`;

export default async function execute(params: WorkspaceGetNodeInput) {
  const nodeId = (params.node_id ?? '').trim();
  if (!nodeId) {
    throw new Error('node_id is required');
  }

  const pool = getDb();

  const { rows } = await pool.query<NodeRow>(
    `SELECT ${NODE_COLUMNS}
       FROM nodes n
       ${NODE_JOINS}
      WHERE n.id = $1`,
    [nodeId]
  );

  const node = rows[0];
  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  // Archived nodes are invisible to default reads. Surface as not-found unless
  // the caller explicitly opts in with include_archived.
  if (!params.include_archived && isArchived(node)) {
    throw new Error(
      `Node not found: ${nodeId} (node is archived; pass include_archived: true to retrieve it)`
    );
  }

  let children:
    | Array<{
        id: string;
        type: string;
        title: string | null;
        sort_order: number;
        category?: string | null;
        /** `▶ running (<agent>)` — present only on thread children with a live run. */
        active_run?: string;
      }>
    | undefined;
  /**
   * Threads scoped to this node when it is a project. Threads are not placed
   * in the folder tree, so they never appear in `children`; a project lists
   * them in their own group, in their manual (sidebar) order.
   */
  let threads:
    | Array<{
        id: string;
        type: 'thread';
        title: string | null;
        project_id: string;
        active_run?: string;
      }>
    | undefined;

  if (params.include_children) {
    // Children are the nodes placed directly under this node (nodes.container_id).
    const childRes = await pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS}
         FROM nodes n
         ${NODE_JOINS}
        WHERE n.container_id = $1
        ORDER BY n.sort_order ASC, n.created_at ASC`,
      [nodeId]
    );
    children = filterArchived(childRes.rows, { include_archived: params.include_archived }).map(
      (r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        sort_order: r.sort_order,
        // Annotations only where they apply \u2014 a container's category
        // \u2014 so the child list reads like the tree.
        ...(r.category !== null ? { category: r.category } : {}),
      })
    );
    if (node.type === 'container' && node.category === 'project') {
      const rows = await Threads.listByProject(node.id, {
        includeArchived: params.include_archived === true,
      });
      threads = rows.map((t) => ({
        id: t.id,
        type: 'thread',
        title: t.title,
        project_id: node.id,
      }));
    }
  }

  // Batched active-run lookup for every thread in view (this node + any thread
  // children) in ONE call, so a thread with a live agent run is flagged without
  // a per-thread query. Liveness comes from the tracker, so a stale/dead run is
  // never shown as running.
  const threadIdsInView = [
    ...(node.type === 'thread' ? [node.id] : []),
    ...(threads ?? []).map((t) => t.id),
  ];
  const activityByThread = await getThreadActivity(threadIdsInView);
  if (threads) {
    for (const thread of threads) {
      const marker = activeRunMarker(activityByThread.get(thread.id));
      if (marker) thread.active_run = marker;
    }
  }

  const title = node.title ?? '(untitled)';
  const childSummary = children !== undefined ? ` \u2014 ${children.length} child node(s)` : '';
  const threadSummary = threads !== undefined ? `, ${threads.length} thread(s)` : '';
  const archivedFlag = node.archived ? ' [archived]' : '';
  // Compact annotation hint in the human-readable line: category for
  // containers, the project scope for threads.
  const metaBits: string[] = [];
  if (node.category) metaBits.push(node.category);
  if (node.type === 'thread') {
    metaBits.push(node.project_id ? `project ${node.project_id}` : 'flat');
  }
  const metaFlag = metaBits.length > 0 ? ` [${metaBits.join(' ')}]` : '';

  const nodeMarker = node.type === 'thread' ? activeRunMarker(activityByThread.get(node.id)) : '';
  const runFlag = nodeMarker ? ` \u00b7 ${nodeMarker}` : '';

  const output = `${node.type}: ${title}${metaFlag}${archivedFlag} (${node.id})${runFlag}${childSummary}${threadSummary}`;

  return {
    output,
    rawContent: {
      id: node.id,
      type: node.type,
      title: node.title,
      // A thread is scoped to a project (or flat), never placed in a container;
      // every other kind reports its container placement.
      ...(node.type === 'thread'
        ? { project_id: node.project_id }
        : { container_id: node.container_id }),
      sort_order: node.sort_order,
      // Machine annotations (null unless the kind carries them).
      category: node.category,
      // Project facets — populated only on project containers; preserves
      // get_project's read surface (folder_path/github_url/description).
      folder_path: node.folder_path,
      github_url: node.github_url,
      description: node.description,
      // Optimistic-concurrency token. Always null now — the kinds that carried
      // one (Sketch, Board posts) are removed — but kept for output stability.
      revision: node.revision,
      archived: node.archived,
      archived_at: node.archived_at,
      created_at: node.created_at,
      updated_at: node.updated_at,
      ...(children !== undefined ? { children } : {}),
      ...(threads !== undefined ? { threads } : {}),
    },
  };
}
