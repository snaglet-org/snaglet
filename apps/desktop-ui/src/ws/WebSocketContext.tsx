import { createContext, useCallback, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { WS_PATH } from '@snaglet/shared/types';
import { clientConfig, desktopSessionToken } from '../config';
import { setPanelToken } from '../utils/panelToken';

type WsConnectionState = 'connecting' | 'open' | 'closed' | 'error';

type WsMessageListener = (msg: WsMessage) => void;

export interface WsContextValue {
  connectionState: WsConnectionState;
  serverRestarting: boolean;
  send: (message: WsMessage) => void;
  subscribe: (channel: string) => void;
  unsubscribe: (channel: string) => void;
  addMessageListener: (listener: WsMessageListener) => () => void;
}

function buildWsUrl(): string {
  // Derive WS URL from the API base URL (http→ws, https→wss). Resolve against
  // the page origin so a relative dev base (`/api`) becomes absolute; bare
  // `new URL('/api')` throws. An absolute base ignores the origin arg. The dev
  // Vite proxy forwards the resulting `/ws` upgrade to the server.
  const apiUrl = new URL(clientConfig.apiBaseUrl, window.location.href);
  const protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  // Desktop shell: WS upgrades can't carry headers, so the sidecar session
  // token rides the query string (checked in WebSocketService.handleConnection).
  const tokenQs = desktopSessionToken
    ? `?snaglet_token=${encodeURIComponent(desktopSessionToken)}`
    : '';
  return `${protocol}//${apiUrl.host}${WS_PATH}${tokenQs}`;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 500;

export const WebSocketContext = createContext<WsContextValue | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connectionState, setConnectionState] = useState<WsConnectionState>('connecting');
  const [serverRestarting, setServerRestarting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Channel registry with per-channel holder counts, not a plain set. Several
  // views can subscribe the same channel (one thread open in two panes), but
  // the server tracks one boolean per (client, channel), so the wire
  // `unsubscribe` is sent only when the last holder releases. Otherwise one
  // view's unmount would silently stop broadcasts to the others.
  const subscribedChannelsRef = useRef<Map<string, number>>(new Map());
  const unmountedRef = useRef(false);
  const serverRestartingRef = useRef(false);
  const messageListenersRef = useRef<Set<WsMessageListener>>(new Set());
  // Frames sent while the socket isn't open are buffered here and flushed on
  // (re)connect, so a `socket:chat:send` during connect or reconnect isn't
  // silently dropped.
  const pendingSendsRef = useRef<WsMessage[]>([]);

  const writeRaw = useCallback((msg: WsMessage): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  const sendRaw = useCallback(
    (msg: WsMessage) => {
      if (writeRaw(msg)) return;
      // subscribe/unsubscribe frames don't need buffering — channel state
      // is reconciled via resubscribeChannels() on every (re)connect.
      if (msg.type === 'subscribe' || msg.type === 'unsubscribe') return;
      pendingSendsRef.current.push(msg);
    },
    [writeRaw]
  );

  const flushPendingSends = useCallback(() => {
    if (pendingSendsRef.current.length === 0) return;
    const queue = pendingSendsRef.current;
    pendingSendsRef.current = [];
    for (const msg of queue) {
      if (!writeRaw(msg)) {
        // Socket dropped again mid-flush — re-buffer the rest.
        pendingSendsRef.current.push(msg, ...queue.slice(queue.indexOf(msg) + 1));
        return;
      }
    }
  }, [writeRaw]);

  const resubscribeChannels = useCallback(() => {
    for (const channel of subscribedChannelsRef.current.keys()) {
      sendRaw({ type: 'subscribe', channel, payload: null });
    }
  }, [sendRaw]);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    const url = buildWsUrl();
    setConnectionState('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // A previous WebSocket (e.g. from a StrictMode double-mount or a
      // reconnect cycle) can fire its `onopen` after we've already pointed
      // wsRef at a newer socket. Ignore those late opens — wsRef is the
      // authoritative connection.
      if (wsRef.current !== ws || unmountedRef.current) {
        ws.close();
        return;
      }
      setConnectionState('open');
      serverRestartingRef.current = false;
      setServerRestarting(false);
      reconnectAttemptRef.current = 0;
      resubscribeChannels();
      flushPendingSends();
    };

    ws.onmessage = (event) => {
      // Drop frames from stale sockets — a leaked previous connection (e.g.
      // post-StrictMode double-mount) will keep receiving the same channel
      // broadcasts as the live one, causing duplicate delta/done processing.
      if (wsRef.current !== ws) return;
      try {
        const msg = JSON.parse(event.data) as WsMessage;

        // Panel execution token — see utils/panelToken.ts's module doc. This
        // is the Vite-dev-mode delivery channel (the packaged app already has
        // it synchronously via config.ts's Tauri-injected value); harmless to
        // also apply it there since it's the same value.
        if (msg.type === 'panel-token') {
          const token = (msg.payload as { token?: unknown } | null)?.token;
          if (typeof token === 'string') setPanelToken(token);
        }

        // Track server restart lifecycle — use fast reconnect when we know
        // the server is coming back shortly
        if (
          msg.type === 'socket:server:restart_pending' ||
          msg.type === 'socket:server:restarting'
        ) {
          serverRestartingRef.current = true;
          setServerRestarting(true);
        }

        // Frames reach consumers only through listeners, never context state:
        // a per-frame state update would re-render every `useWs` consumer on
        // every streaming delta, and batching would drop frames besides.
        for (const listener of messageListenersRef.current) {
          listener(msg);
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => {
      if (unmountedRef.current) return;
      // Late close from a stale socket (e.g. one we just replaced during a
      // StrictMode double-mount) must not stomp the state of the live
      // connection or trigger a spurious reconnect.
      if (wsRef.current !== ws) return;
      setConnectionState('closed');
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (unmountedRef.current) return;
      if (wsRef.current !== ws) return;
      setConnectionState('error');
      // onclose will fire after onerror — reconnect handled there
    };
  }, [resubscribeChannels, flushPendingSends]);

  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    const attempt = reconnectAttemptRef.current++;
    // When we know the server is restarting, poll quickly (500ms) instead
    // of backing off — the server will be back in a few seconds.
    const delay = serverRestartingRef.current
      ? 500
      : Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS) +
        Math.random() * RECONNECT_JITTER_MS;
    reconnectTimerRef.current = setTimeout(connect, delay);
  }, [connect]);

  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback(
    (message: WsMessage) => {
      sendRaw(message);
    },
    [sendRaw]
  );

  const subscribe = useCallback(
    (channel: string) => {
      const counts = subscribedChannelsRef.current;
      counts.set(channel, (counts.get(channel) ?? 0) + 1);
      // Always (re)send — the server's channel add is idempotent, and callers
      // rely on this to re-assert the subscription after a reconnect.
      sendRaw({ type: 'subscribe', channel, payload: null });
    },
    [sendRaw]
  );

  const unsubscribe = useCallback(
    (channel: string) => {
      const counts = subscribedChannelsRef.current;
      const current = counts.get(channel) ?? 0;
      if (current > 1) {
        // Another mounted view still listens on this channel — release this
        // holder only; the server-side subscription must stay live.
        counts.set(channel, current - 1);
        return;
      }
      counts.delete(channel);
      sendRaw({ type: 'unsubscribe', channel, payload: null });
    },
    [sendRaw]
  );

  const addMessageListener = useCallback((listener: WsMessageListener) => {
    messageListenersRef.current.add(listener);
    return () => {
      messageListenersRef.current.delete(listener);
    };
  }, []);

  const value = useMemo<WsContextValue>(
    () => ({
      connectionState,
      serverRestarting,
      send,
      subscribe,
      unsubscribe,
      addMessageListener,
    }),
    [connectionState, serverRestarting, send, subscribe, unsubscribe, addMessageListener]
  );

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}
