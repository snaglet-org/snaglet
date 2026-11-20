import { useEffect, useMemo } from 'react';
import type { SubagentSummary } from '@snaglet/shared/types';
import type { DetailSelection } from '@desktop/pages/Dashboard/selection/types';
import type { SubagentNavigation } from './subagentNavigation';
import { helperThreadSelection, helperThreadTitle } from './subagentText';
import { useHelperThread, type HelperThreadInfo } from './useHelperThread';
import { useThreadSubagents } from './useThreadSubagents';

export interface ChatSubagents {
  /** The thread's live helpers (composer strip). */
  subagents: SubagentSummary[];
  /** Set when the thread IS a helper's hidden thread. */
  helper: HelperThreadInfo | null;
  /** Context value for the result lines in the message list. */
  navigation: SubagentNavigation;
  /** Open a helper's thread in this pane; null without pane navigation. */
  openHelperThread: ((threadId: string, title: string) => void) | null;
  /** Open a helper thread's parent in this pane; undefined when there is none. */
  openParentThread: (() => void) | undefined;
}

/**
 * Everything ChatView needs for subagent helpers. Navigation goes
 * through the pane's own selection swap, which pushes pane history, so Back
 * returns from a helper's thread to its parent (and the other way round).
 */
export function useChatSubagents(
  threadId: string,
  /** The pane's title for this thread; null when its selection carries no node. */
  threadTitle: string | null,
  onReplaceSelection: ((selection: DetailSelection) => void) | undefined,
  /** The pane selection's helper marker (`helperParentThreadId`), if any. */
  markedParentThreadId: string | null = null
): ChatSubagents {
  const { subagents } = useThreadSubagents(threadId);
  const helper = useHelperThread(threadId, markedParentThreadId);

  // A helper pane restored after a reload is stored id-only, and the tree
  // hydration can never title it (helper threads are in no list), so it
  // would read "Thread <id>". Give the selection its node once the thread
  // row is known, and the helper marker when the pane was opened some other
  // way (a notification, the active-agents list), so a reload after the
  // helper is removed still knows what it was. An equal selection replaces
  // in place without a history step.
  const helperParentThreadId = helper && !helper.removed ? helper.parentThreadId : null;
  const selectionTitle =
    helper &&
    helperParentThreadId &&
    (threadTitle === null || markedParentThreadId !== helperParentThreadId)
      ? (threadTitle ??
        helper.title ??
        (helper.subagent
          ? helperThreadTitle(helper.subagent.orchestratorName, helper.subagent.name)
          : null))
      : null;
  useEffect(() => {
    if (!onReplaceSelection || !selectionTitle || !helperParentThreadId) return;
    onReplaceSelection(helperThreadSelection(threadId, selectionTitle, helperParentThreadId));
  }, [onReplaceSelection, selectionTitle, threadId, helperParentThreadId]);

  const openHelperThread = useMemo(
    () =>
      onReplaceSelection
        ? (helperThreadId: string, title: string) =>
            onReplaceSelection(helperThreadSelection(helperThreadId, title, threadId))
        : null,
    [onReplaceSelection, threadId]
  );
  const liveThreadIds = useMemo(
    () => new Set(subagents.flatMap((s) => (s.threadId ? [s.threadId] : []))),
    [subagents]
  );
  const navigation = useMemo<SubagentNavigation>(
    () => ({ liveThreadIds, openHelperThread }),
    [liveThreadIds, openHelperThread]
  );
  const parentThreadId = helper?.parentThreadId ?? null;
  const openParentThread = useMemo(
    () =>
      onReplaceSelection && parentThreadId
        ? () => onReplaceSelection({ kind: 'thread', thread_id: parentThreadId })
        : undefined,
    [onReplaceSelection, parentThreadId]
  );

  return { subagents, helper, navigation, openHelperThread, openParentThread };
}
