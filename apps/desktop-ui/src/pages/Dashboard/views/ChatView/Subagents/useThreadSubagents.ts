import { useEffect, useRef, useState } from 'react';
import {
  SUBAGENT_CHANGED_FRAME,
  type SubagentChangedPayload,
  type SubagentSummary,
  type WsMessage,
} from '@snaglet/shared/types';
import { threadsApi } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useWs } from '@desktop/ws/useWs';

export interface ThreadSubagents {
  /** Live helpers started in the thread, oldest first. */
  subagents: SubagentSummary[];
  /** True once the REST seed has answered; a failed read leaves it false. */
  loaded: boolean;
}

interface State {
  threadId: string;
  subagents: SubagentSummary[];
  loaded: boolean;
}

const EMPTY: SubagentSummary[] = [];

function applyChange(list: SubagentSummary[], change: SubagentChangedPayload): SubagentSummary[] {
  const next = change.subagent;
  if (!next) {
    return change.removedId ? list.filter((s) => s.id !== change.removedId) : list;
  }
  const at = list.findIndex((s) => s.id === next.id);
  if (at < 0) return [...list, next];
  const copy = list.slice();
  copy[at] = next;
  return copy;
}

function isChangePayload(value: unknown): value is SubagentChangedPayload {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { parentThreadId?: unknown }).parentThreadId === 'string'
  );
}

/**
 * The live subagent helpers of a thread. Seeds from
 * GET /api/threads/:id/subagents — again after every reconnect, since frames
 * missed while disconnected are not replayed — then follows the
 * `subagent:changed` frames the server sends on the thread's channel. A
 * workspace `thread.deleted` for a helper's thread also drops it, in case the
 * removal frame was missed. Pass '' to keep it inert.
 */
export function useThreadSubagents(threadId: string): ThreadSubagents {
  const { subscribe, unsubscribe, addMessageListener, connectionState } = useWs();
  const [state, setState] = useState<State>({ threadId, subagents: EMPTY, loaded: false });
  const isOpen = connectionState === 'open';
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (!threadId) return;
    // The first read for a thread runs whatever the socket state; after that
    // only a (re)opened socket re-reads.
    if (!isOpen && seededFor.current === threadId) return;
    seededFor.current = threadId;
    let canceled = false;
    threadsApi
      .listSubagents(threadId)
      .then((subagents) => {
        if (!canceled) setState({ threadId, subagents, loaded: true });
      })
      .catch((err: unknown) => {
        // Frames still apply; the next reconnect reads again.
        console.error('useThreadSubagents: failed to load subagents', err);
      });
    return () => {
      canceled = true;
    };
  }, [threadId, isOpen]);

  useEffect(() => {
    if (!threadId) return;
    // Holder-counted: the open chat of this thread subscribes the same channel.
    subscribe(threadId);
    const off = addMessageListener((message: WsMessage) => {
      if (message.type !== SUBAGENT_CHANGED_FRAME) return;
      if (message.channel != null && message.channel !== threadId) return;
      const change = message.payload;
      if (!isChangePayload(change) || change.parentThreadId !== threadId) return;
      setState((prev) =>
        prev.threadId === threadId
          ? { ...prev, subagents: applyChange(prev.subagents, change) }
          : { threadId, subagents: applyChange(EMPTY, change), loaded: false }
      );
    });
    return () => {
      off();
      unsubscribe(threadId);
    };
  }, [threadId, subscribe, unsubscribe, addMessageListener]);

  useEffect(() => {
    if (!threadId) return;
    return onLibraryEvent((event) => {
      if (event.type !== 'deleted' || event.kind !== 'thread') return;
      setState((prev) => {
        if (prev.threadId !== threadId || !prev.subagents.some((s) => s.threadId === event.id)) {
          return prev;
        }
        return { ...prev, subagents: prev.subagents.filter((s) => s.threadId !== event.id) };
      });
    });
  }, [threadId]);

  if (!threadId || state.threadId !== threadId) return { subagents: EMPTY, loaded: false };
  return { subagents: state.subagents, loaded: state.loaded };
}
