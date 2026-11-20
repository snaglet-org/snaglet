/**
 * @snaglet/sdk — lightweight client for user-created tools to call back into the Snaglet server.
 *
 * User tools run as forked child processes. The SDK reads SNAGLET_SERVER_URL from the environment
 * (injected by the server when spawning the tool) and provides a simple async API for
 * executing internal tools, logging, and accessing context.
 */

export interface ToolExecuteResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  /**
   * Structured data a tool returns beside `output` for SDK callers, when it
   * has any (a `table` row read: `{ rows, fields }`, see `snaglet.tables.read`).
   */
  rawContent?: unknown;
}

/** One value in a structured table row. */
export type TableReadCell = string | number | boolean | null;

/**
 * A row value: one cell, or a list of them for a multi-select, a multiple
 * relation or an array column.
 */
export type TableReadValue = TableReadCell | TableReadCell[];

/**
 * What `snaglet.tables.read` returns. `rows` and `fields` are filled for row reads
 * (`{ sql }`, `{ table, ids }`, and `{ table, where?, sort?, columns?, page? }`);
 * a table's field list (`{ table }`) or the table list (`{}`) is `text` only.
 *
 * Values: a number field or numeric column is a `number`, a checkbox a
 * `boolean`, an empty cell `null`, a select its label, a multi-select or a
 * multiple relation a list, and text, dates, date-times and ranges the
 * string `text` shows. A number beyond 2^53 stays its string. An entry
 * read's rows start with `id` and `rev` (the short revision a guarded `table`
 * write takes), then every field, `null` when the row has no value.
 */
export interface TableReadResult {
  rows: Record<string, TableReadValue>[];
  /** Row keys in order: a query's columns, or `id`, `rev` and the field names. */
  fields: string[];
  /** Exactly what `snaglet.tools.execute('table', { op: 'read', ... }).output` returns. */
  text: string;
}

export interface ToolContext {
  agentId?: string;
  threadId?: string;
  triggerMessageId?: string;
}

// Lifecycle hooks
//
// A user drops `<snaglet-home>/hooks/<name>/hook.ts` that default-exports
// `defineHook({ on?, schedule?, filter?, run })`. The folder name is the hook's
// identity; the code declares lifecycle and time triggers. Hooks are observers:
// they run async, fire-and-forget, in a child process, with a per-hook timeout —
// a hook that throws or hangs never affects the server or the message flow.

/**
 * Payload delivered for each lifecycle event. The `run(event)` handler receives
 * the payload tagged with a `type` discriminant (see `HookEvent`). Keep this in
 * lockstep with the server's `HookService` HookEventMap — these are the wire
 * shapes emitted onto the internal bus.
 */
