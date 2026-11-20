export type ToolParams = Record<string, unknown>;
export type ToolParamTransform = (params: ToolParams) => ToolParams;
/** A value an old id fixes on every call made through it. */
export type ToolPinValue = string | number | boolean;
/**
 * The routing params an old id pins (`op` included): what the old id means.
 * Access rules naming the old id read them (see toolOpRules). Output-format
 * compat flags (shell_exec's legacy_output, date_time's compat) and param
 * folding are transforms, not pins: they change how a call reports, not what
 * it may do.
 */
export type ToolPins = Readonly<Record<string, ToolPinValue>>;

export interface ToolAliasSpec {
  /** Canonical catalog id. */
  id: string;
  /** Optional compatibility transform applied before target param_aliases. */
  transformParams?: ToolParamTransform;
  /** Intentional capability removal. The executor returns this message. */
  removed?: string;
  /**
   * For an old id absorbed into a merged `tool(op)`: the op it stands for.
   * Access rules naming the old id are scoped to this op (see toolOpRules).
   */
  op?: string;
  /**
   * Every routing param the old id pins, `op` included (git_status →
   * {subcommand:'status'}, move_container → {op:'move', kind:'container'}).
   * The call transform forces these values, and an allow rule naming the old
   * id covers only calls carrying all of them (see toolOpRules).
   */
  pins?: ToolPins;
  /** Finite operation family supported by a legacy multi-operation tool. */
  ops?: readonly string[];
}

export interface ResolvedToolId {
  id: string;
  transformParams?: ToolParamTransform;
  aliasedFrom?: string;
  removed?: string;
  op?: string;
  pins?: ToolPins;
  /** Finite operation family supported by a legacy multi-operation tool. */
  ops?: readonly string[];
}

type RenameMap = Readonly<Record<string, string>>;

function transform(
  pinned: ToolParams = {},
  renames: RenameMap = {},
  custom?: ToolParamTransform
): ToolParamTransform {
  return (params) => {
    let out: ToolParams = { ...params };
    for (const [from, to] of Object.entries(renames)) {
      if (out[to] === undefined && out[from] !== undefined) out[to] = out[from];
    }
    if (custom) out = custom(out);
    // Routing discriminators are intentionally pinned. A caller using an old
    // id cannot change which absorbed operation that id represents by
    // smuggling a conflicting canonical discriminator.
    return { ...out, ...pinned };
  };
}

/**
 * Alias for an old id. `pinned` holds the routing params it stands for: the
 * call transform forces them (a caller cannot redirect the old id) and they
 * are recorded as its `pins`, so an allow rule naming the old id covers only
 * the calls it could make. `custom` is for compat transforms only (output
 * format, param folding), never for a routing value: put those in `pinned`.
 */
function alias(
  id: string,
  pinned?: Record<string, ToolPinValue>,
  renames?: RenameMap,
  custom?: ToolParamTransform
): ToolAliasSpec {
  const hasPins = pinned !== undefined && Object.keys(pinned).length > 0;
  return {
    id,
    ...(pinned || renames || custom ? { transformParams: transform(pinned, renames, custom) } : {}),
    ...(hasPins ? { pins: Object.freeze({ ...pinned }) } : {}),
  };
}

/**
 * Alias for an old id absorbed into a merged `tool(op)`. The op is pinned (the
 * caller cannot redirect an old id to another op) and recorded so access rules
 * naming the old id stay scoped to that one op.
 */
export function opAlias(
  id: string,
  op: string,
  renames?: RenameMap,
  custom?: ToolParamTransform
): ToolAliasSpec {
  return { ...alias(id, { op }, renames, custom), op };
}

/**
 * Op alias that also pins other routing params (move_container →
 * node{op:'move', kind:'container'}, update_identity → agent{op:'update',
 * scope:'self'}). All of them are forced on the call, and an allow rule naming
 * the old id covers only calls carrying every one: `allow: move_container`
 * never allows moving a doc, `allow: update_identity` never updates another
 * agent. A deny rule naming it still blocks the whole op.
 */
