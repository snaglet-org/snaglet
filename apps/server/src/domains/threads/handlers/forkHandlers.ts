import type { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendCreated } from '@server/utils/http';
import { AppError, ConflictError, asNonEmptyString } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS, THREAD_TITLE_MAX_LENGTH } from '@snaglet/shared/types';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { emitThreadCreate } from '@server/services/customHooks/threadCreateEvent';
import { emitTreeNodeCreated, snapshotFromThread } from '@server/realtime/surfaces/tree';
import { emitThreadCreated, snapshotFromThreadNode } from '@server/realtime/surfaces/threads';
import { redispatchPersistedMessage } from '@server/services/SocketService/dispatch/dispatchToThread';
import { forkHomeThread } from '../forkThread';

/**
 * POST /threads/:id/fork — fork a home thread / user↔agent DM into a real
 * workspace thread (see forkThread.ts). Body: { title, projectId? }.
 *
 * On success emits the same realtime trio a normal thread create does, so the
 * workspace tree, the threads surface and the thread-create hook all see the
 * new thread. The source home thread is left exactly as it was.
 *
 * Before copying anything, the source thread is reserved the same way Clear
 * reserves a thread before a purge (ActiveRunTracker.reserveThreadPurge): it
 * refuses with 409 while the agent has an active run or handoff, OR while a
 * Clear/delete already holds the thread, and holds that reservation across the
 * whole copy so a Clear cannot race in and strand rows mid-fork. The
 * reservation is always released in `finally`.
 *
 * A message that arrives during the fork (a reminder, automation or agent
 * send) is persisted to the source thread but cannot start a run while the
 * reservation holds — the fork leaves the source thread intact, so after it
 * releases we re-dispatch each such message once (the same self-healing path
 * the run reaper and the mid-run queue use), so none is silently dropped.
 */
export function registerForkRoutes(router: Router): void {
  router.post(
    '/:id/fork',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawTitle = asNonEmptyString(body.title);
      if (!rawTitle) {
        throw new AppError(
          'A title is required to fork a thread.',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      // Clamp to the thread-title cap: a prefilled or pasted title can run
      // long, and an unbounded title should not reach the node row. Cut by
      // code points, not UTF-16 units, so the cap can't slice an emoji (or
      // other astral character) in half and leave a lone surrogate.
      const title = Array.from(rawTitle).slice(0, THREAD_TITLE_MAX_LENGTH).join('');
      // Omitted and null both mean a flat workspace thread. An unknown or
      // non-project id is validated by Threads.create inside the fork's
      // transaction, so it rolls back cleanly.
      const projectIdRaw =
        'projectId' in body ? body.projectId : 'project_id' in body ? body.project_id : null;
      const projectId =
        projectIdRaw === null || projectIdRaw === undefined
          ? null
          : typeof projectIdRaw === 'string' && projectIdRaw.trim().length > 0
            ? projectIdRaw.trim()
            : (() => {
                throw new AppError(
                  'projectId must be a project container id, or null for a flat thread.',
                  ErrorCode.VALIDATION_ERROR,
                  HTTP_STATUS.BAD_REQUEST
                );
              })();

      // Reserve the source while idle. A false return means an active run /
      // handoff or a concurrent Clear/delete owns it: a plain 409, never a
      // half-copied fork that loses the reply in flight.
      const sourceThreadId = req.params.id;
      if (!activeRunTracker.reserveThreadPurge(sourceThreadId, 'fork')) {
        throw new ConflictError(
          'This thread is busy (the agent is replying, or it is being cleared). Wait for it to finish, then fork.'
        );
      }
      let thread;
      try {
        ({ thread } = await forkHomeThread({ sourceThreadId, title, projectId }));
      } finally {
        // Drain before releasing, then re-dispatch each deferred message once so
        // a reminder / automation / agent send that landed on the source during
        // the fork is answered rather than left persisted-but-silent.
        const deferred = activeRunTracker.takeDeferredPurgeMessages(sourceThreadId);
        activeRunTracker.releaseThreadPurge(sourceThreadId);
        for (const messageId of deferred) {
          void redispatchPersistedMessage({
            threadId: sourceThreadId,
            threadName: '',
            messageId,
            undeliveredCount: deferred.length,
            reason: 'message arrived while thread was being forked',
          });
        }
      }

      emitTreeNodeCreated(snapshotFromThread(thread));
      emitThreadCreated(snapshotFromThreadNode(thread));
      emitThreadCreate(thread.id);
      sendCreated(res, thread);
    })
  );
}
