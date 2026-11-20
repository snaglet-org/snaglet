/**
 * mcpProjection: the one mapping between Snaglet's internal tool registry and the
 * external MCP surface (/mcp). Names carry the `snaglet_` prefix at the boundary
 * only (`search` -> `snaglet_search`). tools/list is built from the same registry:
 * the definition's description plus external guidance, and its
 * parameters_schema (plus EXTERNAL_PUBLISHED_PARAMS) cut down to what an
 * external caller may use: the curated ops in the op enum, the params in
 * EXTERNAL_OP_PARAMS, the values in EXTERNAL_ENUM_VALUES. The gateway refuses
 * anything outside that shape with a short error (externalArgsError), so the
 * schema itself says what is unavailable and the guidance only says what a
 * schema cannot (no ambient thread, attribution, own-only writes).
 *
 * Only a curated tier is exposed: to a guest Snaglet is a workspace, not a computer,
 * so computer, discovery, unrestricted agent-management and admin/db tools are
 * never listed. memory_recall is excluded because memories are keyed by
 * agents.id and external members have no agent row.
 *
 * Pure (no DB, no I/O, definitions passed in) so it can be unit-tested alone.
 */

import type { ToolDefinition } from '@server/services/ToolService/types';
import { resolveToolId, type ResolvedToolId } from '@snaglet/shared/utils';

export const MCP_TOOL_PREFIX = 'snaglet_';

/**
 * The curated external tier. Order is the presentation order
 * in tools/list. Anything not in this list does not exist externally.
 */
export const CURATED_TOOL_IDS: readonly string[] = [
  // agent(op): curated to abort/create/get/list/update via CURATED_TOOL_OPS
  // (get and list return the slim roster; update takes the fields in
  // EXTERNAL_OP_PARAMS; no archive, restore or activity).
  'agent',
  // orchestration
  // thread(op): curated to send/read/create/update/add_agents via
  // CURATED_TOOL_OPS (the alias id snaglet_thread_send resolves to op send).
  'thread',
  // model(op): curated to list only (no add).
  'model',
  // search
  'search',
  // read (node tree/get are the pull-orientation door)
  // doc(op): curated to get/create/update via CURATED_TOOL_OPS (no delete).
  'doc',
  // node(op): curated to get/tree/move via CURATED_TOOL_OPS (no rename,
  // archive or restore).
  'node',
  // write (create_image stays app-local)
  // container(op): curated to create/update via CURATED_TOOL_OPS. Project
  // folders and GitHub links are left out of EXTERNAL_OP_PARAMS, so the
  // gateway refuses them under every name after alias resolution.
  'container',
  // table(op): read, write and schema via CURATED_TOOL_OPS; delete (entries)
  // is not curated, and the gateway runs only the schema ops in
  // EXTERNAL_TABLE_SCHEMA_OPS.allowed. Custom tables only, as for agents.
  'table',
  // calendar(op): every op but delete_event. Its table rows and
  // automation wakes follow table and automation exposure: the calendar
  // derives an external caller's access from this curation
  // (externalCalendarAccess).
  'calendar',
  // automation(op): reads for any automation; writes only for the
  // ones this key's member created (McpGatewayService).
  'automation',
  // export_node is projected for node kinds only (EXTERNAL_ENUM_VALUES). Its
  // `own_memories` kind binds to the calling agent's id from tool context, and
  // an external member has no agent row (the same reason the memory tool is
  // not curated); the handler also refuses it for an external actor.
  'export_node',
];

/**
 * Per-tool guidance appended to the internal description for external
 * callers: only what the schema cannot say. What an external caller may not
 * use is left out of its schema (externalInputSchema), not described here.
 * External clients get no ambient thread/project context; orientation is
 * pulled, so the guidance teaches that pattern explicitly.
 */