function pinnedOpAlias(
  id: string,
  op: string,
  pins: Record<string, ToolPinValue>,
  renames?: RenameMap
): ToolAliasSpec {
  return { ...alias(id, { op, ...pins }, renames), op };
}

/**
 * calendar(op): the read and write op families. `calendar_read` and
 * `calendar_write` are family aliases for them, so an access rule naming one
 * covers exactly its family.
 */
export const CALENDAR_READ_OPS = Object.freeze([
  'list',
  'query',
  'focus',
  'dates',
  'get_event',
  'get_reminders',
] as const);
export const CALENDAR_WRITE_OPS = Object.freeze([
  'create_calendar',
  'create_event',
  'update_event',
  'delete_event',
  'restore_event',
  'move_occurrence',
  'complete_occurrence',
  'skip_occurrence',
  'set_reminders',
] as const);

/**
 * Alias for a family of ops of a merged tool (`calendar_read` → calendar's
 * read ops). A call through it keeps its op when the op is in the family,
 * takes `defaultOp` when it names none, and otherwise fails closed at the
 * tool's op check. Access rules naming the alias cover exactly the family
 * (toolOpRules: an allow grants only those ops, a deny blocks only those).
 */
function opFamilyAlias(
  id: string,
  aliasId: string,
  ops: readonly string[],
  defaultOp?: string
): ToolAliasSpec {
  return {
    id,
    ops,
    transformParams: (params) => {
      const op = params.op;
      const next =
        typeof op === 'string' && ops.includes(op)
          ? op
          : op === undefined && defaultOp !== undefined
            ? defaultOp
            : `__not_a_${aliasId}_op__`;
      return { ...params, op: next };
    },
  };
}

const removedMessage = (replacement: string): string =>
  `This tool was intentionally removed from Snaglet's builtin catalog. ${replacement}`;

// node(op:move): move's old parameter names.
const MOVE_RENAMES: RenameMap = {
  node_id: 'id',
  new_parent_id: 'parent_id',
  new_parent_path: 'parent_path',
};

// doc(op): the old doc tools' id/path names.
const DOC_RENAMES: RenameMap = { doc_id: 'id', doc_path: 'path' };

const DOC_HISTORY_OPS = Object.freeze(['snapshot', 'list-snapshots', 'restore', 'delete-snapshot']);
const DOC_HISTORY_OPERATION_MAP: Readonly<Record<string, string>> = Object.freeze({
  snapshot: 'snapshot',
  list: 'list-snapshots',
  restore: 'restore',
  delete: 'delete-snapshot',
});

