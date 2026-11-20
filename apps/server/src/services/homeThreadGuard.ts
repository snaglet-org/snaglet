/**
 * homeThreadGuard — the home thread (the user's DM with an agent, see
 * `Threads.listHomeThreadIds`) is never deleted or archived. Its messages go
 * with Clear instead. Every full thread delete runs through
 * `withThreadExecutionPurge`, which calls this before deleting anything; the
 * agent delete is the one caller that opts out, because a DM is meaningless
 * once one of its two parties is gone.
 */

import type { NodeRunner } from '@snaglet/db/tables/nodes';
import { Threads } from '@snaglet/db/tables/threads';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';

/** What a refused home-thread delete says, to the UI and to agents alike. */
export const HOME_THREAD_DELETE_MESSAGE =
  "The home thread can't be deleted. Use Clear to remove its messages.";

/** What a refused home-thread archive says. */
export const HOME_THREAD_ARCHIVE_MESSAGE =
  "The home thread can't be archived. Use Clear to remove its messages.";

/** Refuse (403) when any of `threadIds` is a home thread; nothing has been changed yet. */
export async function assertNoHomeThreads(
  threadIds: readonly string[],
  runner?: NodeRunner,
  message: string = HOME_THREAD_DELETE_MESSAGE
): Promise<void> {
  const home = await Threads.listHomeThreadIds(threadIds, runner);
  if (home.length === 0) return;
  throw new AppError(message, ErrorCode.FORBIDDEN, HTTP_STATUS.FORBIDDEN, true, {
    threadIds: home,
  });
}