const EXTERNAL_GUIDANCE: Record<string, string> = {
  thread:
    'No ambient thread: pass an explicit thread id for send, read, update and add_agents. ' +
    'create: pass project_id explicitly, a project container id (find one with snaglet_node ' +
    'op:tree, flagged 🗂️ project) or null for a flat workspace thread. What you send and ' +
    'change is attributed to your MCP member.',
  export_node:
    'Writes a file onto the Snaglet machine, so `dest_dir` must be an absolute path to a folder that ' +
    'already exists there and is outside Snaglet storage. Existing files are never overwritten: expect ' +
    'a " (2)" suffix and report the returned `path`, not the name you requested.',
  agent:
    'abort: pass explicit thread_id and agent_id; your MCP member is recorded as the aborting ' +
    'actor. New agents get the creation-time confirmation defaults for guarded ' +
    'shell/file/git/destructive tools and no credential or MCP-server assignment. get and list ' +
    'return the slim roster.',
  model: 'Returns safe provider/model metadata; provider secrets are never returned.',
  node: 'No ambient context: call op tree first to orient yourself, then pass explicit ids.',
  search:
    'There is no ambient thread or project: pass scope and project parameters explicitly. ' +
    'kind:"files" needs `project_id` (find one with snaglet_node op:tree) and searches only the ' +
    'semantic index: an unindexed project returns an honest empty set, and `path` must stay ' +
    'inside the project folder. kind:"code" needs `project_id` (with an optional `path` relative ' +
    'to its folder) or an absolute `path` inside a linked project folder; symlinks are resolved ' +
    'and the search stays inside the linked project folders.',
  doc:
    'External callers expose op get, outline, create, update and convert-to-container only. Read a doc ' +
    'with op get (there is no op read). create: there is no ' +
    'ambient thread, so pass `parent_id` or `parent_path` explicitly (otherwise the doc lands at ' +
    'the workspace root).',
  table: 'write is recorded as your MCP member and is one step a person can undo.',
  calendar:
    'Table rows and automation wakes follow what snaglet_table and snaglet_automation expose to you. ' +
    'Pass explicit dates or a range and a tz: there is no ambient context. set_reminders on ' +
    'an automation works only on automations your MCP member created.',
  automation:
    'There is no ambient thread or agent, so create needs explicit `thread_id` and `agent_id` ' +
    '(the agent must be in that thread); the automation is recorded as created by your MCP ' +
    'member. list, get and runs read any automation; update, disable, enable, cancel and run ' +
    'work only on automations your MCP member created. MCP clients have the agent limits: the ' +
    'agent floor for every (15m by default, 5m with a daily window of at most 2h: window_start ' +
    'and window_end) and the per-hour cap on run.',
  container:
    'create: there is no ambient thread, so pass `parent_id` or `parent_path` explicitly ' +
    '(otherwise the container lands at the workspace root). Project folders and GitHub links are ' +
    'set in the Snaglet app.',
};

