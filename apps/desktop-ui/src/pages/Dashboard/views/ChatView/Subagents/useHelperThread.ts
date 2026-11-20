import { useEffect, useState } from 'react';
import type { SubagentSummary } from '@snaglet/shared/types';
import { FetchError, threadsApi } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useThreadSubagents } from './useThreadSubagents';

export interface HelperThreadInfo {
  /** The thread whose agent started this helper. */
  parentThreadId: string;
  /** The helper thread's own title ("Patty › Scout" unless renamed). */
  title: string | null;
  /** The helper's live row; null while loading and once it is gone. */
  subagent: SubagentSummary | null;
  /**
   * The helper was removed (its orchestrator was done with it): its thread
   * and messages are deleted, so the open view has nothing left to show.
   */
  removed: boolean;
}

/**
 * Whether `threadId` is a subagent helper's hidden thread and, if so, which
 * helper. Null for an ordinary thread (or until the thread row loads). The
 * helper's name and model come from its parent's subagent list, matched by
 * thread id; that list also reports the removal (`subagent:changed` with
 * `subagent: null`), as does the workspace `thread.deleted` event.
 *
 * `markedParentThreadId` is the pane selection's helper marker. A removed
 * helper's thread is deleted, so a pane restored after that gets a 404 for the
 * row, and only the marker still says the thread was a helper's.
 */
export function useHelperThread(
  threadId: string,
  markedParentThreadId: string | null = null
): HelperThreadInfo | null {
  const [row, setRow] = useState<{
    threadId: string;
    parentThreadId: string | null;
    title: string | null;
  } | null>(null);
  const [deletedId, setDeletedId] = useState<string | null>(null);
  const [missingId, setMissingId] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    threadsApi
      .get(threadId)
      .then((thread) => {
        if (!canceled) {
          setRow({ threadId, parentThreadId: thread.parentThreadId ?? null, title: thread.title });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof FetchError && err.status === 404) {
          if (!canceled) setMissingId(threadId);
          return;
        }
        // The history load reports a missing thread; this only decorates.
        console.error('useHelperThread: failed to load thread', err);
      });
    return () => {
      canceled = true;
    };
  }, [threadId]);

  useEffect(
    () =>
      onLibraryEvent((event) => {
        if (event.type === 'deleted' && event.kind === 'thread' && event.id === threadId) {
          setDeletedId(threadId);
        }
      }),
    [threadId]
  );

  const current = row?.threadId === threadId ? row : null;
  const missing = missingId === threadId;
  const parentThreadId = current?.parentThreadId ?? (missing ? markedParentThreadId : null);
  const { subagents, loaded } = useThreadSubagents(parentThreadId ?? '');
  if (!parentThreadId) return null;
  const subagent = subagents.find((s) => s.threadId === threadId) ?? null;
  return {
    parentThreadId,
    title: current?.title ?? null,
    subagent,
    removed: missing || deletedId === threadId || (loaded && !subagent),
  };
}