export interface HookEventPayloadMap {
  /** A persistent Snaglet schedule became due. */
  'schedule:fire': {
    scheduleId: string;
    runId: string;
    scheduledFor: string;
    agentId?: string;
    threadId?: string;
  };
  /**
   * An agent was created. Carries the agent's full configuration: identity,
   * role, provider/model, system prompt, tool-access situation (mode +
   * allow/deny lists), and connected MCP server ids.
   */
  'agent:create': {
    id: string;
    name?: string;
    role?: string | null;
    identity?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    systemPrompt?: string | null;
    toolAccess?: {
      mode: string | null;
      allowList: string[] | null;
      denyList: string[] | null;
    };
    mcpServers?: string[];
  };
  /** An agent changed; `changed` names the updated fields. */
  'agent:update': { id: string; changed: string[] };
  /** An agent was permanently deleted. */
  'agent:delete': { id: string };
  /**
   * An agent (or user) message row was persisted. `role: 'agent'` = spoken by
   * an agent. `text` is the message content, verbatim. `chars` is the optional
   * persisted-content length supplied by emitters that already compute it.
   */
  'message:create': {
    id: string;
    threadId: string;
    role: 'user' | 'agent';
    agentId?: string;
    text: string;
    chars?: number;
  };
  /**
   * A new thread was created. `createdBy` is the creating actor (an agent
   * via tools, the user via the app). `participants` is the roster at
   * creation time — agent entries carry their effective model (thread
   * override, else the agent's own config) and any per-thread
   * system-prompt addendum. `agentId` remains the first agent participant
   * for cheap equality filters.
   */
  'thread:create': {
    id: string;
    title?: string | null;
    createdBy: { kind: 'agent' | 'user' | 'external' | 'system'; id?: string };
    agentId?: string;
    participants: Array<{
      kind: 'agent' | 'user' | 'external';
      id?: string;
      providerId?: string | null;
      modelId?: string | null;
      systemPromptAddendum?: string | null;
    }>;
    systemPrompt?: string | null;
    dispatchMode?: string;
  };
  /** An agent run finished (completed, failed, or aborted). */
  'run:end': {
    runId: string;
    agentId?: string;
    threadId?: string;
    status: 'completed' | 'failed' | 'aborted';
  };
  /**
   * A row was added to a Database table. A task is a table row, so these
   * three events are how a hook observes task lifecycle; the row's fields
   * (a `select` for status, a `date` for due, a `relation` for assignee) are
   * whatever the table defines.
   */
  'table_entry:create': { tableId: string; entryId: string; origin?: HookEventOrigin };
  /**
   * A row's values changed. `changes` lists only the fields whose wire value
   * differs: `field` is the field key as the entry's `values` are keyed, and
   * `from`/`to` are the wire values before and after (a status change is one
   * entry here with the old and new option id).
   */
  'table_entry:update': {
    tableId: string;
    entryId: string;
    changes: Array<{ field: string; from: unknown; to: unknown }>;
    origin?: HookEventOrigin;
  };
  /** Rows were deleted from a table, together or not at all. */
  'table_entry:delete': { tableId: string; entryIds: string[]; origin?: HookEventOrigin };
  /**
   * One occurrence of a repeating row was acted on: "Water plants was done
   * for Oct 15". One event per action, sent after the write committed: a
   * Skip to upcoming is one event with `count` N; a status set to done sends
   * its `table_entry:update` first, then this.
   *
   * Formats: `occurrence`, `lastOccurrence`, `movedTo` and `current` are
   * local times without an offset (`YYYY-MM-DD` for a date field,
   * `YYYY-MM-DDTHH:MM:SS` for a date and time), read with `tz` (an IANA
   * zone). `current` and `ended` describe
   * the repeat after the write. `entryName` is the only row value carried:
   * read other fields with a tool call.
   */
  'table_entry:occurrence': TableEntryOccurrenceEvent;
  'doc:create': {
    id: string;
    title: string;
    parentContainerId: string | null;
    createdBy: string | null;
    origin?: HookEventOrigin;
  };
  'doc:edit': {
    id: string;
    editor: string | null;
    charsDelta: number;
    backupSnapshotId: string | null;
    origin?: HookEventOrigin;
  };
  'doc:move': {
    id: string;
    fromContainerId: string | null;
    toContainerId: string | null;
    origin?: HookEventOrigin;
  };
  'doc:rename': { id: string; oldTitle: string; newTitle: string; origin?: HookEventOrigin };
  'container:create': {
    id: string;
    name: string;
    category: string | null;
    parentId: string | null;
    origin?: HookEventOrigin;
  };
  'container:move': {
    id: string;
    fromParentId: string | null;
    toParentId: string | null;
    origin?: HookEventOrigin;
  };
  'container:update': { id: string; changed: string[]; origin?: HookEventOrigin };
  'thread:move': {
    id: string;
    /** Project the thread left (null = it was flat at workspace level). */
    fromProjectId: string | null;
    /** Project the thread joined (null = now flat). */
    toProjectId: string | null;
    /** @deprecated Equals fromProjectId; threads are not placed in containers. */
    fromContainerId: string | null;
    /** @deprecated Equals toProjectId. */
    toContainerId: string | null;
    origin?: HookEventOrigin;
  };
  'node:archive': NodeCohortEvent;
  'node:restore': NodeCohortEvent;
}

export interface HookEventOrigin {
  kind: 'hook';
  hookName: string;
}

/** What happened to a repeating row's occurrence. */
export type TableEntryOccurrenceAction =
  | 'done'
  | 'skipped'
  | 'moved'
  | 'shifted'
  | 'jumped'
  | 'undone';

