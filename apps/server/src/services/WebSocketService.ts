/**
 * WebSocketService — central WebSocket manager for the Snaglet server. A single
 * instance attaches to the existing HTTP server (`wsService.attach(httpServer)`)
 * and every feature shares its connection pool via `broadcast`,
 * `broadcastToChannel` and `registerHandler`.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import type { IncomingMessage, Server } from 'http';
import { randomUUID, timingSafeEqual } from 'crypto';
import type { WsMessage, WsMessageHandler } from '@snaglet/shared/types';
import { WS_PATH } from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import { authenticateMcpKey } from '@server/domains/mcp/mcpAuth';
import type { ExternalCaller } from '@server/domains/mcp/McpGatewayService';
import { getPanelToken } from '@server/middleware/panelAuth';
import { buildAllowedOrigins } from '@server/config/corsOrigins';

interface ManagedClient {
  id: string;
  socket: WebSocket;
  channels: Set<string>;
  isAlive: boolean;
  externalCaller?: ExternalCaller;
}

/**
 * Constant-time token compare (matches sidecarAuth/panelAuth). timingSafeEqual
 * throws on length mismatch, so bail early when lengths differ — the token
 * length is fixed by the shell and is not itself a useful oracle.
 */
function constantTimeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type ChannelObserver = (
  message: { type?: string; payload?: unknown },
  channel: string
) => void;
const channelObservers: ChannelObserver[] = [];
/** Register a synchronous tap on every channel broadcast (must not throw or await). */
export function addChannelObserver(fn: ChannelObserver): void {
  channelObservers.push(fn);
}

class WebSocketService {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ManagedClient>();
  private handlers = new Map<string, WsMessageHandler<unknown>>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private disconnectListeners = new Set<(clientId: string) => void>();
  private acceptingConnections = true;

  stopAcceptingConnections(): void {
    this.acceptingConnections = false;
  }