// Merged-tool aliases register here (tool consolidation).
const opAliases: Record<string, ToolAliasSpec> = {
  // tool(op) / custom_tool(op): search_tools and get_tool_schema merged into
  // the always-available discovery tool; create_tool is the authoring tool's
  // create op. Ops are pinned, so a legacy create_tool allow never grants update.
  search_tools: opAlias('tool', 'search'),
  get_tool_schema: opAlias('tool', 'schema', { tool: 'name' }),
  create_tool: opAlias('custom_tool', 'create'),

  // hook(op): create_hook/run_hook merged. Ops are pinned, so an allow rule
  // naming run_hook never grants create/update/enable/disable.
  create_hook: opAlias('hook', 'create'),
  run_hook: opAlias('hook', 'run'),
  // Rename only: same schema and dispatch-only semantics.
  get_clarification: { id: 'ask' },

  // memory(op): memory_save/search/edit/forget merged. The pre-catalog names
  // (memory_store, memory_recall) point straight at the merged tool too, since
  // aliases resolve one level only.
  memory_search: opAlias('memory', 'search'),
  memory_recall: opAlias('memory', 'search'),
  memory_save: opAlias('memory', 'create'),
  memory_store: opAlias('memory', 'create'),
  memory_edit: opAlias('memory', 'update'),
  memory_forget: opAlias('memory', 'delete'),

  // thread(op): the old thread_* ids and their alternate names each pin one
  // op, since an unpinned alias would arrive with no op. ask stays separate.
  thread_send: opAlias('thread', 'send'),
  thread_read: opAlias('thread', 'read'),
  // message_context keeps its window mode pinned (a caller can't flip it).
  message_context: pinnedOpAlias('thread', 'read', { mode: 'message_context' }),
  thread_create: opAlias('thread', 'create'),
  create_thread: opAlias('thread', 'create'),
  new_thread: opAlias('thread', 'create'),
  start_thread: opAlias('thread', 'create'),
  thread_update: opAlias('thread', 'update'),
  update_thread: opAlias('thread', 'update'),
  configure_thread: opAlias('thread', 'update'),
  thread_settings_update: opAlias('thread', 'update'),
  // Removed: the thread prompt changes only through thread op update
  // (thread.system_prompt), gated by the thread tool itself.
  thread_system_prompt_update: {
    id: 'thread_system_prompt_update',
    removed: removedMessage('Use thread op "update" with thread: {system_prompt: "<text>"}.'),
  },
  // Removed: agents join through thread op add_agents (or agent_ids on create).
  thread_add_agent: {
    id: 'thread_add_agent',
    removed: removedMessage('Use thread op "add_agents" with agent_ids: ["<agent id>"].'),
  },
  thread_add_participant: {
    id: 'thread_add_participant',
    removed: removedMessage('Use thread op "add_agents" with agent_ids: ["<agent id>"].'),
  },
  add_agent_to_thread: {
    id: 'add_agent_to_thread',
    removed: removedMessage('Use thread op "add_agents" with agent_ids: ["<agent id>"].'),
  },
  thread_delete: opAlias('thread', 'delete'),

  // node(op): move and rename are separate ops so an access rule naming one
  // old id never covers the other. Old parameter names map to the node
  // fields; the workspace_* ids keep their kind/scope pins.
  get_node: opAlias('node', 'get', { node_id: 'id' }),
  workspace_get_node: opAlias('node', 'get', { node_id: 'id' }),
  verify_ids: opAlias('node', 'get'),
  workspace_tree: opAlias('node', 'tree', { container_id: 'id' }),
  workspace_project_tree: pinnedOpAlias(
    'node',
    'tree',
    { scope: 'current_project' },
    { container_id: 'id' }
  ),
  move: opAlias('node', 'move', MOVE_RENAMES),
  workspace_move: opAlias('node', 'move', MOVE_RENAMES),
  move_container: pinnedOpAlias('node', 'move', { kind: 'container' }, MOVE_RENAMES),
  container_move: pinnedOpAlias('node', 'move', { kind: 'container' }, MOVE_RENAMES),
  rename: opAlias('node', 'rename', { new_title: 'title' }),
  workspace_rename: opAlias('node', 'rename', { new_title: 'title' }),
  archive_node: opAlias('node', 'archive', { node_id: 'id' }),
  workspace_archive_node: pinnedOpAlias('node', 'archive', { kind: 'node' }, { node_id: 'id' }),
  archive_container: pinnedOpAlias('node', 'archive', { kind: 'container' }, { node_id: 'id' }),
  container_archive: pinnedOpAlias('node', 'archive', { kind: 'container' }, { node_id: 'id' }),
  restore_node: opAlias('node', 'restore', { node_id: 'id', container_id: 'parent_id' }),
  workspace_restore_node: opAlias('node', 'restore', { node_id: 'id', container_id: 'parent_id' }),

  // doc(op): each old id
  // pins exactly one op, so an access rule naming one never covers another
  // (allow: edit_doc never grants delete).
  duplicate_doc: opAlias('doc', 'duplicate', { source_id: 'id', source_path: 'path' }),
  workspace_duplicate_doc: opAlias('doc', 'duplicate', { source_id: 'id', source_path: 'path' }),
  diff_doc: opAlias('doc', 'diff', DOC_RENAMES),
  workspace_diff_doc: opAlias('doc', 'diff', DOC_RENAMES),
  convert_doc_to_container: opAlias('doc', 'convert-to-container', DOC_RENAMES),
  workspace_convert_doc_to_container: opAlias('doc', 'convert-to-container', DOC_RENAMES),
  doc_history: {
    id: 'doc',
    ops: DOC_HISTORY_OPS,
    transformParams: transform({}, DOC_RENAMES, (params) => {
      // Never let a conflicting canonical op redirect the legacy history id.
      // Invalid/missing legacy operations fail closed at canonical validation.
      const operation = params.operation;
      const op =
        typeof operation === 'string' &&
        Object.prototype.hasOwnProperty.call(DOC_HISTORY_OPERATION_MAP, operation)
          ? DOC_HISTORY_OPERATION_MAP[operation]
          : '__invalid_doc_history_operation__';
      const { operation: _operation, ...rest } = params;
      return { ...rest, op };
    }),
  },
  get_doc: opAlias('doc', 'get', DOC_RENAMES),
  workspace_get_doc: opAlias('doc', 'get', DOC_RENAMES),
  create_doc: opAlias('doc', 'create'),
  workspace_create_doc: opAlias('doc', 'create'),
  edit_doc: opAlias('doc', 'update', DOC_RENAMES),
  workspace_edit_doc: opAlias('doc', 'update', DOC_RENAMES),
  delete_doc: opAlias('doc', 'delete', DOC_RENAMES),
  workspace_delete_doc: opAlias('doc', 'delete', DOC_RENAMES),

  // container(op): each old id pins exactly one op (allow: create_container
  // never grants update). Their parameter names pass through: container(op)
  // maps container_id / container_path per op (create: the parent; update:
  // the target).
  create_container: opAlias('container', 'create'),
  workspace_create_container: opAlias('container', 'create'),
  update_container: opAlias('container', 'update'),
  workspace_update_container: opAlias('container', 'update'),

  // table(op): each old id pins exactly one op (allow: table_read never grants
  // write or delete). Their parameter names are unchanged.
  table_read: opAlias('table', 'read'),
  table_write: opAlias('table', 'write'),
  table_schema: opAlias('table', 'schema'),
  table_delete: opAlias('table', 'delete'),

  // calendar(op): calendar_read and calendar_write each cover one op family
  // (allow: calendar_read never grants a write). calendar_read with no op is a
  // query.
  calendar_read: opFamilyAlias('calendar', 'calendar_read', CALENDAR_READ_OPS, 'query'),
  calendar_write: opFamilyAlias('calendar', 'calendar_write', CALENDAR_WRITE_OPS),

  // pane(op): one op per old id.
  get_user_pane_layout: opAlias('pane', 'layout'),
  navigate_user_pane: opAlias('pane', 'navigate'),

  // shell(op): exec_command/shell_exec/write_stdin merged.
  exec_command: opAlias('shell', 'run'),
  // shell_exec callers keep shell_exec's contract: block until exit, a
  // non-zero exit is a failure, plain output (shellRun's legacy branch).
  shell_exec: opAlias('shell', 'run', { command: 'cmd', cwd: 'workdir' }, (params) => ({
    ...params,
    legacy_output: 'shell_exec',
  })),
  write_stdin: opAlias('shell', 'write'),

  // file(op): file_read/list/info/write/edit, apply_patch and diff_files merged.
  // The older one-level names point straight at `file` with their op and mode.
  file_read: opAlias('file', 'read'),
  read_multiple_files: pinnedOpAlias('file', 'read', { mode: 'multiple' }),
  file_read_image: pinnedOpAlias('file', 'read', { mode: 'image' }),
  view_image: pinnedOpAlias('file', 'read', { mode: 'image' }),
  read_image: pinnedOpAlias('file', 'read', { mode: 'image' }),
  image_view: pinnedOpAlias('file', 'read', { mode: 'image' }),
  workspace_get_image: pinnedOpAlias('file', 'read', { mode: 'image' }),
  file_list: opAlias('file', 'list'),
  find_files: pinnedOpAlias(
    'file',
    'list',
    { mode: 'find' },
    { nameContains: 'name_contains', maxResults: 'limit' }
  ),
  repo_tree: pinnedOpAlias('file', 'list', { mode: 'tree' }),
  file_info: opAlias('file', 'info'),
  file_write: opAlias('file', 'create'),
  file_edit: opAlias('file', 'update'),
  // apply_patch read its text from patch ?? input ?? content. Fold all three
  // into `patch` so update never mistakes patch text for a full rewrite.
  apply_patch: opAlias('file', 'update', {}, (params) => {
    const { input, content, ...rest } = params;
    return { ...rest, patch: params.patch ?? input ?? content };
  }),
  diff_files: opAlias('file', 'diff'),
};

