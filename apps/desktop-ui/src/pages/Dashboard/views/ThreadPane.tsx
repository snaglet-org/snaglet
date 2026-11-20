import { useEffect, useState, type FC } from 'react';
import { threadsApi } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { ChatView } from './ChatView';
import { DmView } from './DmView';
import type { DetailSelection } from '../selection/types';
import { useClaimOpenInSidebar } from '../chrome/PaneChrome/openInSidebar';

type ThreadSelection = Extract<NonNullable<DetailSelection>, { kind: 'thread' }>;
type ThreadKind = 'chat' | 'dm';

/** A thread's kind never changes, so one read per thread per session is enough. */
const knownKinds = new Map<string, ThreadKind>();

/** The thread's kind, or null while it is being read. A failed read counts as chat. */
function useThreadKind(threadId: string): ThreadKind | null {
  const [kind, setKind] = useState<ThreadKind | null>(() => knownKinds.get(threadId) ?? null);
  useEffect(() => {
    const known = knownKinds.get(threadId);
    if (known) {
      setKind(known);
      return;
    }
    setKind(null);
    let canceled = false;
    threadsApi.get(threadId).then(
      (thread) => {
        const next: ThreadKind = thread.kind === 'dm' ? 'dm' : 'chat';
        knownKinds.set(threadId, next);
        if (!canceled) setKind(next);
      },
      (err: unknown) => {
        // The chat view reports the thread's own load failure.
        console.error('ThreadPane: failed to read the thread', getErrorMessage(err));
        if (!canceled) setKind('chat');
      }
    );
    return () => {
      canceled = true;
    };
  }, [threadId]);
  return kind;
}

interface ThreadPaneProps {
  selection: ThreadSelection;
  onReplaceSelection?: (selection: DetailSelection) => void;
  onClosePane?: () => void;
}

/**
 * ThreadPane — what a `thread` pane selection renders: the chat view, or the
 * DM reading pane for a DM thread.
 *
 * Every way of opening a thread by id lands here (the notification bell,
 * thread chips, an agent's navigate_pane, restored layouts), so this is the
 * one place a DM thread is told apart. A selection carrying a workspace-tree
 * node shows the chat view at once (DM threads are never in the tree); one
 * without waits for the thread's kind, so a DM never flashes the chat view.
 */
export const ThreadPane: FC<ThreadPaneProps> = ({ selection, onReplaceSelection, onClosePane }) => {
  const kind = useThreadKind(selection.thread_id);
  const title = selection.node?.title ?? null;
  // While the kind is being read nothing renders; hold the topbar's "Open in
  // sidebar" back so it doesn't show for the fetch and then move into
  // ChatView's settings panel.
  useClaimOpenInSidebar(kind === null && !selection.node);

  if (kind === 'dm') {
    return (
      <DmView
        key={selection.thread_id}
        threadId={selection.thread_id}
        title={title}
        onClosePane={onClosePane}
      />
    );
  }
  if (kind === null && !selection.node) return null;
  return (
    <ChatView
      key={selection.thread_id}
      threadId={selection.thread_id}
      threadTitle={title}
      focusAgentId={selection.focusAgentId ?? null}
      focusMemoryId={selection.focusMemoryId ?? null}
      focusSummaryId={selection.focusSummaryId ?? null}
      focusMessageId={selection.focusMessageId ?? null}
      focusRequestId={selection.focusRequestId ?? null}
      onReplaceSelection={onReplaceSelection}
      helperParentThreadId={selection.helperParentThreadId ?? null}
    />
  );
};
