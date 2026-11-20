/**
 * mcp-bridge — stdio <-> HTTP proxy for Snaglet's MCP server endpoint (/mcp).
 *
 * stdio-only MCP clients (e.g. `claude mcp add ... -- snaglet mcp`) speak
 * newline-delimited JSON-RPC on stdin/stdout; Snaglet's MCP server is a streamable
 * HTTP endpoint on the running server. This bridge forwards each stdin
 * message as an authenticated POST to <server>/mcp and writes each JSON-RPC
 * response back to stdout as one line.
 *
 * Auth: SNAGLET_MCP_KEY env var or --key flag (minted in Snaglet under MCP → Client connections).
 * A 401 reply names the server it was sent to (withServer).
 * Server: --server flag > SNAGLET_SERVER_URL env > the running desktop app's
 * <SNAGLET_HOME>/runtime/desktop-cli-session.json > ~/.snaglet/config.json serverUrl >
 * http://localhost:4001. The packaged app listens on a new random loopback
 * port every launch, and a bridge lives as long as its MCP client (across Snaglet
 * restarts), so unless a server is pinned the session file is re-read for
 * every message instead of keeping the port seen at startup.
 *
 * Zero dependencies — Node builtins only, matching the rest of snaglet-cli.
 */

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function readServerUrl(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed.serverUrl === 'string') return parsed.serverUrl.replace(/\/$/, '');
  } catch {
    /* missing or unreadable: fall through */
  }
  return null;
}

/** Where to send the next message. `pinned` (flag or caller env) always wins. */
export function resolveServerUrl({ pinned, snagletHome }) {
  if (pinned) return pinned.replace(/\/$/, '');
  return (
    readServerUrl(join(snagletHome, 'runtime', 'desktop-cli-session.json')) ??
    readServerUrl(join(snagletHome, 'config.json')) ??
    'http://localhost:4001'
  );
}

function writeLine(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

/**
 * A 401 (no key, a bad or revoked key, or a key from another Snaglet home) names
 * the server it was sent to, so a key used against the wrong Snaglet is easy to
 * spot. The auth middleware answers before the JSON-RPC layer, with id null:
 * the reply takes the request's id so the client matches it to its call.
 */
function withServer(reply, request, serverUrl) {
  if (!reply || typeof reply !== 'object' || !reply.error) return reply;
  const id = reply.id ?? (request && typeof request === 'object' ? request.id : undefined);
  return {
    ...reply,
    ...(id !== undefined ? { id } : {}),
    error: { ...reply.error, message: `${reply.error.message} (sent to ${serverUrl}/mcp)` },
  };
}

/** Extract JSON-RPC messages from an SSE body ("data: {...}" lines). */
function emitSseMessages(body) {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      writeLine(JSON.parse(payload));
    } catch {
      /* ignore non-JSON SSE data */
    }
  }
}

/**
 * `envServerUrl` is SNAGLET_SERVER_URL as the caller set it. bin/snaglet.mjs passes it
 * explicitly because it overwrites process.env.SNAGLET_SERVER_URL with the desktop
 * session's URL at startup, and that copy goes stale when Snaglet restarts.
 */
export async function runMcpBridge({ server, key, snagletHome, envServerUrl }) {
  const pinned =
    server || (envServerUrl === undefined ? process.env.SNAGLET_SERVER_URL : envServerUrl);
  const home = snagletHome || process.env.SNAGLET_HOME || join(homedir(), '.snaglet');
  const apiKey = key || process.env.SNAGLET_MCP_KEY;
  if (!apiKey) {
    console.error(
      'snaglet mcp: no API key. Set SNAGLET_MCP_KEY or pass --key <key> (mint one in Snaglet under MCP → Client connections).'
    );
    process.exit(1);
  }
  async function forward(message) {
    const hasId = message && typeof message === 'object' && message.id !== undefined;
    const serverUrl = resolveServerUrl({ pinned, snagletHome: home });
    try {
      const response = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(message),
      });

      if (response.status === 202) return; // notification accepted, no body

      const contentType = response.headers.get('content-type') ?? '';
      const body = await response.text();

      if (contentType.includes('text/event-stream')) {
        emitSseMessages(body);
        return;
      }

      if (body.trim()) {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* non-JSON error body — fall through to synthesized error */
        }
        if (parsed !== undefined) {
          writeLine(response.status === 401 ? withServer(parsed, message, serverUrl) : parsed);
          return;
        }
      }
      if (hasId) {
        writeLine({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: `Snaglet MCP endpoint returned ${response.status}` },
        });
      }
    } catch (err) {
      if (hasId) {
        writeLine({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: `cannot reach Snaglet server at ${serverUrl} — is it running? (${err.message})`,
          },
        });
      } else {
        console.error(`snaglet mcp: cannot reach Snaglet server at ${serverUrl} — is it running?`);
      }
    }
  }

  const rl = createInterface({ input: process.stdin, terminal: false });
  const inFlight = new Set();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      console.error('snaglet mcp: skipping non-JSON stdin line');
      return;
    }
    const task = forward(message).finally(() => inFlight.delete(task));
    inFlight.add(task);
  });

  await new Promise((resolvePromise) => rl.on('close', resolvePromise));
  await Promise.allSettled([...inFlight]);
}