const aliases: Record<string, ToolAliasSpec> = {
  // Search.
  workspace_search: alias('search', { kind: 'workspace' }),
  doc_search: alias('search', { kind: 'docs' }),
  container_search: alias('search', { kind: 'containers' }),
  code_search: alias('search', { kind: 'code' }, { mode: 'code_mode', max_results: 'limit' }),
  semantic_file_search: alias('search', { kind: 'files' }, { maxResults: 'limit' }),
  database_search: alias('search', { kind: 'database' }),
  find_conversation: alias('search', { kind: 'conversations' }),
  workspace_list_archived: alias(
    'search',
    { kind: 'workspace', archived_only: true },
    {},
    (params) => {
      if (params.kinds === undefined && typeof params.type === 'string') {
        return { ...params, kinds: [params.type] };
      }
      return params;
    }
  ),
  workspace_list_recent: alias('search', { kind: 'workspace', sort: 'recent' }),

  // Workspace and database naming.
  workspace_resolve_path: alias('resolve_path', { domain: 'workspace' }),
  path_resolve: alias('resolve_path', { domain: 'filesystem' }),
  workspace_orient: alias('orient', { mode: 'workspace' }),
  get_local_context: alias('orient', { mode: 'local' }),
  workspace_bulk_export: alias('bulk_export'),
  workspace_bulk_import: alias('bulk_import'),
  database_create_view: alias('create_view'),

  // Doc history.
  snapshot_doc: opAlias('doc', 'snapshot', DOC_RENAMES),
  workspace_snapshot_doc: opAlias('doc', 'snapshot', DOC_RENAMES),
  list_snapshots: opAlias('doc', 'list-snapshots', DOC_RENAMES),
  workspace_list_snapshots: opAlias('doc', 'list-snapshots', DOC_RENAMES),
  restore_snapshot: opAlias('doc', 'restore', DOC_RENAMES),
  workspace_restore_snapshot: opAlias('doc', 'restore', DOC_RENAMES),
  delete_snapshot: opAlias('doc', 'delete-snapshot', DOC_RENAMES),
  workspace_delete_snapshot: opAlias('doc', 'delete-snapshot', DOC_RENAMES),

  // agent(op): create_agent/get_agent/update_agent/abort_agent_run/
  // agent_activity merged (entity + verb-as-op). Each old id pins exactly one
  // op, so an access rule naming it keeps covering only that op. Ids that also
  // pinned a view/scope keep it pinned (a caller can't flip it), and an allow
  // naming them covers only that view/scope: `allow: update_identity` updates
  // the agent itself, never another agent.
  create_agent: opAlias('agent', 'create'),
  get_agent: opAlias('agent', 'get'),
  update_agent: opAlias('agent', 'update'),
  abort_agent_run: opAlias('agent', 'abort'),
  agent_activity: opAlias('agent', 'activity'),
  self_inspect: pinnedOpAlias('agent', 'get', { view: 'runtime_self' }),
  update_identity: pinnedOpAlias('agent', 'update', { scope: 'self' }),
  agent_recent_activity: pinnedOpAlias('agent', 'activity', { view: 'agent' }),
  my_activity: pinnedOpAlias('agent', 'activity', { view: 'self_recent' }),
  run_history: pinnedOpAlias('agent', 'activity', { view: 'self_history' }),

  // model(op): list_models + add_model merged.
  list_models: opAlias('model', 'list'),
  add_model: opAlias('model', 'add'),
  get_providers: pinnedOpAlias('model', 'list', { operation: 'providers' }),
  get_provider_models: pinnedOpAlias('model', 'list', { operation: 'models' }),

  // mcp(op): MCP server management. Old-style names a model may guess.
  mcp_server: alias('mcp'),
  list_mcp_servers: opAlias('mcp', 'list'),
  add_mcp_server: opAlias('mcp', 'create'),
  update_mcp_server: opAlias('mcp', 'update'),

  // System compatibility.
  list_tools: pinnedOpAlias('tool', 'search', { mode: 'list' }),
  // `compat` shapes date_time's old output; it is not a routing pin.
  date_time: alias('get_current_datetime', undefined, undefined, (params) => ({
    ...params,
    compat: 'date_time',
  })),

  // Intentional removals.
  sandbox_run: {
    id: 'sandbox_run',
    removed: removedMessage("Use the guarded shell tool (op: 'run') instead."),
  },
  base64_convert: {
    id: 'base64_convert',
    removed: removedMessage('Do this natively or with a guarded shell command.'),
  },
  create_archive: {
    id: 'create_archive',
    removed: removedMessage('Use a guarded shell archive command.'),
  },
  data_transform: {
    id: 'data_transform',
    removed: removedMessage('Transform the data natively or with a guarded shell command.'),
  },
  hash_text: {
    id: 'hash_text',
    removed: removedMessage('Hash with a guarded shell command when needed.'),
  },
  json_validate: {
    id: 'json_validate',
    removed: removedMessage('Validate JSON natively or with a guarded shell command.'),
  },
  regex_extract: {
    id: 'regex_extract',
    removed: removedMessage('Extract text natively or with a guarded shell command.'),
  },
  text_analyze: {
    id: 'text_analyze',
    removed: removedMessage('Analyze the text directly.'),
  },
  translate_text: {
    id: 'translate_text',
    removed: removedMessage('Translate the text directly.'),
  },
  uuid_generate: {
    id: 'uuid_generate',
    removed: removedMessage('Generate an id natively or with a guarded shell command.'),
  },

  // Database tables: four name-addressed tools replace the id-addressed set.
  table_list: opAlias('table', 'read'),
  table_create: {
    id: 'table_create',
    removed: removedMessage('Create a table with table {op: "schema", table, fields}.'),
  },
  table_rename: {
    id: 'table_rename',
    removed: removedMessage(
      'Rename it with table {op: "schema", ops: [{op: "rename_table", name}]}.'
    ),
  },
  table_field_create: {
    id: 'table_field_create',
    removed: removedMessage(
      'Add a field with table {op: "schema", ops: [{op: "add_field", field}]}.'
    ),
  },
  table_field_update: {
    id: 'table_field_update',
    removed: removedMessage(
      'Change a field with table {op: "schema", ops: [{op: "update_field", name, set}]}.'
    ),
  },
  table_entries_list: {
    id: 'table_entries_list',
    removed: removedMessage(
      'Read rows with table {op: "read", sql}; {op: "read", table} describes the fields.'
    ),
  },
  table_entry_get: {
    id: 'table_entry_get',
    removed: removedMessage('Read a row with table {op: "read", table, ids}.'),
  },
  table_entry_create: {
    id: 'table_entry_create',
    removed: removedMessage(
      'Insert rows with table {op: "write", table, insert}, values keyed by field name.'
    ),
  },
  table_entry_update: {
    id: 'table_entry_update',
    removed: removedMessage(
      'Update rows with table {op: "write", table, update}, values keyed by field name.'
    ),
  },

  // Removed: raw writes to Snaglet system tables (they bypass the models
  // and could change an agent's own access), and tools the guarded shell or the
  // model itself already covers. Tombstones, not plain aliases: a plain alias
  // would widen any stored rule naming the old id to the whole target tool.
  database_create: {
    id: 'database_create',
    removed: removedMessage(
      'Insert rows into a custom table with table {op: "write", table, insert}. Snaglet system tables are not writable by agents.'
    ),
  },
  database_update: {
    id: 'database_update',
    removed: removedMessage(
      'Update custom-table rows with table {op: "write", table, update: [{id, rev, values}]}. Snaglet system tables are not writable by agents.'
    ),
  },
  database_delete: {
    id: 'database_delete',
    removed: removedMessage('Delete custom-table rows with table {op: "delete", table, ids}.'),
  },
  database_describe: {
    id: 'database_describe',
    removed: removedMessage(
      'Describe a custom table with table {op: "read", table}; for a Snaglet table, query information_schema.columns or table_fields with database_query.'
    ),
  },
  // Removed: the Sketch tools. Tombstones so a model naming a sketch id gets
  // a clear message instead of a silent miss.
  sketch: {
    id: 'sketch',
    removed: removedMessage('The sketch feature was removed.'),
  },
  sketch_create: {
    id: 'sketch_create',
    removed: removedMessage('The sketch feature was removed.'),
  },
  sketch_get: {
    id: 'sketch_get',
    removed: removedMessage('The sketch feature was removed.'),
  },
  sketch_apply_operations: {
    id: 'sketch_apply_operations',
    removed: removedMessage('The sketch feature was removed.'),
  },
  sketch_undo: {
    id: 'sketch_undo',
    removed: removedMessage('The sketch feature was removed.'),
  },
  sketch_export_svg: {
    id: 'sketch_export_svg',
    removed: removedMessage('The sketch feature was removed.'),
  },
  say: {
    id: 'say',
    removed: removedMessage(
      'Play speech with a guarded shell command (`say` on macOS), or make an audio file with text_to_speech.'
    ),
  },
  url_parse: {
    id: 'url_parse',
    removed: removedMessage('Parse the URL natively.'),
  },
  eslint_check: {
    id: 'eslint_check',
    removed: removedMessage(
      "Run ESLint with the guarded shell tool (op: 'run'), e.g. npx eslint --format json <path>."
    ),
  },
  ts_typecheck: {
    id: 'ts_typecheck',
    removed: removedMessage(
      "Run the TypeScript compiler with the guarded shell tool (op: 'run'), e.g. npx tsc --noEmit -p <tsconfig>."
    ),
  },
};