/** External MCP tool shape (subset of the MCP Tool type — SDK-agnostic). */
export interface McpToolProjection {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Per-op curation for `tool(op)` tools. The curated tier is per-tool, so
 * curating `thread` must not silently expose `thread(op:'delete')`. A
 * canonical id listed here exposes only the listed ops, both via its own name
 * and via any old-id alias. Tools absent from this map are op-unrestricted.
 */
export const CURATED_TOOL_OPS: Readonly<Record<string, readonly string[]>> = {
  // add_agents adds agents; remove_agents, leave and delete stay app-local.
  thread: ['send', 'read', 'create', 'update', 'add_agents'],
  // No rename, verify_ids, archive or restore.
  node: ['get', 'tree', 'move'],
  // No delete.
  doc: ['get', 'outline', 'create', 'update', 'convert-to-container'],
  container: ['create', 'update'],
  // get is always the roster (McpGatewayService sets listAll), list is that
  // roster, and update takes only the fields in EXTERNAL_OP_PARAMS.
  agent: ['abort', 'create', 'get', 'list', 'update'],
  // No add.
  model: ['list'],
  // No delete (entries); McpGatewayService runs only the schema ops in
  // EXTERNAL_TABLE_SCHEMA_OPS.allowed.
  table: ['read', 'write', 'schema'],
  // Every op but delete_event (the tool's one confirm-gated op).
  calendar: [
    'list',
    'query',
    'focus',
    'dates',
    'get_event',
    'get_reminders',
    'create_calendar',
    'create_event',
    'update_event',
    'restore_event',
    'move_occurrence',
    'complete_occurrence',
    'skip_occurrence',
    'set_reminders',
  ],
  // Every op; writes are own-only (created_by_member_id) in McpGatewayService.
  automation: ['create', 'list', 'get', 'update', 'disable', 'enable', 'cancel', 'run', 'runs'],
};

/**
 * table schema ops: the gateway runs only the `allowed` ones for an
 * external caller (an allow list, so an op added to the schema tool later is
 * refused until someone classifies it here). `denied` names the ones that
 * stay app-local; a drift test keeps allowed ∪ denied equal to the schema
 * tool's ops (SCHEMA_OP_KEYS). Creating a table (`fields`) is not an op and
 * stays open.
 */
export const EXTERNAL_TABLE_SCHEMA_OPS = {
  allowed: [
    'add_field',
    'update_field',
    'reorder_fields',
    'rename_table',
    'set_title_field',
    'restore_field',
    'restore_table',
    'set_project',
  ],
  denied: ['archive_field', 'delete_field', 'archive_table', 'delete_table'],
} as const;

/**
 * automation ops: `open` ones work on any automation; every other
 * op, including one added later, works only on automations the key's member
 * created (own-only is the default). A drift test keeps open ∪ ownOnly equal
 * to the tool's op enum.
 */
export const EXTERNAL_AUTOMATION_OPS = {
  open: ['create', 'list', 'get', 'runs'],
  ownOnly: ['update', 'disable', 'enable', 'cancel', 'run'],
} as const;

/**
 * The curation an external caller's calendar access is derived from: the
 * curated tier, its per-op map, and the automation ops open to every
 * automation (any other op is own-only). Defaults to the lists above; a
 * test passes a narrowed one.
 */
export interface ExternalCuration {
  curatedIds: readonly string[];
  curatedOps: Readonly<Record<string, readonly string[]>>;
  automationOps: { readonly open: readonly string[] };
}

/** What the calendar may hand an external caller (externalCalendarAccess). */
export interface ExternalCalendarAccess {
  /** Table rows: query, list's bound fields, reminders on a row. */
  tableRead: boolean;
  /** move_occurrence, complete_occurrence, skip_occurrence on a table row. */
  tableWrite: boolean;
  /** Automation wakes and Every lines in query, reminders on an automation. */
  automationRead: boolean;
  /** set_reminders on an automation: on any, only on the key's member's own, or none. */
  automationWrite: 'any' | 'own' | 'none';
}

/** The automation op that reads every schedule (the calendar's wakes). */
const AUTOMATION_READ_OP = 'list';
/** The automation op a calendar change to an automation (set_reminders) counts as. */
const AUTOMATION_WRITE_OP = 'update';

/**
 * An external caller's calendar access, derived from the curation.
 * The calendar shows things the table and automation tools own,
 * so an external caller gets what those tools are curated to give, not a
 * person's full access: table rows need `table` op read and the occurrence
 * writes op write; wakes and reminders on an automation need `automation`
 * op list, open to every automation; set_reminders on an automation counts
 * as an `automation` update, so it is own-only while update is. Narrowing
 * table or automation narrows the calendar with it.
 */
export function externalCalendarAccess(
  curation: Partial<ExternalCuration> = {}
): ExternalCalendarAccess {
  const curatedIds = curation.curatedIds ?? CURATED_TOOL_IDS;
  const curatedOps = curation.curatedOps ?? CURATED_TOOL_OPS;
  const automationOps: ExternalCuration['automationOps'] =
    curation.automationOps ?? EXTERNAL_AUTOMATION_OPS;
  const exposed = (toolId: string, op: string) =>
    curatedIds.includes(toolId) && isExternalOpAllowed(toolId, op, curatedOps);
  const open = (op: string) => automationOps.open.includes(op);
  return {
    tableRead: exposed('table', 'read'),
    tableWrite: exposed('table', 'write'),
    automationRead: exposed('automation', AUTOMATION_READ_OP) && open(AUTOMATION_READ_OP),
    automationWrite: !exposed('automation', AUTOMATION_WRITE_OP)
      ? 'none'
      : open(AUTOMATION_WRITE_OP)
        ? 'any'
        : 'own',
  };
}

/**
 * Unlisted params a tool publishes in its external inputSchema, because an
 * external caller must pass them, or would otherwise lose discovery of them:
 * external clients have no tool(op:schema) (not curated), so an unlisted field
 * they can use must be published here. The in-app schema is unchanged.
 * `'all'` publishes every unlisted param: the tool's fields are unlisted
 * in-app only to save agent tokens, so the external schema stays whole.
 * - automation: create has no ambient thread or agent.
 * - search: only the fields unlisted to save tokens; the older unlisted
 *   ones (database, graph and recent-list fields) stay app-local.
 * - thread: the admin fields are unlisted in-app only to save agent tokens;
 *   update is made entirely of `thread`.
 */
const EXTERNAL_PUBLISHED_PARAMS: Readonly<Record<string, readonly string[] | 'all'>> = {
  agent: 'all',
  automation: 'all',
  calendar: 'all',
  doc: 'all',
  node: 'all',
  search: [
    'include_archived',
    'container_id',
    'name',
    'scope_files',
    'project_id',
    'code_mode',
    'glob',
  ],
  table: 'all',
  thread: ['thread', 'system_prompt'],
};

/**
 * Per op, the params an external caller may send (`op` itself is implicit).
 * The published inputSchema keeps only these properties, and the gateway
 * refuses any other param before the tool runs (externalArgsError). A dotted
 * entry (`thread.title`) allows one field of an object param; its other
 * fields are dropped from the schema and refused. An allow list, so a param
 * added to a tool later stays app-local until it is listed here. Keys are the
 * tool's curated ops (CURATED_TOOL_OPS; a drift test keeps them equal), or ''
 * for a tool without ops. A tool absent here is not narrowed by param.
 * - agent get: the slim roster only (the gateway sets listAll).
 * - thread: no impersonation (sender_agent_id, initial_message), no tool
 *   access changes; removing agents is not curated.
 * - container: project folders and GitHub links are set in the app.
 * - doc: the five curated ops with their own fields; `raw` reads or edits the
 *   stored source, and outline lists headings.
 */
export const EXTERNAL_OP_PARAMS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  agent: {
    abort: ['agent_id', 'thread_id'],
    create: [
      'name',
      'role',
      'system_prompt',
      'identity',
      'provider',
      'model_id',
      'tool_access_mode',
    ],
    get: ['listAll'],
    list: ['include_archived'],
    update: ['agent_id', 'scope', 'name', 'role', 'identity', 'provider', 'model_id'],
  },
  thread: {
    send: ['id', 'content'],
    read: ['id', 'mode', 'message_id', 'limit', 'before', 'after'],
    create: ['title', 'project_id', 'dispatch_mode', 'agent_ids', 'system_prompt'],
    update: [
      'id',
      'thread.title',
      'thread.project_id',
      'thread.dispatch_mode',
      'thread.system_prompt',
      'thread.max_waves',
      'thread.max_total_output_tokens',
      'thread.max_agent_dispatches',
      'thread.working_directory',
    ],
    add_agents: ['id', 'agent_ids'],
  },
  doc: {
    get: ['id', 'path', 'raw', 'include_archived'],
    outline: ['id', 'path', 'include_archived'],
    create: ['title', 'content', 'parent_id', 'parent_path', 'sort_order'],
    update: ['id', 'path', 'edits', 'raw', 'validate_only', 'create_backup', 'allow_archived'],
    'convert-to-container': ['id', 'path', 'category'],
  },
  model: { list: ['operation', 'provider_id'] },
  node: {
    get: ['id', 'include_children', 'include_archived'],
    tree: ['id', 'path', 'name', 'kinds'],
    move: ['id', 'path', 'parent_id', 'parent_path', 'sort_order', 'kind', 'allow_archived'],
  },
  container: {
    create: ['name', 'parent_id', 'parent_path', 'category', 'sort_order'],
    update: ['id', 'path', 'description'],
  },
  table: {
    read: ['table', 'ids', 'sql', 'where', 'sort', 'columns', 'page', 'limit', 'max_cell'],
    write: ['table', 'insert', 'update', 'repeat'],
    schema: ['table', 'fields', 'ops'],
  },
};

