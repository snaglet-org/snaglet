/**
 * projectScope — helpers for the find_conversation tool's project-priority
 * behavior.
 *
 * The tool searches thread summaries workspace-wide, then PRIORITIZES (or
 * optionally restricts to) the caller's project. To do that we need two
 * primitives:
 *
 *   - resolveCallerProject: which project (if any) is the caller's thread in.
 *   - mapThreadsToProjects: for a batch of result threads, which project does
 *     each belong to — so we can boost the ones that match.
 *
 * Both go through findProjectAncestor so they agree on what "the project" is:
 * a thread's own project (`nodes.project_id`) when that project is active,
 * otherwise the nearest active project enclosing it (an archived sub-project
 * resolves to the project around it). The batch form is one query for the
 * whole candidate set.
 */

import {
  findProjectAncestor,
  findProjectAncestors,
} from '@server/services/ToolService/lib/findProjectAncestor';

/**
 * Resolve the project the caller's thread is scoped to.
 * Returns null when the caller is not inside any project (flat thread,
 * or no thread id available).
 */
export async function resolveCallerProject(
  threadId: string | null | undefined
): Promise<{ projectId: string; projectName: string } | null> {
  if (!threadId) return null;
  const ancestor = await findProjectAncestor(threadId);
  if (!ancestor) return null;
  return { projectId: ancestor.projectId, projectName: ancestor.projectName };
}

/**
 * For each thread id, the id of its nearest active project. Returns a
 * Map<threadId, projectId>; flat threads and threads with no active project
 * anywhere above them are simply absent from the map.
 */
export async function mapThreadsToProjects(
  threadIds: readonly string[]
): Promise<Map<string, string>> {
  const ancestors = await findProjectAncestors(threadIds);
  const result = new Map<string, string>();
  for (const [threadId, ancestor] of ancestors) result.set(threadId, ancestor.projectId);
  return result;
}
