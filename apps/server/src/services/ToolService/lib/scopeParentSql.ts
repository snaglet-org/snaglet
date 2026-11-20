/**
 * scopeParentSql — the ONE definition of "which container scopes this node",
 * plus the recursive climb every ancestor walk is built from.
 *
 * Threads are not in the folder tree: a thread's `container_id` is always
 * NULL and its scope is `nodes.project_id` (a project container, or NULL for
 * a flat thread). Every other node is scoped by its parent folder,
 * `nodes.container_id`. Any query that climbs from a node toward the
 * workspace root has to make that same thread/non-thread choice at the seed,
 * so the expression lives here and the call sites compose it instead of
 * re-spelling it.
 *
 * Users:
 *   - findProjectAncestor (nearest / full project lineage of a node)
 *   - threadCoordinates.loadLocationBreadcrumb (the Location crumbs)
 *
 * Each seeds the climb differently — see the comment at each call site. The
 * climb step itself (follow `container_id` upward, bounded) is identical and
 * shared via `scopeChainCte`.
 */

/**
 * Hard bound on tree walks (ancestor climbs and subtree descents). Real
 * chains are 2–4 hops; the cap only defends against pathological data such as
 * a `container_id` cycle.
 */
export const MAX_TREE_DEPTH = 32;

/**
 * SQL expression for the id of the container that scopes the `nodes` row
 * aliased `alias`: its project for a thread, its parent folder otherwise.
 * NULL for a flat thread or a root-level node.
 */
export function scopeParentSql(alias: string): string {
  return `CASE WHEN ${alias}.type = 'thread' THEN ${alias}.project_id ELSE ${alias}.container_id END`;
}

export interface ScopeChainCteOptions {
  /** Name of the recursive CTE. Defaults to `chain`. */
  name?: string;
  /**
   * The depth-0 rows. Must select, in this order:
   * `id, container_id, archived, depth` followed by any `carry` columns.
   * `container_id` is where the climb continues from; `id` is the row that
   * is reported. Build it with `scopeParentSql` where the seed depends on
   * the node kind.
   */
  seed: string;
  /**
   * Extra columns the seed selects after `depth`, carried unchanged through
   * every step (e.g. the originating node id when seeding a batch).
   */
  carry?: readonly string[];
}

/**
 * Body of a `WITH RECURSIVE` clause: `<name> AS (<seed> UNION ALL <climb>)`.
 * The climb joins each row's `container_id` to its parent node and stops at
 * `MAX_TREE_DEPTH`. Callers prepend `WITH RECURSIVE` (and any sibling CTEs).
 */
export function scopeChainCte({ name = 'chain', seed, carry = [] }: ScopeChainCteOptions): string {
  const carried = carry.map((column) => `, ${name}.${column}`).join('');
  return `
    ${name} AS (
      ${seed}
      UNION ALL
      SELECT parent.id, parent.container_id, parent.archived, ${name}.depth + 1${carried}
        FROM ${name}
        JOIN public.nodes parent ON parent.id = ${name}.container_id
       WHERE ${name}.depth < ${MAX_TREE_DEPTH}
    )`;
}