/**
 * Enum values an external caller may use, per param: the published enum keeps
 * only these, and the gateway refuses any other value. An allow list, so a
 * value added later stays app-local until it is listed.
 * - agent scope: `self` edits the calling agent, and an external member is
 *   not an agent.
 * - search kind: `database` reads raw rows from nearly every table (agent
 *   prompts, MCP server env and headers, API-key hashes).
 * - export_node kind: `own_memories` binds to the caller's agent id, and an
 *   external member has no agent row.
 * - agent listAll: get is always the slim roster (the gateway sets it), so
 *   only `true` is accepted, as earlier guidance taught.
 */
export const EXTERNAL_ENUM_VALUES: Readonly<
  Record<string, Readonly<Record<string, readonly (string | boolean)[]>>>
> = {
  agent: { scope: ['agent'], listAll: [true] },
  search: { kind: ['all', 'workspace', 'docs', 'containers', 'conversations', 'files', 'code'] },
  export_node: { kind: ['doc', 'thread', 'image'] },
};

/**
 * A property set for external callers: one whose own schema text names what
 * they cannot use, replaced by one that does not, or one only they take.
 * - table `ops`: only the schema ops the gateway runs
 *   (EXTERNAL_TABLE_SCHEMA_OPS.allowed), and update_field without
 *   clear_repeats (the gateway refuses it: it removes every row's repeat).
 * - agent `listAll`: the roster form of get, which the agent tool accepts
 *   but does not list.
 */
