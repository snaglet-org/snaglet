/**
 * memoryRecallScope — which projects' memories auto-recall may surface for a
 * thread.
 *
 * Memories carry no project column; a memory's project is derived in SQL from
 * its `source_thread_id` (see `Memories.hybridSearch` `projectScope`). This
 * module computes the ALLOWED project set for the recalling thread:
 *
 *   - flat thread (no enclosing project)       → `null` = unscoped (today's
 *     workspace-wide behavior),
 *   - project thread → the project FAMILY: the thread's nearest project, every
 *     enclosing ancestor project, and every project nested beneath the nearest
 *     one (nested projects share recall in both directions),
 *   - plus any other active project the recall query NAMES (case-insensitive,
 *     whole word, names ≥ 4 chars so short names can't match by accident).
 *
 * Agent-global memories (no source thread, or a flat source thread) always
 * pass the SQL filter regardless of this set. Filter-only: no ranking change.
 */

import { Projects } from '@snaglet/db/tables/projects';
import { escapeRegex } from '@snaglet/shared/utils';
import { findProjectAncestorChain } from '@server/services/ToolService/lib/findProjectAncestor';
import { findDescendantProjects } from '@server/services/ToolService/lib/findDescendantProjects';

/** Project names shorter than this are never matched from query text. */
const MEMORY_RECALL_NAMED_PROJECT_MIN_CHARS = 4;

export interface MemoryRecallProjectScope {
  allowedProjectIds: string[];
}

/**
 * Ids of active projects whose name appears in `query` as a whole word
 * (word chars and `-` count as part of a word, so "site" does not match inside
 * "example-site").
 */
export function matchNamedProjects(
  query: string,
  projects: ReadonlyArray<{ id: string; name: string; archived?: boolean }>
): string[] {
  const ids: string[] = [];
  for (const project of projects) {
    if (project.archived) continue;
    const name = project.name?.trim();
    if (!name || name.length < MEMORY_RECALL_NAMED_PROJECT_MIN_CHARS) continue;
    const pattern = new RegExp(`(?<![\\w-])${escapeRegex(name)}(?![\\w-])`, 'i');
    if (pattern.test(query)) ids.push(project.id);
  }
  return ids;
}

/**
 * Resolve the auto-recall project scope for `threadId`. Returns `null` for a
 * flat thread (unscoped). Throws on DB failure — the caller
 * (buildMemoryRecallSegment) catches and injects nothing, i.e. fails CLOSED
 * rather than falling back to workspace-wide recall.
 */
export async function resolveMemoryRecallProjectScope(
  threadId: string,
  query: string
): Promise<MemoryRecallProjectScope | null> {
  const chain = await findProjectAncestorChain(threadId);
  if (chain.length === 0) return null;

  const nearest = chain[0].projectId;
  const [descendants, allProjects] = await Promise.all([
    findDescendantProjects(nearest),
    Projects.listAll(),
  ]);

  const allowed = new Set<string>();
  for (const ancestor of chain) allowed.add(ancestor.projectId);
  for (const id of descendants) allowed.add(id);
  for (const id of matchNamedProjects(query, allProjects)) allowed.add(id);
  return { allowedProjectIds: [...allowed] };
}
