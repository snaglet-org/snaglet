/**
 * Snaglet-owned runtime source for the virtual `@snaglet/sdk` module used by workspace
 * tool and hook builds. esbuild loads this source from memory and embeds it in
 * the final executable; nothing is installed or copied into authored folders.
 *
 * Keep this in behavioral lockstep with `packages/snaglet-sdk/src/index.ts`.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { safeJsonParse } from '@snaglet/shared/utils';
import type { HookEventMap } from '@server/services/HookService';

/** Bare import specifier user tools use: `import snaglet from '@snaglet/sdk'`. */
export const SDK_SPECIFIER = '@snaglet/sdk';

/**
 * The author-facing hook events, as this server vendors them.
 *
 * MIRRORS the published contract in `packages/snaglet-sdk/src/index.ts`. It is a
 * mirror, not the single source — the SDK package ships to external authors
 * and cannot import server code, so the two tuples are kept equal by
 * `tests/unit/apps/server/services/tools/hookEventContract.test.ts` rather
 * than by the type system.
 *
 * Within the server this IS the one binding: it produces the vendored runtime
 * text below (so the compiled `@snaglet/sdk` a hook imports cannot disagree with
 * it) and backs `hook(op:create)`'s parameter enum.
 *
 * Deliberately a SUBSET of the server bus (`HookService.HookEventMap`, which
 * also carries credential/model/provider/tool administration events). The bus
 * is internal plumbing; this is the authoring surface, and the `satisfies`
 * clause fails the build if an entry here is not a real bus event. Widening it
 * exposes new event payloads to authored hook code — a product decision, not a
 * sync chore.
 */
export const HOOK_EVENT_NAMES = [
  'schedule:fire',
  'message:create',
  'thread:create',
  'run:end',
  'table_entry:create',
  'table_entry:update',
  'table_entry:delete',
  'table_entry:occurrence',
  'agent:create',
  'agent:update',
  'agent:delete',
  'doc:create',
  'doc:edit',
  'doc:move',
  'doc:rename',
  'container:create',
  'container:move',
  'container:update',
  'thread:move',
  'node:archive',
  'node:restore',
] as const satisfies readonly (keyof HookEventMap)[];

export type AuthoredHookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * Compiled, dependency-free `@snaglet/sdk`. Reads `SNAGLET_SERVER_URL` and
 * `SNAGLET_TOOL_CONTEXT_JSON` from the environment the ToolExecutor injects, exactly
 * like the real SDK. Authored as ESM; esbuild transpiles it when bundling a
 * saved tool or hook. The /execute/test sandbox writes it as is as the
 * `@snaglet/sdk` module for unsaved code, so Test gets the same SDK a deployed tool
 * does. It never holds a secret: everything it needs comes from the env.
 *
 * Authenticates back to the server with `SNAGLET_CHILD_DISPATCH_TOKEN` — the
 * narrow child-dispatch credential (see the server's
 * apps/server/src/middleware/panelAuth.ts credential-classes doc), injected
 * into this tool/hook's env by ToolExecutor.ts/hookRunner.ts (and by the
 * /execute/test route for its runner child). This is
 * deliberately not the full panel token: it is bound to the invoking agent, or
 * to the ghost system actor when a person runs the tool or an agentless event
 * runs the hook, and can only run a normal tool as that agent, under its
 * tool-access policy. The server takes the acting agent from the credential;
 * agent_id, forwarded below, must match it when sent. It has no act_as
 * impersonation authority and no access to /execute/test.
 */
