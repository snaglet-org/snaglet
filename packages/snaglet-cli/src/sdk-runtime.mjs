/**
 * @snaglet/sdk — script-context runtime for the Snaglet sandbox script runner.
 *
 * This module is what `import { tools, snaglet } from '@snaglet/sdk'` resolves to when a
 * script is executed via `snaglet run`. It proxies tool calls to the running Snaglet
 * server's POST /api/tools/execute endpoint, so scripts use the exact same
 * tool layer (validation, auth, safety rails) that agents use — never raw SQL.
 *
 * Resolution of the server URL (first match wins):
 *   1. SNAGLET_SERVER_URL env var
 *   2. serverUrl field in ~/.snaglet/config.json
 *   3. http://localhost:4001
 *
 * Dry-run: when SNAGLET_DRY_RUN=1 every tool call is printed instead of executed
 * and resolves to { dryRun: true }. Toggle per-call via tools.$real / tools.$dry.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveServerUrl() {
  if (process.env.SNAGLET_SERVER_URL) return process.env.SNAGLET_SERVER_URL.replace(/\/$/, '');
  try {
    const cfg = JSON.parse(
      readFileSync(
        join(process.env.SNAGLET_HOME || join(homedir(), '.snaglet'), 'config.json'),
        'utf-8'
      )
    );
    if (cfg && typeof cfg.serverUrl === 'string') return cfg.serverUrl.replace(/\/$/, '');
  } catch {
    /* no config file — fall through to default */
  }
  return 'http://localhost:4001';
}

const SERVER_URL = resolveServerUrl();
const DRY_RUN = process.env.SNAGLET_DRY_RUN === '1';
const VERBOSE = process.env.SNAGLET_VERBOSE === '1';

let callCount = 0;

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.SNAGLET_SIDECAR_TOKEN)
    h['X-Snaglet-Sidecar-Token'] = process.env.SNAGLET_SIDECAR_TOKEN;
  return h;
}

/**
 * Execute a tool by name through the server's tool layer.
 * Throws on transport errors, envelope failures, and tool-level failures.
 * Returns the tool's `output` payload.
 */
export async function callTool(name, input = {}, opts = {}) {
  const dry = opts.dryRun ?? DRY_RUN;
  callCount += 1;

  if (dry) {
    console.log(`[dry-run] #${callCount} ${name} ${JSON.stringify(input)}`);
    return { dryRun: true, tool: name, input };
  }

  if (VERBOSE) console.log(`[snaglet] #${callCount} ${name} ${JSON.stringify(input)}`);

  let response;
  try {
    response = await fetch(`${SERVER_URL}/api/tools/execute`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name, input }),
    });
  } catch (err) {
    throw new Error(
      `@snaglet/sdk: cannot reach Snaglet server at ${SERVER_URL} — is it running? (${err.message})`
    );
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(
      `@snaglet/sdk: server returned non-JSON (HTTP ${response.status}) for tool "${name}"`
    );
  }

  if (!response.ok || envelope.success === false) {
    const msg = envelope?.error ?? `HTTP ${response.status}`;
    throw new Error(`@snaglet/sdk: tool "${name}" request failed: ${msg}`);
  }

  const result = envelope.data;
  if (result && result.success === false) {
    throw new Error(`@snaglet/sdk: tool "${name}" failed: ${result.error ?? 'unknown error'}`);
  }
  const output = result?.output !== undefined ? result.output : result;
  // Tool outputs are often JSON serialized as strings — parse for ergonomic access
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* not JSON after all — return raw string */
      }
    }
  }
  return output;
}

/** List all tools registered on the server. */
export async function listTools() {
  const response = await fetch(`${SERVER_URL}/api/tools`, { headers: headers() });
  const envelope = await response.json();
  if (!response.ok || envelope.success === false) {
    throw new Error(
      `@snaglet/sdk: failed to list tools: ${envelope?.error ?? `HTTP ${response.status}`}`
    );
  }
  return envelope.data;
}

/** Run a saved hook using real workspace ids, or directly as schedule:fire. */
export async function runHook(hookName, options = {}) {
  const response = await fetch(`${SERVER_URL}/api/hooks/${encodeURIComponent(hookName)}/run`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(options),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.success === false) {
    throw new Error(
      `@snaglet/sdk: hook run failed: ${envelope?.error?.message ?? envelope?.error ?? `HTTP ${response.status}`}`
    );
  }
  return envelope.data.runs;
}

function makeToolsProxy(forcedDry) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        // escape hatches: tools.$dry.foo() forces dry-run, tools.$real.foo() forces execution
        if (prop === '$dry') return makeToolsProxy(true);
        if (prop === '$real') return makeToolsProxy(false);
        if (prop === 'then') return undefined; // don't look like a thenable
        return (input = {}) =>
          callTool(prop, input, forcedDry === undefined ? {} : { dryRun: forcedDry });
      },
    }
  );
}

/**
 * tools — call any Snaglet tool as a method:
 *   await tools.create_doc({ title: 'Day 1', parent_id: '…' })
 */
export const tools = makeToolsProxy(undefined);

export const snaglet = {
  tools,
  hooks: { run: runHook },
  callTool,
  listTools,
  serverUrl: SERVER_URL,
  dryRun: DRY_RUN,
  /** Positional args passed after the script path on the snaglet run command line. */
  args: process.argv.slice(2),
};

export default snaglet;
