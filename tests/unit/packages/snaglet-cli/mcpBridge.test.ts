/**
 * `snaglet mcp` — the stdio bridge, run as the REAL CLI against two local HTTP
 * servers standing in for Snaglet before and after a restart.
 *
 * The packaged app listens on a new random port every launch and publishes it
 * in <SNAGLET_HOME>/runtime/desktop-cli-session.json. MCP clients keep one bridge
 * process for their whole session, so a bridge that read the port once at
 * startup kept calling a dead port after every Snaglet restart.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

const CLI = resolve(process.cwd(), 'packages/snaglet-cli/bin/snaglet.mjs');

let snagletHome: string;
let servers: Server[] = [];
let bridge: ChildProcessWithoutNullStreams | null = null;

/** A stand-in Snaglet /mcp endpoint that answers every request with its own name. */
async function fakeSnaglet(name: string): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const { id } = JSON.parse(body) as { id: number };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { server: name } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stand-in Snaglet that refuses the key, as mcpAuth does: a 401 JSON-RPC error with id null. */
async function refusingSnaglet(message: string): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function publishSession(serverUrl: string): Promise<void> {
  await writeFile(
    join(snagletHome, 'runtime', 'desktop-cli-session.json'),
    JSON.stringify({ serverUrl })
  );
}

/** Start the bridge; returns a call() that sends one request and awaits its reply. */
function startBridge(env: NodeJS.ProcessEnv): (id: number) => Promise<string> {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env });
  bridge = child;
  const replies = new Map<number, (server: string) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as { id: number; result?: { server: string }; error?: unknown };
    replies.get(msg.id)?.(msg.result?.server ?? `error: ${JSON.stringify(msg.error)}`);
  });
  return (id) =>
    new Promise((done) => {
      replies.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`);
    });
}

function bridgeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SNAGLET_HOME: snagletHome,
    SNAGLET_MCP_KEY: 'test-key',
  };
  delete env.SNAGLET_SERVER_URL;
  return { ...env, ...extra };
}

beforeEach(async () => {
  snagletHome = await mkdtemp(join(tmpdir(), 'snaglet-mcp-bridge-'));
  await mkdir(join(snagletHome, 'runtime'));
});

afterEach(async () => {
  bridge?.kill();
  bridge = null;
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  servers = [];
  await rm(snagletHome, { recursive: true, force: true });
});

describe('snaglet mcp bridge', () => {
  it('follows the desktop app to its new port after a Snaglet restart', async () => {
    const before = await fakeSnaglet('before-restart');
    const after = await fakeSnaglet('after-restart');
    await publishSession(before);
    const call = startBridge(bridgeEnv());

    expect(await call(1)).toBe('before-restart');
    await publishSession(after);
    expect(await call(2)).toBe('after-restart');
  });

  it('a refused key names the server it was sent to, under the request’s id', async () => {
    const refusing = await refusingSnaglet('Invalid or revoked API key.');
    const call = startBridge(bridgeEnv({ SNAGLET_SERVER_URL: refusing }));

    const reply = await call(7);
    expect(reply).toBe(
      `error: ${JSON.stringify({
        code: -32001,
        message: `Invalid or revoked API key. (sent to ${refusing}/mcp)`,
      })}`
    );
  });

  it('keeps a server the caller pinned with SNAGLET_SERVER_URL', async () => {
    const pinned = await fakeSnaglet('pinned');
    const session = await fakeSnaglet('desktop-session');
    await publishSession(session);
    const call = startBridge(bridgeEnv({ SNAGLET_SERVER_URL: pinned }));

    expect(await call(1)).toBe('pinned');
  });
});
