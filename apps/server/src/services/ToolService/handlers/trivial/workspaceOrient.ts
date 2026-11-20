/**
 * workspace_orient — the agent's cold-start "where am I" tool.
 *
 * Returns one compact orientation block composed of:
 *   - Project name + description (the thread's project, via `nodes.project_id`)
 *   - Location (the project lineage, or "workspace (no project)" when flat)
 *   - The full project subtree (delegated to workspace_project_tree)
 *   - Most-recently-touched nodes in scope (last N by updated_at)
 *   - Thread participants (agents + human)
 *
 * Designed so an agent can call this ONCE on wake-up instead of stringing
 * together workspace_tree + thread metadata + activity queries by hand.
 *
 * Resolution logic mirrors workspace_project_tree — findProjectAncestor reads
 * the thread's project and walks up from there for nested projects. A flat
 * thread gets a slimmer block (location + thread participants only).
 */

import type { ToolHandler } from '@server/services/ToolService/types';
import { getDb } from '@snaglet/db';
import { visibleThreadRowSql } from '@snaglet/db/tables/threads/visibility';
import { buildProjectLineageString } from '@server/services/ToolService/lib/buildProjectLineageString';
import { findProjectAncestor } from '@server/services/ToolService/lib/findProjectAncestor';
import {
  formatLocationPath,
  loadLocationBreadcrumb,
  loadParticipants,
} from '@server/services/ToolService/lib/threadCoordinates';
import { MAX_TREE_DEPTH } from '@server/services/ToolService/lib/scopeParentSql';
import workspaceTree from './workspaceTree';
import { formatRelativeTime } from '@snaglet/shared/utils';

interface RecentRow {
  id: string;
  type: string;
  label: string;
  updated_at: string;
}

/**
 * Recently touched containers, docs and threads in a project. The scope is
 * the project container's subtree plus every thread scoped to a container in
 * it — threads are not in the folder tree, so they are picked up through
 * `project_id` (which also covers nested projects' threads). Subagent helper
 * threads carry their parent's project but are never listed.
 *
 * Exported for direct testing; the tool handler below is its only runtime
 * caller.
 */
export async function loadRecentInScope(
  scopeContainerId: string,
  limit: number
): Promise<RecentRow[]> {
  const { rows } = await getDb().query<RecentRow>(
    `
    WITH RECURSIVE scope AS (
      SELECT id, 0 AS depth FROM public.nodes WHERE id = $1
      UNION ALL
      SELECT n.id, s.depth + 1 FROM public.nodes n JOIN scope s ON n.container_id = s.id
       WHERE n.archived = false AND s.depth < ${MAX_TREE_DEPTH}
    )
    SELECT n.id, n.type::text AS type, n.updated_at,
           COALESCE(c.name, d.title, t.title, '(untitled)') AS label
      FROM public.nodes n
      LEFT JOIN public.containers c ON c.id = n.id
      LEFT JOIN public.docs       d ON d.id = n.id
      LEFT JOIN public.threads    t ON t.id = n.id
     WHERE (n.id IN (SELECT id FROM scope) OR n.project_id IN (SELECT id FROM scope))
       AND n.archived = false
       AND n.type IN ('container', 'doc', 'thread')
       -- Subagent helper threads stay out (a LEFT JOIN miss passes too).
       AND ${visibleThreadRowSql('t')}
     ORDER BY n.updated_at DESC
     LIMIT $2
    `,
    [scopeContainerId, limit]
  );
  return rows;
}

const TYPE_GLYPH: Record<string, string> = {
  container: '📂',
  doc: '📄',
  thread: '💬',
};

const tool: ToolHandler = async (input, settings, context) => {
  const threadId = context?.threadId;
  if (!threadId) {
    return 'workspace_orient requires a thread context. Call from within an agent run.';
  }

  const rawLimit = typeof input.recent_limit === 'number' ? input.recent_limit : 5;
  const recentLimit = Math.max(1, Math.min(20, Math.floor(rawLimit)));

  const [ancestor, projectLineage, location, participants] = await Promise.all([
    findProjectAncestor(threadId),
    buildProjectLineageString(threadId),
    loadLocationBreadcrumb(threadId),
    loadParticipants(threadId),
  ]);

  const lines: string[] = ['# Workspace Orientation', ''];

  // Project section, built by the shared buildProjectLineageString so orient
  // and the persisted injection can never drift. Null when no enclosing
  // project carries context (e.g. a flat thread, or a project with no
  // description yet), and then both surfaces omit the section.
  if (projectLineage) {
    lines.push(projectLineage);
    lines.push('');
  }

  // Location: the project lineage (root → … → this thread's project), or the
  // flat-thread label.
  lines.push(`**Location:** ${formatLocationPath(location)}`);
  lines.push('');

  // Participants
  if (participants.length > 0) {
    lines.push('**Participants:**');
    for (const p of participants) {
      lines.push(`- ${p.name}${p.role ? ` (${p.role})` : ''}`);
    }
  }
  lines.push('');

  // Recent activity + project tree only when in a project
  if (ancestor) {
    const recent = await loadRecentInScope(ancestor.projectId, recentLimit);
    if (recent.length > 0) {
      lines.push(`**Recently touched (top ${recent.length} in scope):**`);
      for (const r of recent) {
        const glyph = TYPE_GLYPH[r.type] ?? '·';
        lines.push(`- ${glyph} ${r.label} — ${formatRelativeTime(r.updated_at)}`);
      }
      lines.push('');
    }

    lines.push('**Project tree:**');
    lines.push('');
    const subtree = await workspaceTree({ container_id: ancestor.projectId }, settings, context);
    const subtreeText = typeof subtree === 'string' ? subtree : subtree.output;
    lines.push(subtreeText);
  } else {
    lines.push(
      '_This thread is not in a project — no project tree section. Use `workspace_tree` to browse the full library._'
    );
  }

  return lines.join('\n');
};

export default tool;
