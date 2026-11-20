/**
 * workspace_project_tree — auto-resolve the project the agent is in
 * (via its current thread) and render that subtree.
 *
 * Resolution:
 *   1. ctx.threadId → the thread's project container (`nodes.project_id`),
 *      via findProjectAncestor
 *   2. Delegate to workspace_tree's renderer with that container_id set
 *
 * A flat thread (no project) gets a short message instead of a dump of the
 * whole library.
 */

import type { ToolHandler } from '@server/services/ToolService/types';
import { findProjectAncestor } from '@server/services/ToolService/lib/findProjectAncestor';
import workspaceTree from './workspaceTree';

const tool: ToolHandler = async (input, settings, context) => {
  const threadId = context?.threadId;
  if (!threadId) {
    return 'workspace_project_tree requires a thread context to resolve the current project. Call workspace_tree with an explicit container_id if you have one.';
  }

  const ancestor = await findProjectAncestor(threadId);
  if (!ancestor) {
    return 'This thread is not in a project. Use `workspace_tree` to browse the full library, or navigate to a project thread.';
  }

  // Delegate to workspace_tree with the resolved container_id. Pass through
  // any optional `kinds` filter the agent supplied.
  const subtree = await workspaceTree(
    {
      container_id: ancestor.projectId,
      ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
    },
    settings,
    context
  );

  // A project IS its container, so the project id is the subtree root.
  const header = `📍 Project: ${ancestor.projectName} (container ${ancestor.projectId})\n`;
  const subtreeText = typeof subtree === 'string' ? subtree : subtree.output;
  return `${header}\n${subtreeText}`;
};

export default tool;