  /**
   * Register a callback fired when a client connection closes (graceful close
   * or heartbeat termination). Used by addressed surfaces (e.g. the `ui`
   * surface) to prune their userId -> clientId registry deterministically.
   * Returns an unsubscribe function.
   */
  onDisconnect(listener: (clientId: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private emitDisconnect(clientId: string): void {
    for (const listener of this.disconnectListeners) {
      try {
        listener(clientId);
      } catch (err) {
        logger.error('[ws] disconnect listener threw', {
          clientId,
          error: getErrorMessage(err),
        });
      }
    }
  }

  /** Attach to an existing HTTP server. Call once at startup. */
  attach(server: Server): void {
    if (this.wss) {
      logger.warn('[ws] Already attached — ignoring duplicate attach()');
      return;
    }

    this.wss = new WebSocketServer({ server, path: WS_PATH });
    this.wss.on('connection', this.handleConnection.bind(this));
    this.startHeartbeat();
    logger.info(`[ws] WebSocket server listening on ${WS_PATH}`);
  }

  private handleConnection(socket: WebSocket, _req: IncomingMessage): void {
    if (!this.acceptingConnections) {
      socket.close(1012, 'Snaglet is shutting down');
      return;
    }
    void this.initializeConnection(socket, _req);
  }

  private async initializeConnection(socket: WebSocket, _req: IncomingMessage): Promise<void> {
    // Cross-Site WebSocket Hijacking guard. WebSocket upgrades are not covered
    // by CORS, so the only server-side defense against a page on another site
    // opening ws://127.0.0.1/ws is a handshake Origin check. Browsers always
    // send Origin on a WS handshake (RFC 6455) and a script cannot forge it,
    // so a present-but-unallowed Origin is exactly a cross-site page — reject
    // it (4403). A missing Origin is a non-browser client (native/CLI bridge,
    // MCP Bearer clients) and is allowed, mirroring corsOriginCheck's HTTP
    // default. Without this, in no-token mode (the dev / self-hosted default,
    // where SNAGLET_AUTH_TOKEN is unset) any website the user visits could drive
    // agent turns — and their shell/file tools — over this socket.
    const handshakeOrigin = _req.headers.origin;
    if (typeof handshakeOrigin === 'string' && !buildAllowedOrigins().has(handshakeOrigin)) {
      socket.close(4403, 'Forbidden: origin not allowed');
      return;
    }

    // Sidecar session-token auth — same contract as the /api
    // middleware. Browsers can't set headers on WebSocket connects, so the
    // token rides the URL: ws://host/ws?snaglet_token=…  4401 = app-level
    // unauthorized close code.
    const requiredToken = process.env.SNAGLET_AUTH_TOKEN;
    if (requiredToken) {
      const url = new URL(_req.url ?? '/', 'http://localhost');
      const presented =
        url.searchParams.get('snaglet_token') ??
        (_req.headers['x-snaglet-token'] as string | undefined);
      // Constant-time compare, consistent with sidecarAuth/panelAuth — a plain
      // !== leaks match position through timing.
      if (typeof presented !== 'string' || !constantTimeEqual(presented, requiredToken)) {
        socket.close(4401, 'Unauthorized: missing or invalid Snaglet session token');
        return;
      }
    }
    const authorization = _req.headers.authorization;
    const bearer =
      typeof authorization === 'string' ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
    const externalCaller = bearer
      ? ((await authenticateMcpKey(bearer[1]!)) ?? undefined)
      : undefined;
    if (bearer && !externalCaller) {
      socket.close(4401, 'Unauthorized: invalid or revoked external API key');
      return;
    }
    const clientId = randomUUID();
    const client: ManagedClient = {
      id: clientId,
      socket,
      channels: new Set(),
      isAlive: true,
      externalCaller,
    };
    this.clients.set(clientId, client);

    // Send connected ack
    this.send(socket, { type: 'connected', payload: { clientId } });

    // Panel execution token (see panelAuth.ts). The packaged app gets it from
    // Tauri at launch; this push serves Vite dev mode and other same-origin
    // UIs. It is never in an HTTP response, only a live WS upgrade, which
    // `web_fetch` cannot perform. Security: sent only when Origin is one of
    // buildAllowedOrigins() (the CORS allow-list). A missing Origin is not
    // allowed here, unlike corsOriginCheck's HTTP default: every browser WS
    // handshake sends Origin, so none means a non-browser client. Known gap: a
    // browser driven to load this app's own origin still receives it; closing
    // that would mean distrusting the app's own page script.
    const originHeader = _req.headers.origin;
    if (typeof originHeader === 'string' && buildAllowedOrigins().has(originHeader)) {
      this.send(socket, { type: 'panel-token', payload: { token: getPanelToken() } });
    }

    socket.on('message', (raw) => this.handleMessage(client, raw.toString()));
    socket.on('pong', () => {
      client.isAlive = true;
    });
    socket.on('close', () => {
      this.clients.delete(clientId);
      this.emitDisconnect(clientId);
    });
    socket.on('error', (err) => {
      logger.error(`[ws] Client ${clientId} error:`, err.message);
    });
  }

  private handleMessage(client: ManagedClient, raw: string): void {
    const msg = safeJsonParse<WsMessage | null>(raw, null);
    if (!msg) {
      this.send(client.socket, { type: 'error', payload: { message: 'Invalid JSON' } });
      return;
    }

    // Built-in: ping/pong
    if (msg.type === 'ping') {
      this.send(client.socket, { type: 'pong', payload: null });
      return;
    }

    // Built-in: subscribe/unsubscribe to a channel
    if (msg.type === 'subscribe' && msg.channel) {
      client.channels.add(msg.channel);
      this.send(client.socket, { type: 'subscribed', channel: msg.channel, payload: null });
      return;
    }
    if (msg.type === 'unsubscribe' && msg.channel) {
      client.channels.delete(msg.channel);
      this.send(client.socket, { type: 'unsubscribed', channel: msg.channel, payload: null });
      return;
    }

    // Dispatch to registered handlers. Handlers may be async and are invoked
    // fire-and-forget (we don't block the socket read loop on them) — but a
    // rejected handler promise must not be swallowed. An unhandled rejection
    // here would vanish silently — a throw inside e.g. the chat-send handler
    // (after it acquired the per-thread run lock) would leave the thread
    // wedged with no error logged anywhere. Always surface it.
    const handler = this.handlers.get(msg.type);
    if (handler) {
      Promise.resolve(
        handler(msg.payload, {
          clientId: client.id,
          channel: msg.channel,
          messageId: msg.id,
          externalCaller: client.externalCaller,
        })
      ).catch((err) => {
        logger.error(`[ws] handler "${msg.type}" threw`, {
          clientId: client.id,
          error: getErrorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      });
    }
  }

  /**
   * Register a handler for a specific message type sent from clients.
   * Use for client→server actions.
   */
  registerHandler<T>(type: string, handler: WsMessageHandler<T>): void {
    this.handlers.set(type, handler as WsMessageHandler<unknown>);
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast<T>(message: WsMessage<T>): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  /**
   * Broadcast to all clients subscribed to a specific channel.
   */
  broadcastToChannel<T>(channel: string, message: WsMessage<T>): void {
    // Synchronous taps (e.g. cursor emotions): guarded, they never break a broadcast or a turn.
    for (const o of channelObservers) {
      try {
        o(message as { type?: string; payload?: unknown }, channel);
      } catch {
        /* observers never break a broadcast */
      }
    }
    const payload = JSON.stringify({ ...message, channel });
    for (const client of this.clients.values()) {
      if (client.socket.readyState === WebSocket.OPEN && client.channels.has(channel)) {
        client.socket.send(payload);
      }
    }
  }

  /**
   * Send a message to a specific client by ID.
   */
  sendToClient<T>(clientId: string, message: WsMessage<T>): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) return false;
    this.send(client.socket, message);
    return true;
  }

  /** Number of currently connected clients. */
  get connectionCount(): number {
    return this.clients.size;
  }

  private send<T>(socket: WebSocket, message: WsMessage<T>): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /** Ping all clients every 30s; drop ones that haven't responded. */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.isAlive) {
          client.socket.terminate();
          this.clients.delete(client.id);
          this.emitDisconnect(client.id);
          continue;
        }
        client.isAlive = false;
        client.socket.ping();
      }
    }, 30_000);
  }

  close(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.wss?.close();
  }
}

// Singleton — import this everywhere
export const wsService = new WebSocketService();