/** The `table_entry:occurrence` payload (see `HookEventPayloadMap`). */
export interface TableEntryOccurrenceEvent {
  tableId: string;
  entryId: string;
  /** The repeating date field. */
  fieldId: string;
  /** The row's name ('' when it has none). */
  entryName: string;
  /**
   * done / skipped: a set day done or skipped; moved: one occurrence moved;
   * shifted: every upcoming one moved; jumped: an interval jumped to now
   * (nothing logged); undone: one of those taken back (see `undoneAction`).
   */
  action: TableEntryOccurrenceAction;
  /** The occurrence acted on, local time in `tz` (a period's first day; the first skipped for a Skip to upcoming). */
  occurrence: string;
  /** The last occurrence covered, local time in `tz`: `occurrence` unless `count` > 1. */
  lastOccurrence: string;
  /** Occurrences covered: 1, or N for one Skip to upcoming (and its undo). */
  count: number;
  /** IANA zone the local times are in. */
  tz: string;
  /** Local time in `tz`. moved: where it went (its own slot when moved back); shifted: where `occurrence` went; else null. */
  movedTo: string | null;
  /** undone: the action taken back; else null. */
  undoneAction: Exclude<TableEntryOccurrenceAction, 'undone'> | null;
  /** After the write: the occurrence the row is on (local time in `tz`), or null when it no longer repeats. */
  current: string | null;
  /** After the write: whether the series has ended (its last occurrence is done or skipped). */
  ended: boolean;
  /** The occurrence log row; the first of `logIds`; null when none was logged (shifted, jumped, a move back to its slot). */
  logId: string | null;
  /** Every log row covered, in order (N for a Skip to upcoming). */
  logIds: string[];
  /** action: a repeat action (row, calendar, agent, API); status: a status set to done; history: an undo or redo. */
  via: 'action' | 'status' | 'history';
  /** Who did it. */
  actor: { kind: 'user' | 'agent' | 'external' | 'system'; id: string };
  origin?: HookEventOrigin;
}
export interface NodeCohortEvent {
  rootId: string;
  rootKind: string;
  cohortIds: string[];
  count: number;
  archivedBy: string | null;
  origin?: HookEventOrigin;
}

/**
 * Every event a hook can observe, as a runtime-enumerable tuple: the source
 * consumers (e.g. the desktop hook builder's trigger picker) derive event
 * names from. `HookEventName` erases at runtime, so this tuple is what
 * ships; the type-level assertion right after it fails `tsc` the moment this
 * list and `HookEventPayloadMap`'s keys diverge.
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
] as const;

/** Every event a hook can observe. */
export type HookEventName = keyof HookEventPayloadMap;

// Compile-time-only check (never emits a runtime value): fails to typecheck
// if `HOOK_EVENT_NAMES` and `HookEventPayloadMap`'s keys ever disagree in
// either direction, so a new/removed lifecycle event can't ship without this
// tuple being updated in lockstep.
type _AssertHookEventNamesInSyncWithMap = [(typeof HOOK_EVENT_NAMES)[number]] extends [
  HookEventName,
]
  ? [HookEventName] extends [(typeof HOOK_EVENT_NAMES)[number]]
    ? true
    : ['HOOK_EVENT_NAMES is missing an event that HookEventPayloadMap declares']
  : ['HOOK_EVENT_NAMES has an event that HookEventPayloadMap does not declare'];
const _hookEventNamesInSync: _AssertHookEventNamesInSyncWithMap =
  true as _AssertHookEventNamesInSyncWithMap;
void _hookEventNamesInSync;

/** The raw payload for a single event, before it is tagged with its `type`. */
export type HookEventPayload<E extends HookEventName = HookEventName> = HookEventPayloadMap[E];

/**
 * The object a hook's `run(event)` receives: the event's payload tagged with a
 * `type` discriminant so a hook subscribed to several events can switch on it.
 */
export type HookEvent<E extends HookEventName = HookEventName> = {
  [K in HookEventName]: { type: K } & HookEventPayloadMap[K];
}[E];

/**
 * Optional server-side pre-filter: a partial payload match. The hook only runs
 * when every provided field strictly equals the event's field — e.g.
 * `{ role: 'agent' }` on `message:create` skips user messages before spawning.
 */
export type HookFilter<E extends HookEventName = HookEventName> = Partial<HookEventPayloadMap[E]>;

export type HookSchedule =
  | { at: string }
  | { every: number; unit: 'minute' | 'hour' | 'day' | 'week'; anchor?: string }
  | { time: string; timezone: string; weekdays?: number[] };