const EXTERNAL_PROPERTY_SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  agent: {
    listAll: {
      type: 'boolean',
      enum: [true],
      description: 'get: the slim roster (always, for MCP clients; may be omitted).',
    },
  },
  table: {
    ops: {
      type: 'array',
      description:
        'schema: add_field {field}, update_field {name, set} (set.name renames), reorder_fields ' +
        '{names} (all fields), rename_table {name}, set_title_field {name}, restore_field {name, ' +
        'as}, restore_table {as}, set_project {project_id} (null: workspace-wide); as: a new name ' +
        'if the old one is taken',
      items: {
        type: 'object',
        required: ['op'],
        properties: { op: { type: 'string', enum: [...EXTERNAL_TABLE_SCHEMA_OPS.allowed] } },
      },
    },
  },
};

type JsonSchema = Record<string, unknown>;

function propertiesOf(schema: JsonSchema): Record<string, unknown> {
  return (schema.properties as Record<string, unknown> | undefined) ?? {};
}

/** The external op set of a tool, or null when it has no op enum to narrow. */
function externalOps(def: ToolDefinition): string[] | null {
  const opSchema = propertiesOf(def.parameters_schema).op as { enum?: unknown[] } | undefined;
  const curated = CURATED_TOOL_OPS[def.id];
  if (!curated || !Array.isArray(opSchema?.enum)) return null;
  return opSchema.enum.filter((op): op is string => typeof op === 'string' && curated.includes(op));
}

/**
 * The params an external caller may send to `op` (top-level names, and the
 * allowed fields of each object param), or null when the tool is not
 * narrowed by param.
 */
