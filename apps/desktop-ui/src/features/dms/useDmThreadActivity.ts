import { useEffect, useRef } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { useWs } from '@desktop/ws/useWs';

/** Thread id a `socket:chat:message_created` frame is about, if any. */
function messageCreatedThreadId(message: WsMessage): string | null {
  if (message.type !== 'socket:chat:message_created') return null;
  const payload = message.payload as { threadId?: unknown } | null | undefined;
  if (typeof payload?.threadId === 'string') return payload.threadId;
  return typeof message.channel === 'string' ? message.channel : null;
}

/**
 * Calls `onActivity` when a message lands in one of `threadIds`.
 *
 * DM messages are broadcast only on their thread's channel (an agent's
 * `dm_send` raises no workspace event), so a list of DM threads subscribes to
 * each listed thread's channel and listens for the ordinary
 * `socket:chat:message_created` frame. The provider's channel registry is
 * holder-counted, so this shares subscriptions with an open thread pane.
 */
export function useDmThreadActivity(
  threadIds: readonly string[],
  onActivity: (threadId: string) => void
): void {
  const { subscribe, unsubscribe, addMessageListener } = useWs();
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  // A stable key, so a refetch that returns the same threads re-subscribes nothing.
  const key = [...new Set(threadIds)].sort().join('\n');

  useEffect(() => {
    if (!key) return;
    const ids = key.split('\n');
    for (const id of ids) subscribe(id);
    return () => {
      for (const id of ids) unsubscribe(id);
    };
  }, [key, subscribe, unsubscribe]);

  useEffect(() => {
    if (!key) return;
    const ids = new Set(key.split('\n'));
    return addMessageListener((message) => {
      const threadId = messageCreatedThreadId(message);
      if (threadId && ids.has(threadId)) onActivityRef.current(threadId);
    });
  }, [key, addMessageListener]);
}