export interface HookRunOptions {
  nodeIds?: string | string[];
  /** table_entry:* events: the Database table and the entry in it to resolve. */
  tableId?: string;
  entryId?: string;
  eventName?: HookEventName;
  event?: Record<string, unknown>;
}

export interface HookRunResult {
  nodeId: string | null;
  eventName: string;
  event: Record<string, unknown>;
  result: {
    ok: boolean;
    exitCode: number | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  };
}

export interface HookDefinition<E extends HookEventName = HookEventName> {
  /** One event name or an array of them. */
  on?: E | E[];
  /** Durable time triggers owned by this hook file. */
  schedule?: HookSchedule[];
  /** Optional pre-filter — see `HookFilter`. */
  filter?: HookFilter<E>;
  /**
   * @deprecated No-op, accepted so existing hooks keep loading. Snaglet does not
   * refuse a hook for already appearing in its chain (A → B → A, or a hook
   * whose own write triggers it again), so there is nothing to opt out of.
   * The runs-per-minute cap (`workers.hooks_max_runs_per_minute`, default 600)
   * still applies, and a hook still can't run itself synchronously with
   * `snaglet.hooks.run` while it is running.
   */
  repeatInChain?: boolean;
  /** User code. Full `@snaglet/sdk` (`snaglet.tools.execute`, `snaglet.context.get`, `snaglet.log`) is available. */
  run(event: HookEvent<E>): void | Promise<void>;
}

/**
 * Declare a lifecycle hook. Identity function — it exists so authors get full
 * type inference on `run(event)` from the `on` they pick, and so the server can
 * recognize a folder's default export as a hook definition.
 *
 * @example
 * import { defineHook, snaglet } from '@snaglet/sdk';
 * export default defineHook({
 *   on: 'message:create',
 *   schedule: [{ every: 1, unit: 'hour' }],
 *   filter: { role: 'agent' },
 *   async run(event) {
 *     await snaglet.tools.execute('memory', { op: 'create', content: event.id });
 *   },
 * });
 */
export function defineHook<E extends HookEventName>(def: HookDefinition<E>): HookDefinition<E> {
  return def;
}

function getServerUrl(): string {
  const url = process.env.SNAGLET_SERVER_URL;
  if (!url) throw new Error('@snaglet/sdk: SNAGLET_SERVER_URL is not set');
  return url.replace(/\/$/, '');
}

/** Read the tool-invocation context the server injected via SNAGLET_TOOL_CONTEXT_JSON. */
function readToolContext(): ToolContext {
  const raw = process.env.SNAGLET_TOOL_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ToolContext;
  } catch {
    return {};
  }
}

/**
 * Server-spawned callers (workspace/custom tools, hooks) get the narrow
 * child-dispatch credential via SNAGLET_CHILD_DISPATCH_TOKEN (see the server's
 * panelAuth.ts credential-classes doc). It is deliberately not the full
 * panel token: it can only run a normal tool as the invoking agent (agentId,
 * forwarded below, is required server-side) and grants no act_as
 * impersonation authority and no access to /execute/test. Absent (e.g. no
 * token configured) means no header is sent.
 *
 * Keep this in lockstep with the server's virtual build module,
 * apps/server/src/services/ToolService/customTools/vendorSdk.ts
 * (SDK_RUNTIME_SOURCE) — that source is embedded into
 * real workspace tools and hooks; see its own header comment.
 */
function childDispatchAuthHeaders(): Record<string, string> {
  const token = process.env.SNAGLET_CHILD_DISPATCH_TOKEN;
  return token ? { 'X-Snaglet-Child-Dispatch-Token': token } : {};
}

