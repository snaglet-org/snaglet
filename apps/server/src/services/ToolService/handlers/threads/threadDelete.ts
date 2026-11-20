import { Threads } from '@snaglet/db/tables/threads';
import { Nodes } from '@snaglet/db/tables/nodes';
import { emitTreeNodeDeleted } from '@server/realtime/surfaces/tree';
import { emitThreadDeleted } from '@server/realtime/surfaces/threads';
import { getErrorMessage } from '@snaglet/shared/utils/errors';
import { withThreadExecutionPurge } from '@server/services/ThreadExecutionPurgeService';
import { assertNoHomeThreads } from '@server/services/homeThreadGuard';
import { assertNotDmThread } from '@server/services/ToolService/lib/targetThread';
import type { ThreadDeleteInputType } from './threadDeleteInput';

/**
 * thread_delete — permanently delete a thread and detach it from the workspace tree.
 *
 * Mirrors the DELETE /threads/:id HTTP handler: resolve the thread, delete the
 * node (cascades messages/participants via FK), then emit the tree + thread
 * delete sockets so every surface drops it live.
 *
 * Destructive and irreversible — guarded by `confirm: true`. The optional
 * `project_id` is a scope assertion: if provided, the thread's own project
 * scope must be that project or the call is rejected (prevents cross-project
 * deletes). A flat thread matches no project.
 */
async function threadDelete(args: ThreadDeleteInputType): Promise<{
  success: boolean;
  thread_id: string;
  title: string | null;
  message: string;
}> {
  const threadId = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
  if (!threadId) {
    throw new Error('thread_id is required');
  }

  if (args.confirm !== true) {
    throw new Error(
      'thread_delete is destructive and irreversible. Pass confirm: true to proceed.'
    );
  }

  // --- Preflight: validate everything before any mutation. ---
  const thread = await Threads.findById(threadId);
  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }
  // The home thread first, so an agent reads the same refusal the user does.
  await assertNoHomeThreads([threadId]);
  await assertNotDmThread('thread op:delete', threadId, undefined, { allowOwnThread: false });

  // Scope guard: if a project_id is given, the thread must be scoped to it.
  if (typeof args.project_id === 'string' && args.project_id.trim().length > 0) {
    const expectedProjectId = args.project_id.trim();
    if (thread.projectId !== expectedProjectId) {
      throw new Error(
        `Scope mismatch: thread ${threadId} belongs to project ` +
          `${thread.projectId ?? '(none — flat)'}, not ${expectedProjectId}. Refusing to delete.`
      );
    }
  }

  // --- Mutate. ---
  try {
    await withThreadExecutionPurge([threadId], ({ tx }) =>
      Nodes.deleteOfType(threadId, 'thread', tx)
    );
  } catch (error) {
    throw new Error(`Failed to delete thread: ${getErrorMessage(error)}`);
  }

  emitTreeNodeDeleted(threadId, 'thread');
  emitThreadDeleted(threadId);

  return {
    success: true,
    thread_id: threadId,
    title: thread.title ?? null,
    message: `Deleted thread ${threadId}.`,
  };
}

export default threadDelete;
