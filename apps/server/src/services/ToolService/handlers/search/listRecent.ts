/**
 * workspace_list_recent — list most-recently-updated docs/containers.
 *
 * Joins docs / containers to nodes for the updated_at timestamp (canonical
 * source of truth). Supports time-window, kind, and container-scope filters.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { getDb } from '@snaglet/db';
import { resolveContainerByPath } from '@server/services/WorkspaceService/pathResolver';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { archivedWhereClause } from '@server/services/ToolService/tools/_shared/archiveGuard';

interface Input {
  limit?: number;
  kinds?: Array<'doc' | 'container'>;
  since?: string;
  container_id?: string;
  container_path?: string;
  include_archived?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const handler: ToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as unknown as Input;

  // Normalize args
  const limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(input.limit)))
      : DEFAULT_LIMIT;
  const kinds = Array.isArray(input.kinds) && input.kinds.length > 0 ? input.kinds : ['doc'];
  for (const k of kinds) {
    if (k !== 'doc' && k !== 'container') {
      throw new Error(`workspace_list_recent: invalid kind "${k}" (must be "doc" or "container")`);
    }
  }
  const includeDocs = kinds.includes('doc');
  const includeContainers = kinds.includes('container');

  let sinceIso: string | undefined;
  if (input.since !== undefined) {
    const d = new Date(input.since);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`workspace_list_recent: invalid \`since\`: ${input.since}`);
    }
    sinceIso = d.toISOString();
  }

  if (input.container_id && input.container_path) {
    throw new Error(
      'workspace_list_recent: pass either `container_id` or `container_path`, not both'
    );
  }
  let scopeContainerId: string | null | undefined;
  if (input.container_id) {
    scopeContainerId = input.container_id;
  } else if (input.container_path !== undefined) {
    const p = input.container_path.trim();
    if (p === '' || p === '/') {
      scopeContainerId = null;
    } else {
      const resolved = await resolveContainerByPath(p);
      if (!resolved) {
        throw new Error(`workspace_list_recent: container not found at path "${p}"`);
      }
      scopeContainerId = resolved;
    }
  }

  const pool = getDb();
  const params: unknown[] = [];
  const sinceClause = sinceIso ? `AND n.updated_at >= $${params.push(sinceIso)}` : '';
  // Archived nodes are excluded by default; opt in with include_archived.
  const archivedClause = archivedWhereClause({ include_archived: input.include_archived }, 'n');
  const scopeIsSet = scopeContainerId !== undefined;

  const queries: string[] = [];
  if (includeDocs) {
    let scopeClause = '';
    if (scopeIsSet) {
      if (scopeContainerId === null) {
        scopeClause = `AND n.container_id IS NULL`;
      } else {
        scopeClause = `AND n.container_id = $${params.push(scopeContainerId)}`;
      }
    }
    // Placement (container_id) is read from nodes, its single source of truth.
    queries.push(`
      SELECT 'doc'::text AS kind,
             d.id        AS id,
             d.title     AS title,
             n.container_id AS parent_id,
             n.updated_at AS updated_at,
             n.created_at AS created_at
        FROM docs d
        JOIN nodes n ON n.id = d.id
       WHERE 1=1 ${sinceClause} ${scopeClause} ${archivedClause}
    `);
  }
  if (includeContainers) {
    let scopeClause = '';
    if (scopeIsSet) {
      if (scopeContainerId === null) {
        scopeClause = `AND n.container_id IS NULL`;
      } else {
        scopeClause = `AND n.container_id = $${params.push(scopeContainerId)}`;
      }
    }
    // A container's parent is read from nodes.container_id, its single source of truth.
    queries.push(`
      SELECT 'container'::text AS kind,
             c.id        AS id,
             c.name      AS title,
             n.container_id AS parent_id,
             n.updated_at AS updated_at,
             n.created_at AS created_at
        FROM containers c
        JOIN nodes n ON n.id = c.id
       WHERE 1=1 ${sinceClause} ${scopeClause} ${archivedClause}
    `);
  }

  if (queries.length === 0) {
    // No kinds selected (shouldn't happen given defaults)
    const result = {
      success: true,
      items: [],
      message: 'workspace_list_recent: no kinds selected',
    };
    return { output: JSON.stringify(result, null, 2), rawContent: result };
  }

  const limitParamIdx = params.push(limit);
  const sql = `
    ${queries.join(' UNION ALL ')}
    ORDER BY updated_at DESC
    LIMIT $${limitParamIdx}
  `;

  const res = await pool.query<{
    kind: 'doc' | 'container';
    id: string;
    title: string;
    parent_id: string | null;
    updated_at: string | Date;
    created_at: string | Date;
  }>(sql, params);

  const items = res.rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    title: r.title,
    parent_id: r.parent_id,
    updated_at: r.updated_at,
    created_at: r.created_at,
    link: linkForm(r.kind === 'doc' ? 'page' : 'container', r.id, r.title),
  }));

  const result = {
    success: true,
    count: items.length,
    limit,
    kinds,
    since: sinceIso,
    container_id: scopeIsSet ? scopeContainerId : undefined,
    items,
    message: `workspace_list_recent: ${items.length} item(s)`,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
