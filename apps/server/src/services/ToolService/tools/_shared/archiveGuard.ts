/**
 * Shared archive-awareness helpers for workspace node tools.
 *
 * Workspace node tools share one archive policy:
 *   - READS exclude archived nodes by DEFAULT; opt back in with
 *     `include_archived: true`.
 *   - MUTATIONS reject archived-node targets by DEFAULT; override with
 *     `allow_archived: true` (or restore the node first).
 *   - EXEMPT by design: the archive-management tools themselves
 *     (search archived filter, restore_node, archive_node).
 *     They must see/operate on archived nodes; do not import this guard there.
 *
 * Both lanes (read filtering + mutation guards) import from here so the
 * archived check is authored exactly once. It is a documented _shared module
 * that throws a typed error the tool layer surfaces as a clean, self-teaching
 * message.
 */

/** Minimal shape every node row already exposes (see NODE_COLUMNS). */
export interface ArchivableNode {
  id: string;
  archived?: boolean | null;
  archived_at?: string | null;
}

/**
 * Thrown when a mutation targets an archived node without `allow_archived`.
 * The tool layer catches this and returns its message verbatim — it is
 * written to teach the agent the one-step fix.
 */
class ArchivedNodeError extends Error {
  readonly nodeId: string;
  constructor(nodeId: string) {
    super(
      `Node ${nodeId} is archived and cannot be mutated. ` +
        `Pass allow_archived: true to override, or restore it first with workspace_restore_node.`
    );
    this.name = 'ArchivedNodeError';
    this.nodeId = nodeId;
  }
}

/** True when a node row is archived (archived flag set, or archived_at present). */
export function isArchived(node: ArchivableNode | null | undefined): boolean {
  if (!node) return false;
  return node.archived === true || (node.archived_at != null && node.archived_at !== '');
}

/**
 * Mutation guard. Call immediately after fetching the target node, before
 * any write. No-op when the node is live or when the caller opted in via
 * `allow_archived: true`. Throws ArchivedNodeError otherwise.
 */
export function assertNotArchived(
  node: ArchivableNode | null | undefined,
  opts?: { allow_archived?: boolean }
): void {
  if (opts?.allow_archived) return;
  if (node && isArchived(node)) {
    throw new ArchivedNodeError(node.id);
  }
}

/**
 * Read filter. Drops archived nodes from a result set unless the caller
 * opted in via `include_archived: true`. Pure — returns a new array.
 */
export function filterArchived<T extends ArchivableNode>(
  nodes: T[],
  opts?: { include_archived?: boolean }
): T[] {
  if (opts?.include_archived) return nodes;
  return nodes.filter((n) => !isArchived(n));
}

/**
 * SQL fragment for read tools that filter at the query layer instead of
 * post-fetch. Append to a WHERE clause; pass `include_archived` to disable.
 * `alias` is the table alias holding the `archived` column (default 'n').
 * Returns '' when archived nodes should be included (no-op).
 */
export function archivedWhereClause(opts?: { include_archived?: boolean }, alias = 'n'): string {
  if (opts?.include_archived) return '';
  return `AND ${alias}.archived IS NOT TRUE`;
}