const googleOperations: Readonly<Record<string, readonly string[]>> = {
  gmail: [
    'delete',
    'draft_create',
    'forward',
    'get_message',
    'list',
    'modify_labels',
    'reply',
    'search',
    'send',
    'trash',
  ],
  drive: [
    'advanced_search',
    'copy_file',
    'create_folder',
    'delete_file',
    'download_file',
    'get_file',
    'list_files',
    'list_permissions',
    'move_file',
    'rename_file',
    'revoke_permission',
    'search_files',
    'share_file',
    'upload_file',
  ],
  calendar: [
    'create_event',
    'delete_event',
    'get_event',
    'get_freebusy',
    'list_calendars',
    'list_events',
    'search_events',
    'update_event',
  ],
  docs: ['advanced_search', 'append', 'create', 'list', 'read'],
  sheets: ['append', 'create', 'read'],
};

for (const [capability, operations] of Object.entries(googleOperations)) {
  for (const operation of operations) {
    const target =
      capability === 'drive' &&
      [
        'copy_file',
        'create_folder',
        'delete_file',
        'move_file',
        'rename_file',
        'revoke_permission',
        'share_file',
        'upload_file',
      ].includes(operation)
        ? 'google_drive_admin'
        : `google_${capability}`;
    aliases[`google_${capability}_${operation}`] = alias(target, { operation });
  }
}
aliases.google_gmail_labels = alias('google_gmail', { operation: 'list_labels' });

