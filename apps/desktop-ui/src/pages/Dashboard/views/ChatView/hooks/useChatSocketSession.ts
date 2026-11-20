import { useEffect, useRef, useState } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { useWs } from '@desktop/ws/useWs';

export interface ChatSocketSession {
  /** sessionId once the WS server has confirmed the resume; null until then. */
  sessionId: string | null;
  /** Ref mirror of sessionId — read inside event handlers without re-binding. */
  sessionIdRef: React.RefObject<string | null>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Subscribe to the thread's broadcast channel and resume the WS session. On
 * every connection open it re-subscribes and resumes, because the server
 * resets both on reconnect. The resume waits until the thread has a
 * participant (the server would reject it). The parent hook's frame handler
 * calls `setSessionId` when `socket:session:created` arrives.
 */
export function useChatSocketSession(
  threadId: string,
  participantCount: number,
  refetchParticipants?: () => void | Promise<void>
): ChatSocketSession {
  const { send, connectionState, subscribe, unsubscribe, addMessageListener } = useWs();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Reset sessionId on threadId change: the previous thread's session
  // doesn't apply here.
  useEffect(() => {
    setSessionId(null);
  }, [threadId]);

  useEffect(() => {
    subscribe(threadId);
    return () => unsubscribe(threadId);
  }, [threadId, subscribe, unsubscribe]);

  useEffect(() => {
    if (connectionState !== 'open') return;
    if (participantCount === 0) return;
    subscribe(threadId);
    send({ type: 'socket:session:resume', payload: { threadId } });
    // The channel registry is holder-counted (see WebSocketContext): every
    // subscribe must release exactly once, or this effect's re-runs
    // (reconnects, participant-count changes) would strand holders and keep
    // the channel subscribed after the chat closes.
    return () => unsubscribe(threadId);
  }, [threadId, connectionState, send, subscribe, unsubscribe, participantCount]);

  // Roster mutations can originate in another surface (for example, thread
  // settings), so invalidate the REST participant snapshot when their
  // broadcast narration arrives. The event kind is encoded in the stable
  // content prefix; the socket payload intentionally remains a normal
  // thread_event message for rendering.
  useEffect(() => {
    if (!refetchParticipants) return;
    const off = addMessageListener((message: WsMessage) => {
      if (message.channel != null && message.channel !== threadId) return;
      if (message.type !== 'socket:chat:message_created') return;
      const payload = message.payload as {
        threadId?: string;
        message_type?: string;
        content?: string;
      };
      if (payload.threadId !== threadId || payload.message_type !== 'thread_event') return;
      if (
        typeof payload.content !== 'string' ||
        !/^\[participant (added|removed)/.test(payload.content)
      )
        return;
      void refetchParticipants();
    });
    return off;
  }, [addMessageListener, refetchParticipants, threadId]);

  return { sessionId, sessionIdRef, setSessionId };
}
