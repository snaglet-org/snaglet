/**
 * WebSocketService — panel-token push, Origin-gated.
 *
 * In Vite dev mode the server pushes the in-memory panel execution token
 * (middleware/panelAuth.ts) to freshly connected clients; the packaged app
 * gets it via Tauri's initialization_script instead. The push is sent only
 * when `Origin` matches one of this server's UI origins (buildAllowedOrigins(),
 * the allow-list CORS enforces for /api), so a raw `ws` script or a page from
 * another origin never receives it.
 *
 * Uses a real `http` server + `ws` client. One shared server/attach() for the
 * whole file: WebSocketService is a singleton whose close() does not reset
 * internal state, so attach() cannot run a second time.
 */
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { WS_PATH } from '@snaglet/shared/types';
import { wsService, addChannelObserver } from '@server/services/WebSocketService';
import { getPanelToken } from '@server/middleware/panelAuth';
import { buildAllowedOrigins } from '@server/config/corsOrigins';

describe('WebSocketService — panel-token push (Origin-gated)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let port: number;

  beforeAll(async () => {
    httpServer = createServer();
    wsService.attach(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    wsService.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  /** Collect up to `count` messages, or give up after `timeoutMs` (proves absence too). */
  function collectMessages(
    client: WebSocket,
    count: number,
    timeoutMs: number
  ): Promise<unknown[]> {
    const messages: unknown[] = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(messages), timeoutMs);
      client.on('message', (raw) => {
        messages.push(JSON.parse(raw.toString()));
        if (messages.length >= count) {
          clearTimeout(timer);
          resolve(messages);
        }
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it("sends panel-token (with the current in-memory token) right after connected, to a client whose Origin matches this server's known UI origins", async () => {
    const allowedOrigin = [...buildAllowedOrigins()][0];
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { Origin: allowedOrigin },
    });
    const messages = await collectMessages(client, 2, 2000);
    client.close();

    expect(messages[0]).toMatchObject({ type: 'connected' });
    expect(messages[1]).toEqual({
      type: 'panel-token',
      payload: { token: getPanelToken() },
    });
  });

  it('does not send panel-token to a client with no Origin header at all (a generic non-browser WS client)', async () => {
    // The `ws` Node client, unlike a real browser, sends no Origin header
    // unless one is explicitly configured — this is exactly the "raw WS
    // script" / non-browser vector the Origin gate exists to exclude.
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    const messages = await collectMessages(client, 2, 500);
    client.close();

    expect(messages[0]).toMatchObject({ type: 'connected' });
    expect(messages.find((m) => (m as { type?: string }).type === 'panel-token')).toBeUndefined();
  });

  /** Resolve with the close code the server sends, or reject if it never closes. */
  function awaitClose(client: WebSocket, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connection was not closed')), timeoutMs);
      client.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      // A non-1000 server close can also surface as a client error on some ws
      // builds; swallow it so the close code is the assertion.
      client.on('error', () => undefined);
    });
  }

  it('rejects a browser client from a foreign origin — Cross-Site WebSocket Hijacking guard (4403)', async () => {
    // A present-but-unallowed Origin is a page from another site. WS is not
    // covered by CORS, so this is the only defense —
    // the socket is closed before any message handler is wired, so the page
    // cannot send session:create / chat:send to drive an agent's tools.
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { Origin: 'http://evil.example.com' },
    });
    expect(await awaitClose(client, 2000)).toBe(4403);
  });

  it('admits a non-browser client with no Origin (native/CLI/MCP bridge)', async () => {
    // Mirrors corsOriginCheck's HTTP default: a missing Origin is a
    // non-browser caller and is allowed (it still receives no panel-token).
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    const messages = await collectMessages(client, 1, 500);
    client.close();
    expect(messages[0]).toMatchObject({ type: 'connected' });
  });

  it('admits a browser client from an allowed origin', async () => {
    const allowedOrigin = [...buildAllowedOrigins()][0];
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { Origin: allowedOrigin },
    });
    const messages = await collectMessages(client, 1, 2000);
    client.close();
    expect(messages[0]).toMatchObject({ type: 'connected' });
  });
});

describe('WebSocketService — channel observers', () => {
  it('calls observers synchronously with the message and channel; a throwing one breaks nothing', () => {
    const seen: Array<[unknown, string]> = [];
    addChannelObserver(() => {
      throw new Error('boom');
    });
    addChannelObserver((m, ch) => seen.push([m, ch]));
    const msg = { type: 'test:frame', payload: { agentId: 'test-agent-a' } };
    expect(() => wsService.broadcastToChannel('test-thread-1', msg)).not.toThrow();
    expect(seen).toEqual([[msg, 'test-thread-1']]);
  });
});
