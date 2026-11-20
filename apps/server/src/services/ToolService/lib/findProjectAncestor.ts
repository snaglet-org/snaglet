/**
 * findProjectAncestor: the "what project is this node in" primitive. A project
 * is a container with `category='project'`; its id and row are the project.
 * The walk seeds with the node itself at depth 0 (so a project resolves to
 * itself) and climbs from its scope parent (`scopeParentSql`: a thread's
 * `project_id`, any other node's `container_id`), bounded by MAX_TREE_DEPTH.
 * Archived projects are skipped, so a node in an archived sub-project resolves
 * to the active project around it. Returns null when there is none (flat
 * threads, root-level containers); there is no root fallback.
 */

import { getDb } from '@snaglet/db';
import { scopeChainCte, scopeParentSql } from './scopeParentSql';

export interface ProjectAncestor {
  /** The project identity — the project container's id. */
  projectId: string;
  /** The project container's name. */
  projectName: string;
  projectDescription: string | null;
  /** Absolute path to the project's local files on disk, if set. */
  folderPath: string | null;
  /** The project's git repository URL, if set. */
  githubUrl: string | null;
}

/** A chain row joined back to the node the climb started from. */
type ProjectAncestorRow = ProjectAncestor & { nodeId: string };

/**
 * Recursive chain of a node's scope ancestors, nearest first, for every node
 * matched by `where` (a predicate over the `nodes` alias `n`). Row 0 is the
 * node itself; each row carries `origin_id` (the seed node) and the
 * container's archived flag so the select below can skip archived levels.
 */
function projectChainCte(where: string): string {
  return `WITH RECURSIVE ${scopeChainCte({
    seed: `
      SELECT n.id, ${scopeParentSql('n')} AS container_id, n.archived, 0 AS depth, n.id AS origin_id
        FROM public.nodes n
       WHERE ${where}`,
    carry: ['origin_id'],
  })}`;
}

const PROJECT_CHAIN_COLUMNS = `
           chain.origin_id AS "nodeId",
           chain.id        AS "projectId",
           c.name          AS "projectName",
           c.description   AS "projectDescription",
           c.folder_path   AS "folderPath",
           c.github_url    AS "githubUrl"
      FROM chain
      JOIN public.containers c ON c.id = chain.id
     WHERE c.category = 'project'
       AND chain.archived = false`;

const PROJECT_CHAIN_SELECT = `
    SELECT ${PROJECT_CHAIN_COLUMNS}
     ORDER BY chain.depth ASC
`;

function stripNodeId({ nodeId: _nodeId, ...ancestor }: ProjectAncestorRow): ProjectAncestor {
  return ancestor;
}

export async function findProjectAncestor(nodeId: string): Promise<ProjectAncestor | null> {
  const { rows } = await getDb().query<ProjectAncestorRow>(
    `${projectChainCte('n.id = $1')}${PROJECT_CHAIN_SELECT} LIMIT 1`,
    [nodeId]
  );
  return rows[0] ? stripNodeId(rows[0]) : null;
}

/**
 * findProjectAncestors — findProjectAncestor for a batch of nodes in one
 * query. Returns a Map keyed by node id; nodes with no enclosing active
 * project are absent (mirrors the single form's null).
 */
export async function findProjectAncestors(
  nodeIds: readonly string[]
): Promise<Map<string, ProjectAncestor>> {
  const result = new Map<string, ProjectAncestor>();
  const ids = Array.from(new Set(nodeIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return result;

  const { rows } = await getDb().query<ProjectAncestorRow>(
    `${projectChainCte('n.id = ANY($1::text[])')}
    SELECT DISTINCT ON (chain.origin_id) ${PROJECT_CHAIN_COLUMNS}
     ORDER BY chain.origin_id, chain.depth ASC`,
    [ids]
  );
  for (const row of rows) result.set(row.nodeId, stripNodeId(row));
  return result;
}

/**
 * findProjectAncestorChain: like findProjectAncestor, but returns every
 * enclosing project, nearest first (reverse it for broad→specific reading),
 * because a subproject's context often only makes sense with its parents'.
 * Returns an empty array when there is none; duplicates are removed by
 * projectId.
 */
export async function findProjectAncestorChain(nodeId: string): Promise<ProjectAncestor[]> {
  const { rows } = await getDb().query<ProjectAncestorRow>(
    `${projectChainCte('n.id = $1')}${PROJECT_CHAIN_SELECT}`,
    [nodeId]
  );

  // Dedupe by projectId (defensive against pathological tree shapes), keeping
  // nearest occurrence (rows are already depth ASC).
  const seen = new Set<string>();
  const projects: ProjectAncestor[] = [];
  for (const row of rows) {
    if (seen.has(row.projectId)) continue;
    seen.add(row.projectId);
    projects.push(stripNodeId(row));
  }

  return projects;
}
