/**
 * threadCoordinates — resolve a thread's position in the workspace (its
 * project lineage) plus its participants and routing mode.
 *
 * Shared by the `workspace_orient` tool (on-demand, with recent-nodes
 * extras) and `resolveRunParams` (ambient injection into the system
 * prompt's Operating-context block). The injection exists so agents do
 * not need a tool round-trip just to learn where they are; orient
 * remains the fallback for stale/missing coordinates and for the
 * recently-touched-nodes listing.
 */

import { getDb } from '@snaglet/db';
import { scopeChainCte, scopeParentSql } from './scopeParentSql';

export interface LocationCrumb {
  id: string;
  name: string;
}

export interface ParticipantRow {
  id: string;
  name: string;
  role: string | null;
}

export interface ThreadCoordinates {
  /** False when no thread row exists for the id. */
  threadFound: boolean;
  /** Thread title, or null when untitled or the thread row is missing. */
  threadTitle: string | null;
  /** Routing mode (`broadcast` / `mention` style dispatch_mode value). */
  dispatchMode: string | null;
  /** True for a DM / home thread (`threads.kind = 'dm'`): routing never applies. */
  isDm: boolean;
  /** The thread's project container id, or null for a flat thread. */
  projectId: string | null;
  /**
   * Project lineage from the workspace root down to the thread's own project
   * (outermost first). Empty for a flat thread.
   */
  breadcrumb: LocationCrumb[];
  /** Agent participants (the human is always implicitly present). */
  participants: ParticipantRow[];
}

/** The location label for a thread that is not in any project. */
const FLAT_THREAD_LOCATION = 'workspace (no project)';

/** Render a location breadcrumb as a path, or the flat-thread label when empty. */
export function formatLocationPath(breadcrumb: LocationCrumb[]): string {
  return breadcrumb.length > 0 ? breadcrumb.map((c) => c.name).join(' / ') : FLAT_THREAD_LOCATION;
}

/**
 * Container chain from the workspace root down to the node's scope, outermost
 * first. For a thread the chain starts at (and includes) its project
 * container; for any other node it starts at the node's parent container.
 * Empty for a flat thread or a root-level node.
 *
 * This is the LITERAL lineage: every container on the way up is a crumb,
 * archived ones included, and it does not stop at project boundaries.
 * Project resolution (`findProjectAncestor`) is deliberately different — it
 * skips archived project containers and climbs to the next active one. So a
 * thread restored on its own under a still-archived project shows that
 * project in its Location while having no project section at all. That is
 * the intended reading of each surface (where the thread sits vs. which
 * project context applies), not a drift to reconcile.
 */
export async function loadLocationBreadcrumb(nodeId: string): Promise<LocationCrumb[]> {
  // Seed with the node's SCOPE PARENT (its project for a thread, its folder
  // otherwise), not the node itself: the breadcrumb is the lineage above the
  // node. findProjectAncestor seeds with the node itself instead, since there
  // the node may be the project.
  const chain = scopeChainCte({
    seed: `
      SELECT start.id, start.container_id, start.archived, 0 AS depth
        FROM public.nodes n
        JOIN public.nodes start ON start.id = ${scopeParentSql('n')}
       WHERE n.id = $1`,
  });
  const { rows } = await getDb().query<LocationCrumb>(
    `
    WITH RECURSIVE ${chain}
    SELECT chain.id, ctr.name
      FROM chain JOIN public.containers ctr ON ctr.id = chain.id
     ORDER BY chain.depth DESC
    `,
    [nodeId]
  );
  return rows;
}

/** Agent participants of a thread, ordered by name. */
export async function loadParticipants(threadId: string): Promise<ParticipantRow[]> {
  const { rows } = await getDb().query<ParticipantRow>(
    `
    SELECT a.id, a.name, a.role
      FROM public.thread_participants tp
      JOIN public.members m ON m.id = tp.member_id
      JOIN public.agents a ON a.id = m.agent_id
     WHERE tp.thread_id = $1
     ORDER BY a.name
    `,
    [threadId]
  );
  return rows;
}

/** One-shot coordinates fetch for prompt injection. */
export async function loadThreadCoordinates(threadId: string): Promise<ThreadCoordinates> {
  const [thread, breadcrumb, participants] = await Promise.all([
    getDb()
      .query<{
        title: string | null;
        dispatch_mode: string | null;
        kind: string | null;
        project_id: string | null;
      }>(
        `SELECT t.title, t.dispatch_mode, t.kind, n.project_id
           FROM public.threads t
           JOIN public.nodes n ON n.id = t.id
          WHERE t.id = $1`,
        [threadId]
      )
      .then((r) => r.rows[0] ?? null),
    loadLocationBreadcrumb(threadId),
    loadParticipants(threadId),
  ]);

  return {
    threadFound: thread !== null,
    threadTitle: thread?.title ?? null,
    dispatchMode: thread?.dispatch_mode ?? null,
    isDm: thread?.kind === 'dm',
    projectId: thread?.project_id ?? null,
    breadcrumb,
    participants,
  };
}
