/**
 * WebSocket hooks — kept in a separate file from WebSocketContext.tsx so
 * Vite React Fast Refresh doesn't complain about mixing component exports
 * (WebSocketProvider) with hook exports in one file.
 */

import { useCallback, useContext, useEffect, useState } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { WebSocketContext } from './WebSocketContext';
import type { WsContextValue } from './WebSocketContext';

export type { WsContextValue };

/**
 * Access the raw WebSocket context. Incoming frames are delivered through
 * `addMessageListener`; the context itself only changes with the connection.
 */
export function useWs(): WsContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWs must be used within <WebSocketProvider>');
  return ctx;
}

/**
 * Subscribe to a named channel and receive only its messages.
 * Auto-subscribes on mount, unsubscribes on unmount.
 * Re-subscribes automatically when the connection is re-established.
 *
 * @example
 * const { messages, send } = useWsChannel('gateway');
 */
export function useWsChannel<T = unknown>(channel: string) {
  const { addMessageListener, send, subscribe, unsubscribe, connectionState } = useWs();
  const [messages, setMessages] = useState<WsMessage<T>[]>([]);

  useEffect(() => {
    subscribe(channel);
    return () => unsubscribe(channel);
  }, [channel, subscribe, unsubscribe]);

  useEffect(() => {
    if (connectionState !== 'open') return;
    subscribe(channel);
    // Balanced release: the provider's channel registry is holder-counted, so
    // this reconnect re-subscribe must not strand a holder per connection
    // cycle (that would keep the channel alive after unmount).
    return () => unsubscribe(channel);
  }, [connectionState, channel, subscribe, unsubscribe]);

  useEffect(
    () =>
      addMessageListener((message) => {
        if (message.channel !== channel) return;
        setMessages((prev) => [...prev.slice(-199), message as WsMessage<T>]);
      }),
    [addMessageListener, channel]
  );

  const sendToChannel = useCallback(
    (type: string, payload: T) => {
      send({ type, channel, payload });
    },
    [send, channel]
  );

  return {
    messages,
    lastMessage: messages[messages.length - 1] ?? null,
    send: sendToChannel,
    connectionState,
  };
}