export const SDK_RUNTIME_SOURCE = `
function getServerUrl() {
  const url = process.env.SNAGLET_SERVER_URL;
  if (!url) throw new Error('@snaglet/sdk: SNAGLET_SERVER_URL is not set');
  return url.replace(/\\/$/, '');
}

function readToolContext() {
  const raw = process.env.SNAGLET_TOOL_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function childDispatchAuthHeaders() {
  const token = process.env.SNAGLET_CHILD_DISPATCH_TOKEN;
  return token ? { 'X-Snaglet-Child-Dispatch-Token': token } : {};
}

async function serverFetch(p, body) {
  const url = getServerUrl() + p;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...childDispatchAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('Snaglet server returned ' + response.status + ': ' + text.slice(0, 500));
  }
  const json = await response.json();
  if (!json.success) throw new Error('Snaglet server returned unsuccessful response');
  return json.data;
}

export const snaglet = {
  async parseContent(nodeId) {
    const result = await serverFetch('/api/hooks/content/resolve', { nodeId });
    return result.content;
  },
  hooks: {
    async run(hookName, options = {}) {
      const result = await serverFetch('/api/hooks/' + encodeURIComponent(hookName) + '/run', options);
      return result.runs;
    },
  },
  async emit(name, data = null) {
    await serverFetch('/api/hooks/signal', { name, data });
  },
  tables: {
    async read(input = {}) {
      const result = await snaglet.tools.execute('table', { ...input, op: 'read' });
      if (!result.success) {
        throw new Error('table read failed: ' + (result.error ?? result.output));
      }
      const raw = result.rawContent && typeof result.rawContent === 'object' ? result.rawContent : {};
      return {
        rows: Array.isArray(raw.rows) ? raw.rows : [],
        fields: Array.isArray(raw.fields) ? raw.fields.filter((field) => typeof field === 'string') : [],
        text: result.output,
      };
    },
  },
  tools: {
    async execute(toolName, input = {}) {
      const agentId = readToolContext().agentId;
      return serverFetch('/api/tools/execute', {
        name: toolName,
        input,
        ...(agentId ? { agent_id: agentId } : {}),
      });
    },
  },
  context: {
    get() {
      return readToolContext();
    },
  },
  log: {
    async info(message) {
      await serverFetch('/api/tools/execute/log', { level: 'info', message }).catch(() => {});
    },
    async warn(message) {
      await serverFetch('/api/tools/execute/log', { level: 'warn', message }).catch(() => {});
    },
    async error(message) {
      await serverFetch('/api/tools/execute/log', { level: 'error', message }).catch(() => {});
    },
  },
};

export function defineHook(def) {
  return def;
}

export const HOOK_EVENT_NAMES = [
${HOOK_EVENT_NAMES.map((name) => `  '${name}',`).join('\n')}
];

export default snaglet;
`;

/** Changes whenever the embedded runtime changes; recorded beside each bundle. */
export const SDK_RUNTIME_HASH = createHash('sha256').update(SDK_RUNTIME_SOURCE).digest('hex');

/** Remove only the exact SDK copy older Snaglet builds vendored; never touch other dependencies. */
export async function removeLegacySdkCopy(authorDir: string): Promise<void> {
  const sdkDir = path.join(authorDir, 'node_modules', '@snaglet', 'sdk');
  try {
    const [entries, manifest] = await Promise.all([
      readdir(sdkDir),
      readFile(path.join(sdkDir, 'package.json'), 'utf-8'),
    ]);
    const parsed = safeJsonParse<{
      name?: unknown;
      version?: unknown;
      main?: unknown;
      types?: unknown;
    }>(manifest, {});
    if (
      entries.sort().join(',') !== 'index.d.ts,index.js,package.json' ||
      parsed.name !== '@snaglet/sdk' ||
      parsed.version !== '1.0.0' ||
      parsed.main !== 'index.js' ||
      parsed.types !== 'index.d.ts'
    )
      return;
    await rm(sdkDir, { recursive: true, force: true });
    for (const candidate of [
      path.join(authorDir, 'node_modules', '@snaglet'),
      path.join(authorDir, 'node_modules'),
    ]) {
      try {
        if ((await readdir(candidate)).length === 0) await rmdir(candidate);
      } catch {
        // Non-empty or already absent: preserve it.
      }
    }
  } catch {
    // Not a Snaglet-generated SDK copy.
  }
}