function allowedParams(
  toolId: string,
  op: string | null
): { top: Set<string>; fields: Map<string, Set<string>> } | null {
  const shape = EXTERNAL_OP_PARAMS[toolId];
  if (!shape) return null;
  const entries = op === null ? (shape[''] ?? []) : (shape[op] ?? []);
  const top = new Set<string>();
  const fields = new Map<string, Set<string>>();
  for (const entry of entries) {
    const [name, field] = entry.split('.', 2) as [string, string | undefined];
    top.add(name);
    if (field) fields.set(name, (fields.get(name) ?? new Set()).add(field));
  }
  return { top, fields };
}

/** Every op's allowed params together: what the one published schema may hold. */
function publishedParams(toolId: string): ReturnType<typeof allowedParams> {
  const shape = EXTERNAL_OP_PARAMS[toolId];
  if (!shape) return null;
  const top = new Set<string>();
  const fields = new Map<string, Set<string>>();
  for (const op of Object.keys(shape)) {
    const one = allowedParams(toolId, op === '' ? null : op)!;
    for (const name of one.top) top.add(name);
    for (const [name, set] of one.fields) {
      fields.set(name, new Set([...(fields.get(name) ?? []), ...set]));
    }
  }
  return { top, fields };
}

/**
 * The external inputSchema: the definition's own plus any unlisted params it
 * publishes, cut down to the curated ops, the params in EXTERNAL_OP_PARAMS and
 * the values in EXTERNAL_ENUM_VALUES, with EXTERNAL_PROPERTY_SCHEMAS swapped
 * in. The definition's own object when nothing changes.
 */
function externalInputSchema(def: ToolDefinition): JsonSchema {
  const published = EXTERNAL_PUBLISHED_PARAMS[def.id];
  const unlisted = def.unlisted_params;
  let properties: Record<string, unknown> = { ...propertiesOf(def.parameters_schema) };
  let changed = false;
  if (published && unlisted) {
    const names = published === 'all' ? Object.keys(unlisted) : published;
    for (const name of names) {
      if (unlisted[name]) {
        properties[name] = unlisted[name];
        changed = true;
      }
    }
  }
  const ops = externalOps(def);
  const opSchema = properties.op as { enum?: unknown[] } | undefined;
  if (ops && opSchema && ops.length !== opSchema.enum?.length) {
    properties.op = { ...opSchema, enum: ops };
    changed = true;
  }
  const allowed = publishedParams(def.id);
  if (allowed) {
    const kept: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(properties)) {
      if (name !== 'op' && !allowed.top.has(name)) continue;
      const fields = allowed.fields.get(name);
      const inner = (schema as JsonSchema | undefined)?.properties as
        | Record<string, unknown>
        | undefined;
      kept[name] =
        fields && inner
          ? {
              ...(schema as JsonSchema),
              properties: Object.fromEntries(
                Object.entries(inner).filter(([field]) => fields.has(field))
              ),
            }
          : schema;
    }
    if (Object.keys(kept).length !== Object.keys(properties).length || allowed.fields.size > 0) {
      changed = true;
    }
    properties = kept;
  }
  for (const [name, values] of Object.entries(EXTERNAL_ENUM_VALUES[def.id] ?? {})) {
    const schema = properties[name] as { enum?: unknown[] } | undefined;
    if (!Array.isArray(schema?.enum)) continue;
    properties[name] = {
      ...schema,
      enum: schema.enum.filter((v) => values.includes(v as string | boolean)),
    };
    changed = true;
  }
  const shape = publishedParams(def.id);
  for (const [name, schema] of Object.entries(EXTERNAL_PROPERTY_SCHEMAS[def.id] ?? {})) {
    // Replace a published property, or add one only external callers take.
    if (!(name in properties) && !shape?.top.has(name)) continue;
    properties[name] = schema;
    changed = true;
  }
  if (!changed) return def.parameters_schema;
  const required = Array.isArray(def.parameters_schema.required)
    ? (def.parameters_schema.required as string[]).filter((name) => name in properties)
    : undefined;
  return { ...def.parameters_schema, ...(required ? { required } : {}), properties };
}