const imessageOperations: Readonly<Record<string, string>> = {
  check_imessage: 'check',
  list_imessage_conversations: 'list_conversations',
  read_imessage: 'read',
  search_imessage: 'search',
  send_imessage: 'send',
};
for (const [oldId, operation] of Object.entries(imessageOperations)) {
  aliases[oldId] = alias('imessage', { operation });
}

for (const subcommand of [
  'branch',
  'checkout',
  'commit',
  'diff',
  'log',
  'pull',
  'push',
  'stash',
  'status',
  'verify',
] as const) {
  aliases[`git_${subcommand}`] = alias('git', { subcommand });
}

Object.assign(aliases, opAliases);

export const TOOL_ALIASES: Readonly<Record<string, ToolAliasSpec>> = Object.freeze(aliases);

function aliasSpec(id: string): ToolAliasSpec | undefined {
  // Own keys only: an id such as `constructor` must not resolve through
  // Object.prototype.
  return Object.prototype.hasOwnProperty.call(TOOL_ALIASES, id) ? TOOL_ALIASES[id] : undefined;
}

/** Resolve one stored/requested id to its canonical catalog id. */
export function resolveToolId(id: string): ResolvedToolId {
  const spec = aliasSpec(id);
  if (!spec) return { id };
  return {
    id: spec.id,
    ...(spec.transformParams ? { transformParams: spec.transformParams } : {}),
    aliasedFrom: id,
    ...(spec.removed ? { removed: spec.removed } : {}),
    ...(spec.op ? { op: spec.op } : {}),
    ...(spec.pins ? { pins: spec.pins } : {}),
    ...(spec.ops ? { ops: spec.ops } : {}),
  };
}