/** One shared declaration file supports editors under `<SNAGLET_HOME>/hooks`. */
export const SDK_TYPE_DECLARATIONS = `
export interface ToolExecuteResult { success: boolean; output: string; error?: string; durationMs: number; /** Structured data beside output, when the tool has any (a table row read: { rows, fields }). */ rawContent?: unknown; }
/** One value in a structured table row. */
export type TableReadCell = string | number | boolean | null;
/** One cell, or a list of them (multi-select, multiple relation, array column). */
export type TableReadValue = TableReadCell | TableReadCell[];
/** snaglet.tables.read: rows as objects (number fields are numbers, a number beyond 2^53 stays a string, checkboxes booleans, empty cells null, selects their labels, multi-valued fields lists, text/dates/ranges strings; entry reads start with id and rev, then every field), the row keys in order, and the same text table op read returns. rows/fields are empty for a { table } or {} read. */
export interface TableReadResult { rows: Record<string, TableReadValue>[]; fields: string[]; text: string; }
export interface ToolContext { agentId?: string; threadId?: string; triggerMessageId?: string; }
export interface HookEventPayloadMap {
  'schedule:fire': { scheduleId: string; runId: string; scheduledFor: string; agentId?: string; threadId?: string };
  'agent:create': { id: string; createdBy: { kind: 'agent' | 'user' | 'external' | 'system'; id?: string }; name?: string; role?: string | null; identity?: string | null; providerId?: string | null; modelId?: string | null; systemPrompt?: string | null; toolAccess?: { mode: string | null; allowList: string[] | null; denyList: string[] | null }; mcpServers?: string[] };
  'agent:update': { id: string; changed: string[] };
  'agent:delete': { id: string };
  'message:create': { id: string; threadId: string; role: 'user' | 'agent'; agentId?: string; text: string; chars?: number };
  'thread:create': { id: string; title?: string | null; createdBy: { kind: 'agent' | 'user' | 'external' | 'system'; id?: string }; agentId?: string; participants: Array<{ kind: 'agent' | 'user' | 'external'; id?: string; providerId?: string | null; modelId?: string | null; systemPromptAddendum?: string | null }>; systemPrompt?: string | null; dispatchMode?: string };
  'run:end': { runId: string; agentId?: string; threadId?: string; status: 'completed' | 'failed' | 'aborted' };
  'table_entry:create': { tableId: string; entryId: string };
  'table_entry:update': { tableId: string; entryId: string; changes: Array<{ field: string; from: unknown; to: unknown }> };
  'table_entry:delete': { tableId: string; entryIds: string[] };
  /** One occurrence of a repeating row acted on. occurrence, lastOccurrence, movedTo and current are local times without an offset, read with tz (IANA); current and ended describe the repeat after the write. A Skip to upcoming is one event with count N. */
  'table_entry:occurrence': { tableId: string; entryId: string; fieldId: string; entryName: string; action: 'done' | 'skipped' | 'moved' | 'shifted' | 'jumped' | 'undone'; occurrence: string; lastOccurrence: string; count: number; tz: string; movedTo: string | null; undoneAction: 'done' | 'skipped' | 'moved' | 'shifted' | 'jumped' | null; current: string | null; ended: boolean; logId: string | null; logIds: string[]; via: 'action' | 'status' | 'history'; actor: { kind: 'user' | 'agent' | 'external' | 'system'; id: string }; origin?: { kind: 'hook'; hookName: string } };
  /** fromContainerId / toContainerId are deprecated aliases equal to the project fields. */
  'thread:move': { id: string; fromProjectId: string | null; toProjectId: string | null; fromContainerId: string | null; toContainerId: string | null };
}
export type HookEventName = keyof HookEventPayloadMap;
export type HookEvent<E extends HookEventName = HookEventName> = { [K in HookEventName]: { type: K } & HookEventPayloadMap[K] }[E];
export type HookFilter<E extends HookEventName = HookEventName> = Partial<HookEventPayloadMap[E]>;
export interface HookRunOptions { nodeIds?: string | string[]; tableId?: string; entryId?: string; eventName?: HookEventName; event?: Record<string, unknown>; }
export interface HookRunResult { nodeId: string | null; eventName: string; event: Record<string, unknown>; result: { ok: boolean; exitCode: number | null; durationMs: number; stdout: string; stderr: string; timedOut: boolean; }; }
export type HookSchedule = { at: string } | { every: number; unit: 'minute' | 'hour' | 'day' | 'week'; anchor?: string } | { time: string; timezone: string; weekdays?: number[] };
export interface HookDefinition<E extends HookEventName = HookEventName> { on?: E | E[]; schedule?: HookSchedule[]; filter?: HookFilter<E>; /** @deprecated No-op, kept so existing hooks keep loading. Snaglet no longer refuses a hook for already appearing in its chain (A → B → A). The runs-per-minute limit still applies, and a hook still can't run itself synchronously with snaglet.hooks.run while it is running. */ repeatInChain?: boolean; run(event: HookEvent<E>): void | Promise<void>; }
export declare const snaglet: {
  parseContent(nodeId: string): Promise<string>;
  hooks: { run(hookName: string, options?: HookRunOptions): Promise<HookRunResult[]> };
  emit(name: string, data?: unknown): Promise<void>;
  /** Read a Database table with structured rows ({ sql }, { table, ids }, or { table, where?, sort?, columns?, page? }). Throws when the read fails. */
  tables: { read(input: Record<string, unknown>): Promise<TableReadResult> };
  tools: { execute(toolName: string, input?: Record<string, unknown>): Promise<ToolExecuteResult> };
  context: { get(): ToolContext };
  log: { info(message: string): Promise<void>; warn(message: string): Promise<void>; error(message: string): Promise<void> };
};
export declare const HOOK_EVENT_NAMES: readonly HookEventName[];
export declare function defineHook<E extends HookEventName>(definition: HookDefinition<E>): HookDefinition<E>;
export default snaglet;
`;