/** Closes a refusal of a param or field: what an MCP client cannot set stays in the app. */
const APP_LOCAL_REST = 'Anything else stays in the Snaglet app.';

/** A field of an object param the op does not take externally (`thread.tool_access_mode`). */
function fieldError(
  name: string,
  value: unknown,
  allowedFields: Map<string, Set<string>>,
  where: string
): string | null {
  const fields = allowedFields.get(name);
  if (!fields || typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const field = Object.keys(value).find((key) => !fields.has(key));
  return field
    ? `\`${name}.${field}\` is not a parameter of ${where} for MCP clients; ${name} takes ` +
        `${[...fields].join(', ')}. ${APP_LOCAL_REST}`
    : null;
}

/** Every name a param may arrive under (its param_aliases group). */
function aliasGroups(def: Pick<ToolDefinition, 'param_aliases'>): string[][] {
  return Object.entries(def.param_aliases ?? {}).map(([key, aliases]) => [key, ...aliases]);
}

/**
 * Older names a tool's own handler maps per op (not param_aliases, not an old
 * id's rename): accepted where the param they stand for is.
 * - container: container_id / container_path are the parent on create and
 *   the target on update.
 */
const EXTERNAL_LEGACY_PARAMS: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
> = {
  container: {
    create: { container_id: 'parent_id', container_path: 'parent_path' },
    update: { container_id: 'id', container_path: 'path' },
  },
};

/**
 * Why an external call falls outside the published shape, or null when it
 * fits: a param the op does not take externally (EXTERNAL_OP_PARAMS), a field
 * of an object param it does not take, or an enum value outside
 * EXTERNAL_ENUM_VALUES. `args` are the final execution args. A param may
 * arrive under another name for an allowed one: its param_aliases group, a
 * handler's legacy name (EXTERNAL_LEGACY_PARAMS), or a name an old tool id
 * renames (`renamedTo`, which the gateway reads off the alias's transform).
 */
export function externalArgsError(
  def: Pick<ToolDefinition, 'id' | 'param_aliases'>,
  op: string | null,
  args: Record<string, unknown>,
  mcpName: string,
  renamedTo: (name: string) => readonly string[] = () => []
): string | null {
  const where = op === null ? mcpName : `${mcpName} op ${op}`;
  const allowed = allowedParams(def.id, op);
  if (allowed) {
    const accepted = new Set(allowed.top);
    for (const group of aliasGroups(def)) {
      if (group.some((name) => allowed.top.has(name))) for (const name of group) accepted.add(name);
    }
    const legacy = (op !== null && EXTERNAL_LEGACY_PARAMS[def.id]?.[op]) || {};
    for (const [name, target] of Object.entries(legacy)) {
      if (allowed.top.has(target)) accepted.add(name);
    }
    for (const [name, value] of Object.entries(args)) {
      if (name === 'op' || value === undefined) continue;
      if (!accepted.has(name) && !renamedTo(name).some((target) => accepted.has(target))) {
        const takes = allowed.top.size > 0 ? [...allowed.top].join(', ') : 'no parameters';
        return (
          `\`${name}\` is not a parameter of ${where} for MCP clients; it takes ${takes}. ` +
          APP_LOCAL_REST
        );
      }
      const objectFieldError = fieldError(name, value, allowed.fields, where);
      if (objectFieldError) return objectFieldError;
    }
  }
  for (const [name, values] of Object.entries(EXTERNAL_ENUM_VALUES[def.id] ?? {})) {
    const value = args[name];
    if (value === undefined || values.includes(value as string | boolean)) continue;
    return `\`${name}\` must be one of ${values.join(', ')} for MCP clients.`;
  }
  return null;
}

export interface ExternalNameOptions {
  curatedIds?: readonly string[];
  curatedOps?: Readonly<Record<string, readonly string[]>>;
  resolve?: (id: string) => ResolvedToolId;
}

/** True when an external caller may run `op` of canonical `toolId`. */
export function isExternalOpAllowed(
  toolId: string,
  op: string | null,
  curatedOps: Readonly<Record<string, readonly string[]>> = CURATED_TOOL_OPS
): boolean {
  const allowed = curatedOps[toolId];
  if (!allowed) return true;
  return op !== null && allowed.includes(op);
}

/** Internal id -> boundary name (`search` -> `snaglet_search`). */
export function toMcpToolName(toolId: string): string {
  return `${MCP_TOOL_PREFIX}${toolId}`;
}

/**
 * Boundary name -> internal id, or null when the name is not a valid external
 * name: wrong prefix, the bare id is not in the curated tier, or it is an old
 * id whose pinned op or params MCP clients cannot use.
 */
export function fromMcpToolName(mcpName: string, options: ExternalNameOptions = {}): string | null {
  const curatedIds = options.curatedIds ?? CURATED_TOOL_IDS;
  if (!mcpName.startsWith(MCP_TOOL_PREFIX)) return null;
  const bare = mcpName.slice(MCP_TOOL_PREFIX.length);
  if (curatedIds.includes(bare)) return bare;
  const resolution = (options.resolve ?? resolveToolId)(bare);
  if (!curatedIds.includes(resolution.id)) return null;
  // An alias id that pins an op is external only if that op is.
  if (resolution.op && !isExternalOpAllowed(resolution.id, resolution.op, options.curatedOps)) {
    return null;
  }
  // An alias id that maps to a family of ops is external only if one of them is.
  if (
    resolution.ops &&
    !resolution.ops.some((op) => isExternalOpAllowed(resolution.id, op, options.curatedOps))
  ) {
    return null;
  }
  if (pinsOutsideShape(resolution)) return null;
  return bare;
}

/**
 * True when an old id pins a param value outside the external shape, so no
 * call through it could succeed for an MCP client (update_identity pins scope
 * self, database_search pins kind database).
 */
function pinsOutsideShape(resolution: ResolvedToolId): boolean {
  const pins = Object.fromEntries(
    Object.entries(resolution.pins ?? {}).filter(([name]) => name !== 'op')
  );
  if (Object.keys(pins).length === 0) return false;
  return externalArgsError({ id: resolution.id }, resolution.op ?? null, pins, '') !== null;
}

/**
 * The in-app sentence pointing at tool(op:schema) for fields left out of the
 * schema (`… are not listed: tool({op:"schema", name:"x"}) returns them as
 * unlisted_parameters.`). External callers have no tool op:schema, and the
 * fields they can use are already in their inputSchema
 * (EXTERNAL_PUBLISHED_PARAMS), so the sentence is dropped from their
 * description. The match starts after the previous sentence's end (". " or a
 * newline) and takes the space before it, never the sentence before.
 */
const UNLISTED_POINTER =
  /(?:[^.\n]|\.(?!\s))*tool\(\{op:"schema", name:"[^"]+"\}\) returns them as unlisted_parameters\./g;

/** The external description: internal description (minus the unlisted pointer) + distilled guidance. */
export function projectDescription(def: Pick<ToolDefinition, 'id' | 'description'>): string {
  const description = def.description.replace(UNLISTED_POINTER, '').trimEnd();
  const guidance = EXTERNAL_GUIDANCE[def.id];
  return guidance ? `${description}\n\nExternal (MCP) notes: ${guidance}` : description;
}

/**
 * Project the registry's definitions onto the external MCP tier. Definitions
 * missing from the registry are skipped (never invented); order follows
 * CURATED_TOOL_IDS. inputSchema is the definition's parameters_schema (same
 * reference) unless the external shape changes it (externalInputSchema).
 */
export function projectTools(definitions: Record<string, ToolDefinition>): McpToolProjection[] {
  const projected: McpToolProjection[] = [];
  for (const id of CURATED_TOOL_IDS) {
    const def = definitions[id];
    if (!def) continue;
    projected.push({
      name: toMcpToolName(def.id),
      description: projectDescription(def),
      inputSchema: externalInputSchema(def),
    });
  }
  return projected;
}
