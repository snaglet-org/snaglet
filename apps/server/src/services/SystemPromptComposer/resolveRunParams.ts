/**
 * resolveRunParams — collect the per-run substitution values that the
 * doc-driven block builders (slot 6 Operating context, slot 8 Run mode)
 * read off `SystemPromptContext.runParams`.
 *
 * Today's surface:
 *   - project_name          — present iff the thread is scoped to a project
 *   - project_folder_path   — when the project has a folder path configured
 *   - project_gitrepo       — when the project has a github URL configured
 *   - parent_project_name   — when the thread's project is nested in another
 *   - host_path             — resolved agent working directory (see resolveAgentCwd)
 *   - host_path_source      — where that folder comes from: thread | project | home
 *   - thread_path           — the project lineage, or "workspace (no project)"
 *
 * Failures are logged and degrade to "no project info" rather than
 * throwing — a transient DB hiccup should not kill an agent's turn.
 */

import { findProjectAncestorChain } from '../ToolService/lib/findProjectAncestor';
import { resolveAgentCwdWithSource } from '../ToolService/lib/resolveAgentCwd';
import { formatLocationPath, loadThreadCoordinates } from '../ToolService/lib/threadCoordinates';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';

export interface ResolveRunParamsInput {
  threadId?: string;
}

export async function resolveRunParams(
  input: ResolveRunParamsInput
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};

  // Always resolve host_path — even without a threadId the env/default fallback applies
  const cwd = await resolveAgentCwdWithSource(input.threadId);
  params.host_path = cwd.path;
  params.host_path_source = cwd.source;

  if (!input.threadId) return params;

  try {
    // Nearest project first; the next entry (if any) is the project it nests in.
    const [project, parent] = await findProjectAncestorChain(input.threadId);
    if (project) {
      // A project IS its container — folder/github come straight off the
      // ancestor (the containers row), no second lookup needed.
      params.project_name = project.projectName;
      if (project.folderPath) params.project_folder_path = project.folderPath;
      if (project.githubUrl) params.project_gitrepo = project.githubUrl;
      if (parent) params.parent_project_name = parent.projectName;
    }
  } catch (err) {
    logger.warn('[SystemPromptComposer] resolveRunParams failed', {
      threadId: input.threadId,
      err: getErrorMessage(err),
    });
  }

  // Ambient thread coordinates — injected into the Operating-context block
  // so agents don't burn an `orient` round-trip at the start of
  // every run just to learn where they are. Within a thread these are
  // stable across turns, so per-thread prompt caching is preserved.
  try {
    const coords = await loadThreadCoordinates(input.threadId);
    if (coords.threadTitle) params.thread_title = coords.threadTitle;
    // A DM / home thread has one agent and no routing: never mention a mode.
    if (coords.dispatchMode && !coords.isDm) params.thread_routing = coords.dispatchMode;
    if (coords.isDm) params.thread_is_dm = 'true';
    // A flat thread still has a location ("workspace (no project)"); only a
    // missing thread row leaves the slot empty.
    if (coords.threadFound) params.thread_path = formatLocationPath(coords.breadcrumb);
    if (coords.participants.length > 0) {
      params.thread_participants = coords.participants
        .map((p) => (p.role ? `${p.name} (${p.role})` : p.name))
        .join(', ');
    }
  } catch (err) {
    logger.warn('[SystemPromptComposer] thread coordinate resolution failed', {
      threadId: input.threadId,
      err: getErrorMessage(err),
    });
  }

  return params;
}