async function serverFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const url = `${getServerUrl()}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...childDispatchAuthHeaders() },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Snaglet server returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as { data: T; success: boolean };
  if (!json.success) {
    throw new Error(`Snaglet server returned unsuccessful response`);
  }
  return json.data;
}

export const snaglet = {
  /**
   * Resolve a live Snaglet node into text when this tool/hook runs. The returned
   * value is never cached: edits made after the hook was saved are visible on
   * its next run.
   */
  async parseContent(nodeId: string): Promise<string> {
    const result = await serverFetch<{ content: string }>('/api/hooks/content/resolve', {
      nodeId,
    });
    return result.content;
  },
  hooks: {
    /**
     * Run a saved hook from real workspace ids, or directly as schedule:fire.
     * The run joins this hook's chain: a run the chain limits refuse (too
     * deep, already in the chain, itself, over its per-minute budget, or no
     * free slot) comes back with `result.ok === false` and the reason in
     * `result.stderr`.
     */
    async run(hookName: string, options: HookRunOptions = {}): Promise<HookRunResult[]> {
      const result = await serverFetch<{ runs: HookRunResult[] }>(
        `/api/hooks/${encodeURIComponent(hookName)}/run`,
        options as Record<string, unknown>
      );
      return result.runs;
    },
  },
  /**
   * Emit a custom signal. Hooks with a matching signal trigger run
   * next, one chain-depth hop deeper than this run. `name` is lowercase
   * letters, digits, `.`, `_` or `-` (max 64); `data` must be JSON, ≤ 16 KB.
   */
  async emit(name: string, data: unknown = null): Promise<void> {
    await serverFetch('/api/hooks/signal', { name, data });
  },
  tables: {
    /**
     * Read a Database table with structured rows: the input is a `table`
     * read's (`{ sql }`, `{ table, ids }`, `{ table, where, sort, columns,
     * page }`), and the result carries the rows as objects beside the same
     * text `snaglet.tools.execute` returns. Throws when the read fails.
     *
     * @example
     * const { rows } = await snaglet.tables.read({
     *   sql: "SELECT phase, status FROM user_tables.work_loop WHERE phase = 2",
     * });
     * if (rows.length && rows.every((row) => row.status === 'Done')) {
     *   // phase 2 is done
     * }
     */
    async read(input: Record<string, unknown>): Promise<TableReadResult> {
      const result = await snaglet.tools.execute('table', { ...input, op: 'read' });
      if (!result.success) {
        throw new Error(`table read failed: ${result.error ?? result.output}`);
      }
      return { ...tableReadData(result.rawContent), text: result.output };
    },
  },
  tools: {
    /**
     * Execute an internal Snaglet tool by name.
     *
     * @example
     * const result = await snaglet.tools.execute('database_query', { sql: 'SELECT 1' });
     * console.log(result.output);
     */
    async execute(
      toolName: string,
      input: Record<string, unknown> = {}
    ): Promise<ToolExecuteResult> {
      // Forward the invoking agent's id so the server can apply that agent's
      // tool-access policy to nested calls — otherwise a custom tool would be an
      // unguarded escape hatch around the dispatch-layer permission checks.
      const agentId = readToolContext().agentId;
      return serverFetch<ToolExecuteResult>('/api/tools/execute', {
        name: toolName,
        input,
        ...(agentId ? { agent_id: agentId } : {}),
      });
    },
  },

  context: {
    /** Returns the context passed to this tool invocation (agent id, thread id, etc). */
    get(): ToolContext {
      return readToolContext();
    },
  },

  log: {
    /** Send a log message back to the Snaglet server for visibility in the tool run output. */
    async info(message: string): Promise<void> {
      await serverFetch('/api/tools/execute/log', { level: 'info', message }).catch(
        reportLogDeliveryFailure
      );
    },
    async warn(message: string): Promise<void> {
      await serverFetch('/api/tools/execute/log', { level: 'warn', message }).catch(
        reportLogDeliveryFailure
      );
    },
    async error(message: string): Promise<void> {
      await serverFetch('/api/tools/execute/log', { level: 'error', message }).catch(
        reportLogDeliveryFailure
      );
    },
  },
};

/** The `{ rows, fields }` a row read carries, or empty ones (a text-only read). */
function tableReadData(raw: unknown): Pick<TableReadResult, 'rows' | 'fields'> {
  if (!raw || typeof raw !== 'object') return { rows: [], fields: [] };
  const { rows, fields } = raw as { rows?: unknown; fields?: unknown };
  return {
    rows: Array.isArray(rows) ? (rows as TableReadResult['rows']) : [],
    fields: Array.isArray(fields)
      ? fields.filter((field): field is string => typeof field === 'string')
      : [],
  };
}

/** A log line that can't reach the server still surfaces on the tool's own stderr. */
function reportLogDeliveryFailure(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[snaglet-sdk] failed to deliver log to Snaglet server: ${detail}`);
}

export default snaglet;