export function transformToolAliasParams(
  resolution: ResolvedToolId,
  params: ToolParams
): ToolParams {
  return resolution.transformParams ? resolution.transformParams(params) : { ...params };
}

/** Compare ids through the permanent alias surface. */
export function toolIdsEquivalent(left: string, right: string): boolean {
  return resolveToolId(left).id === resolveToolId(right).id;
}

/**
 * True for an old catalog id (an alias or a removal tombstone) with no live
 * definition of its own. People are never offered one: tool pickers, the Tools
 * list and catalog endpoints drop it, while resolution (executor, access
 * checks, hooks, MCP) keeps accepting it. An id in `liveToolIds` still has a
 * real definition and keeps its own meaning, as it does everywhere else.
 */
export function isRetiredToolId(id: string, liveToolIds?: ReadonlySet<string>): boolean {
  return aliasSpec(id) !== undefined && !liveToolIds?.has(id);
}

/**
 * The id to show a person for a stored or requested tool id: its canonical
 * id, plus the old id when that differs (for a "was …" hint). Live ids and
 * removal tombstones show as themselves. Display only; nothing is rewritten.
 */
export function canonicalToolName(
  id: string,
  liveToolIds?: ReadonlySet<string>
): { id: string; aliasedFrom: string | null } {
  if (liveToolIds?.has(id)) return { id, aliasedFrom: null };
  const resolution = resolveToolId(id);
  if (resolution.removed || resolution.id === id) return { id, aliasedFrom: null };
  return { id: resolution.id, aliasedFrom: id };
}

/** Old ids that resolve to a canonical target (used for config override fallback). */
export function toolAliasIdsFor(targetId: string): string[] {
  const canonical = resolveToolId(targetId).id;
  return Object.entries(TOOL_ALIASES)
    .filter(([, spec]) => !spec.removed && spec.id === canonical)
    .map(([oldId]) => oldId);
}
