/**
 * mcpProjection — unit tests for the external MCP boundary mapping.
 *
 * The contract: snaglet_ prefix at the boundary only; exactly the curated tier;
 * inputSchema = parameters_schema verbatim; nothing outside the tier ever
 * leaks into the projection.
 */

import {
  CURATED_TOOL_IDS,
  CURATED_TOOL_OPS,
  EXTERNAL_AUTOMATION_OPS,
  EXTERNAL_ENUM_VALUES,
  EXTERNAL_OP_PARAMS,
  EXTERNAL_TABLE_SCHEMA_OPS,
  MCP_TOOL_PREFIX,
  externalArgsError,
  externalCalendarAccess,
  fromMcpToolName,
  isExternalOpAllowed,
  projectDescription,
  projectTools,
  toMcpToolName,
} from '@server/domains/mcp/mcpProjection';
import type { ToolDefinition } from '@server/services/ToolService/types';
import { toolOpEnum } from '@server/services/ToolService/lib/toolVisibility';
import { SCHEMA_OP_KEYS } from '@server/services/ToolService/handlers/tables/tableSchema';
import agentDefinition from '@server/services/ToolService/tools/agents/agent/definition';
import automationDefinition from '@server/services/ToolService/tools/automations/automation/definition';
import calendarDefinition from '@server/services/ToolService/tools/calendar/calendar/definition';
import tableDefinition from '@server/services/ToolService/tools/tables/table/definition';
import docDefinition from '@server/services/ToolService/tools/docs/doc/definition';
import threadDefinition from '@server/services/ToolService/tools/threads/thread/definition';
import nodeDefinition from '@server/services/ToolService/tools/workspace/node/definition';
import searchDefinition from '@server/services/ToolService/tools/workspace/search/definition';
import exportNodeDefinition from '@server/services/ToolService/tools/workspace/export-node/definition';
import containerDefinition from '@server/services/ToolService/tools/containers/container/definition';
import modelDefinition from '@server/services/ToolService/tools/agents/model/definition';
import { isRetiredToolId } from '@snaglet/shared/utils';

function makeDef(id: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id,
    name: id,
    description: `${id} description`,
    type: 'builtin',
    categoryPath: 'workspace',
    tier: 'standard',
    keywords: [],
    parameters_schema: { type: 'object', properties: { q: { type: 'string' } } },
    ...overrides,
  };
}

describe('CURATED_TOOL_IDS', () => {
  it('is exactly the ruled external tier (order included)', () => {
    expect(CURATED_TOOL_IDS).toEqual([
      'agent',
      'thread',
      'model',
      'search',
      'doc',
      'node',
      'container',
      'table',
      'calendar',
      'automation',
      'export_node',
    ]);
  });

  it('exposes only the guarded orchestration subset', () => {
    for (const id of ['thread', 'agent', 'model']) {
      expect(CURATED_TOOL_IDS).toContain(id);
    }
    for (const id of ['thread_delete', 'thread_system_prompt_update', 'mcp']) {
      expect(CURATED_TOOL_IDS).not.toContain(id);
    }
    // agent(op)/model(op): abort, create, get (roster), list models, and agent
    // update (its fields are limited in McpGatewayService); no
    // archive/activity/add.
    expect(CURATED_TOOL_OPS.agent).toEqual(['abort', 'create', 'get', 'list', 'update']);
    for (const op of ['archive', 'restore', 'activity', null]) {
      expect(isExternalOpAllowed('agent', op)).toBe(false);
    }
    expect(CURATED_TOOL_OPS.model).toEqual(['list']);
    expect(isExternalOpAllowed('model', 'add')).toBe(false);
    for (const id of [
      'abort_agent_run',
      'create_agent',
      'get_agent',
      'list_models',
      'update_agent',
    ]) {
      expect(fromMcpToolName(toMcpToolName(id))).toBe(id);
    }
    for (const id of ['agent_activity', 'add_model']) {
      expect(fromMcpToolName(toMcpToolName(id))).toBeNull();
    }
    // thread(op) is curated to send/read/create/update/add_agents: no removal or delete.
    expect(CURATED_TOOL_OPS.thread).toEqual(['send', 'read', 'create', 'update', 'add_agents']);
    for (const op of ['send', 'read', 'create', 'update', 'add_agents']) {
      expect(isExternalOpAllowed('thread', op)).toBe(true);
    }
    for (const op of ['delete', 'leave', 'remove_agents', 'set_prompt', 'add_agent', null]) {
      expect(isExternalOpAllowed('thread', op)).toBe(false);
    }
  });

  it('keeps the old thread MCP names reachable, and only for curated ops', () => {
    for (const id of ['thread_read', 'thread_create', 'thread_update', 'thread_send']) {
      expect(fromMcpToolName(toMcpToolName(id))).toBe(id);
    }
    // The old add-agent id is removed (op add_agents), so it does not resolve.
    for (const id of ['thread_delete', 'thread_system_prompt_update', 'thread_add_agent']) {
      expect(fromMcpToolName(toMcpToolName(id))).toBeNull();
    }
  });

  it('says in guidance only what a schema cannot; the schema carries the restrictions', () => {
    const thread = projectDescription({ id: 'thread', description: 'Threads.' });
    expect(thread).toMatch(/explicit thread id/i);
    expect(thread).toMatch(/attributed to your MCP member/);
    const agentDescription = projectDescription({ id: 'agent', description: 'Agent.' });
    expect(agentDescription).toMatch(/slim roster/);
    expect(agentDescription).toMatch(/aborting actor/);
    expect(agentDescription).not.toMatch(/confirm\s*:/i);
    // No sentence is left whose only job is to say a param or op is
    // unavailable (doc's guidance is owned elsewhere and left as it is).
    for (const id of CURATED_TOOL_IDS.filter((tool) => tool !== 'doc')) {
      const guidance = projectDescription({ id, description: '' });
      expect({ id, guidance }).not.toEqual({
        id,
        guidance: expect.stringMatching(/denied|app-local|not available|expose (every )?op/i),
      });
    }
  });

  it('snaglet_thread: the external schema has the curated ops and fields only', () => {
    const [projected] = projectTools({ thread: threadDefinition as ToolDefinition });
    const props = projected!.inputSchema.properties as Record<
      string,
      { enum?: unknown[] } & {
        properties?: Record<string, unknown>;
      }
    >;
    expect(props.op!.enum).toEqual(['send', 'read', 'create', 'update', 'add_agents']);
    for (const gone of ['sender_agent_id', 'initial_message', 'confirm', 'to', 'all']) {
      expect(props).not.toHaveProperty(gone);
    }
    expect(Object.keys(props.thread!.properties ?? {})).not.toContain('tool_access_mode');
    expect(Object.keys(props.thread!.properties ?? {})).toContain('working_directory');
  });

  it('snaglet_agent: the external schema has the curated ops, the roster get and no admin fields', () => {
    const [projected] = projectTools({ agent: agentDefinition as ToolDefinition });
    const props = projected!.inputSchema.properties as Record<string, { enum?: unknown[] }>;
    expect(props.op!.enum).toEqual(['create', 'get', 'list', 'update', 'abort']);
    expect(props.scope!.enum).toEqual(['agent']);
    // Earlier guidance taught get {listAll: true}: it is still accepted.
    expect(props.listAll!.enum).toEqual([true]);
    for (const gone of ['skills', 'add_skills', 'set_skills', 'agent', 'view', 'agent_name']) {
      expect(props).not.toHaveProperty(gone);
    }
  });

  it('exposes export_node without exposing any memory read', () => {
    // export_node is projected for node kinds. Its `own_memories` kind binds
    // to the calling agent's id from tool context, and an external member has
    // no agent row (the same reason memory_recall is excluded). An agent-id
    // parameter on export_node would need this pairing revisited.
    expect(CURATED_TOOL_IDS).toContain('export_node');
    for (const id of ['memory_recall', 'memory_search', 'memory_save', 'memory_forget']) {
      expect(CURATED_TOOL_IDS).not.toContain(id);
    }
  });

  it('keeps the merged memory tool unexposed: no curated id, no curated ops, old names refused', () => {
    // Memory is not curated: neither `memory(op)` nor its memory_* aliases are
    // reachable externally, and CURATED_TOOL_OPS.memory is unset.
    expect(CURATED_TOOL_IDS).not.toContain('memory');
    expect(CURATED_TOOL_OPS.memory).toBeUndefined();
    for (const old of [
      'memory_recall',
      'memory_search',
      'memory_save',
      'memory_edit',
      'memory_forget',
    ]) {
      expect(fromMcpToolName(`snaglet_${old}`)).toBeNull();
    }
    expect(fromMcpToolName('snaglet_memory')).toBeNull();
  });

  it("leaves own_memories out of export_node's external kinds, and says where files land", () => {
    const [projected] = projectTools({
      export_node: { ...(exportNodeDefinition as ToolDefinition), categoryPath: 'x' },
    });
    const props = projected!.inputSchema.properties as Record<string, { enum?: unknown[] }>;
    expect(props.kind!.enum).toEqual(['doc', 'thread', 'image']);
    expect(EXTERNAL_ENUM_VALUES.export_node!.kind).not.toContain('own_memories');
    // The destination is on the Snaglet machine, not the caller's — an external
    // client that assumes otherwise writes somewhere surprising.
    expect(projectDescription({ id: 'export_node', description: '' })).toMatch(/Snaglet machine/i);
  });

  it('does not resolve an old id whose pinned params MCP clients cannot use', () => {
    // Each pins a value outside the external shape, so no call through it
    // could succeed: update_identity scope self, self_inspect view
    // runtime_self, workspace_project_tree scope current_project,
    // database_search kind database.
    for (const id of [
      'update_identity',
      'self_inspect',
      'workspace_project_tree',
      'database_search',
    ]) {
      expect({ id, resolved: fromMcpToolName(toMcpToolName(id)) }).toEqual({ id, resolved: null });
    }
    // Old ids whose pins fit still resolve.
    for (const id of ['doc_search', 'move_container', 'message_context', 'get_providers']) {
      expect(fromMcpToolName(toMcpToolName(id))).toBe(id);
    }
  });

  it('keeps create_image app-local: not listed, not resolvable, no external notes', () => {
    expect(CURATED_TOOL_IDS).not.toContain('create_image');
    expect(fromMcpToolName('snaglet_create_image')).toBeNull();
    expect(projectDescription({ id: 'create_image', description: 'Create image.' })).toBe(
      'Create image.'
    );
  });

  it('never exposes the removed Board post tool or its legacy board_* names', () => {
    for (const id of [
      'post',
      'board_browse',
      'board_read',
      'board_read_discussion',
      'board_post',
      'board_reply',
      'board_edit',
    ]) {
      expect(CURATED_TOOL_IDS).not.toContain(id);
    }
    expect(CURATED_TOOL_OPS.post).toBeUndefined();
  });

  it('never contains the omitted families (computer/chat/discovery/agent/admin/memory)', () => {
    const forbidden = [
      // computer tools — never expose the host shell/fs
      'shell_exec',
      'exec_command',
      'file_read',
      'file_write',
      'file_edit',
      'file_list',
      'apply_patch',
      'database_execute',
      'database_query',
      // host-account / repository integrations stay app-local
      'google_gmail',
      'google_drive',
      'google_drive_admin',
      'google_calendar',
      'google_docs',
      'google_sheets',
      'imessage',
      'git',
      // memory — agent-scoped, so excluded
      'memory_recall',
      // destructive archive edge — deny-by-default via omission
      'archive_container',
      'workspace_archive_node',
    ];
    for (const id of forbidden) {
      expect(CURATED_TOOL_IDS).not.toContain(id);
    }
  });
});

describe('name mapping', () => {
  it('prefixes internal ids at the boundary', () => {
    expect(toMcpToolName('search')).toBe('snaglet_search');
    expect(toMcpToolName('workspace_search')).toBe('snaglet_workspace_search');
    expect(MCP_TOOL_PREFIX).toBe('snaglet_');
  });

  it('round-trips every curated id', () => {
    for (const id of CURATED_TOOL_IDS) {
      expect(fromMcpToolName(toMcpToolName(id))).toBe(id);
    }
  });

  it('rejects unprefixed names', () => {
    expect(fromMcpToolName('workspace_search')).toBeNull();
  });

  it('rejects prefixed names outside the curated tier', () => {
    expect(fromMcpToolName('snaglet_shell_exec')).toBeNull();
    expect(fromMcpToolName('snaglet_memory_recall')).toBeNull();
    // ask is the canonical interactive clarification tool, but it is
    // dispatch-only and never crosses the external MCP boundary. Its
    // get_clarification alias resolves internally to ask and is likewise not an
    // externally callable or advertised MCP name.
    expect(fromMcpToolName('snaglet_ask')).toBeNull();
    expect(fromMcpToolName('snaglet_get_clarification')).toBeNull();
    expect(fromMcpToolName('snaglet_archive_container')).toBeNull();
    expect(fromMcpToolName('snaglet_google_gmail')).toBeNull();
    expect(fromMcpToolName('snaglet_google_gmail_send')).toBeNull();
    expect(fromMcpToolName('snaglet_git')).toBeNull();
    expect(fromMcpToolName('snaglet_git_push')).toBeNull();
  });
});

describe('projectTools', () => {
  it('omits canonical ask and its old get_clarification alias without widening curation', () => {
    const curatedBefore = [...CURATED_TOOL_IDS];
    const definitions: Record<string, ToolDefinition> = {
      ask: makeDef('ask', { dispatchOnly: true }),
      get_clarification: makeDef('get_clarification', { dispatchOnly: true }),
      search: makeDef('search'),
    };

    expect(projectTools(definitions).map((tool) => tool.name)).toEqual(['snaglet_search']);
    expect(projectTools(definitions).some((tool) => tool.name === 'snaglet_ask')).toBe(false);
    expect(
      projectTools(definitions).some((tool) => tool.name === 'snaglet_get_clarification')
    ).toBe(false);
    expect(CURATED_TOOL_IDS).toEqual(curatedBefore);
    expect(CURATED_TOOL_IDS).not.toContain('ask');
    expect(CURATED_TOOL_IDS).not.toContain('get_clarification');
  });

  it('projects exactly the curated tools present in the registry — nothing leaks', () => {
    const definitions: Record<string, ToolDefinition> = {};
    for (const id of CURATED_TOOL_IDS) definitions[id] = makeDef(id);
    // Registry noise that must never appear externally.
    definitions.shell_exec = makeDef('shell_exec');
    definitions.memory_recall = makeDef('memory_recall');
    definitions.list_agents = makeDef('list_agents');

    const projected = projectTools(definitions);
    expect(projected.map((t) => t.name)).toEqual(CURATED_TOOL_IDS.map((id) => `snaglet_${id}`));
  });

  it('lists canonical ids only: old names stay resolve-only, never in tools/list', () => {
    const definitions: Record<string, ToolDefinition> = {};
    for (const id of CURATED_TOOL_IDS) definitions[id] = makeDef(id);
    // Alias ids an external client may still call (and that still resolve).
    for (const old of ['thread_send', 'get_doc', 'create_agent', 'list_models']) {
      definitions[old] = makeDef(old);
      expect(fromMcpToolName(`snaglet_${old}`)).toBe(old);
    }

    const listed = projectTools(definitions).map((t) => t.name.slice(MCP_TOOL_PREFIX.length));
    expect(listed.filter((id) => isRetiredToolId(id))).toEqual([]);
    expect(CURATED_TOOL_IDS.filter((id) => isRetiredToolId(id))).toEqual([]);
  });

  it('projects doc as snaglet_doc with its schema verbatim', () => {
    const definitions: Record<string, ToolDefinition> = {
      doc: makeDef('doc', {
        parameters_schema: { type: 'object', required: ['op'], properties: { op: {} } },
      }),
    };
    const [projected] = projectTools(definitions);
    expect(projected!.name).toBe('snaglet_doc');
    expect(projected!.inputSchema).toBe(definitions.doc!.parameters_schema);
    expect(projected!.description).toContain('External (MCP) notes:');
  });

  it('uses parameters_schema verbatim as inputSchema (same reference)', () => {
    const def = makeDef('search', {
      parameters_schema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' }, scope: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    });
    const projected = projectTools({ search: def });
    expect(projected).toHaveLength(1);
    expect(projected[0]!.inputSchema).toBe(def.parameters_schema);
  });

  it('keeps the internal description and appends external guidance where defined', () => {
    const withGuidance = makeDef('node');
    const withoutGuidance = makeDef('convert_doc_to_container');

    expect(projectDescription(withGuidance)).toContain('node description');
    expect(projectDescription(withGuidance)).toContain('External (MCP) notes:');
    expect(projectDescription(withoutGuidance)).toBe('convert_doc_to_container description');
  });

  it('skips curated ids missing from the registry instead of inventing them', () => {
    const projected = projectTools({ doc: makeDef('doc') });
    expect(projected.map((t) => t.name)).toEqual(['snaglet_doc']);
  });
});

describe('op-scoped curation for merged tools', () => {
  const resolve = (id: string) =>
    id === 'memory_save'
      ? { id: 'memory', aliasedFrom: id, op: 'create' }
      : id === 'memory_forget'
        ? { id: 'memory', aliasedFrom: id, op: 'delete' }
        : { id };
  const options = {
    curatedIds: ['memory'],
    curatedOps: { memory: ['create'] },
    resolve,
  };

  it('accepts an old name whose pinned op is curated', () => {
    expect(fromMcpToolName('snaglet_memory_save', options)).toBe('memory_save');
  });

  it('rejects an old name whose pinned op is not curated', () => {
    expect(fromMcpToolName('snaglet_memory_forget', options)).toBeNull();
  });

  it('treats a merged tool absent from the op map as op-unrestricted', () => {
    expect(fromMcpToolName('snaglet_memory_forget', { ...options, curatedOps: {} })).toBe(
      'memory_forget'
    );
    expect(isExternalOpAllowed('memory', 'delete', {})).toBe(true);
  });

  it('only allows listed ops (and never a missing op) once a tool is op-curated', () => {
    expect(isExternalOpAllowed('memory', 'create', options.curatedOps)).toBe(true);
    expect(isExternalOpAllowed('memory', 'delete', options.curatedOps)).toBe(false);
    expect(isExternalOpAllowed('memory', null, options.curatedOps)).toBe(false);
  });

  it('op-curates every merged tool at exactly its decided ops', () => {
    expect(CURATED_TOOL_OPS).toEqual({
      thread: ['send', 'read', 'create', 'update', 'add_agents'],
      node: ['get', 'tree', 'move'],
      doc: ['get', 'outline', 'create', 'update', 'convert-to-container'],
      container: ['create', 'update'],
      agent: ['abort', 'create', 'get', 'list', 'update'],
      model: ['list'],
      table: ['read', 'write', 'schema'],
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
      automation: ['create', 'list', 'get', 'update', 'disable', 'enable', 'cancel', 'run', 'runs'],
    });
  });

  it('keeps doc(op) to the get, outline, create, update and convert external surface', () => {
    for (const op of ['get', 'outline', 'create', 'update', 'convert-to-container']) {
      expect(isExternalOpAllowed('doc', op)).toBe(true);
    }
    for (const op of [
      'delete',
      'duplicate',
      'diff',
      'snapshot',
      'list-snapshots',
      'restore',
      'delete-snapshot',
      null,
    ]) {
      expect(isExternalOpAllowed('doc', op)).toBe(false);
    }
    for (const id of ['get_doc', 'create_doc', 'edit_doc', 'workspace_edit_doc']) {
      expect(fromMcpToolName(toMcpToolName(id))).toBe(id);
    }
    // delete_doc was never curated and must stay unresolvable.
    for (const id of ['delete_doc', 'workspace_delete_doc']) {
      expect(fromMcpToolName(toMcpToolName(id))).toBeNull();
    }
    // Conversion keeps its external alias; the other doc ops stay internal.
    expect(fromMcpToolName('snaglet_convert_doc_to_container')).toBe('convert_doc_to_container');
    for (const id of ['doc_history', 'diff_doc', 'duplicate_doc']) {
      expect(fromMcpToolName(toMcpToolName(id))).toBeNull();
    }
  });

  it('keeps container(op) to the create and update external surface', () => {
    for (const op of ['create', 'update']) {
      expect(isExternalOpAllowed('container', op)).toBe(true);
    }
    for (const op of ['delete', 'archive', null]) {
      expect(isExternalOpAllowed('container', op)).toBe(false);
    }
    for (const id of [
      'container',
      'create_container',
      'update_container',
      'workspace_create_container',
      'workspace_update_container',
    ]) {
      expect(fromMcpToolName(toMcpToolName(id))).toBe(id);
    }
    // archive/move of containers stay on node (archive never curated).
    expect(fromMcpToolName('snaglet_archive_container')).toBeNull();
  });

  it('keeps node(op) to the get, tree and move external surface', () => {
    for (const op of ['get', 'tree', 'move']) {
      expect(isExternalOpAllowed('node', op)).toBe(true);
    }
    for (const op of ['rename', 'archive', 'restore', null]) {
      expect(isExternalOpAllowed('node', op)).toBe(false);
    }
    for (const id of ['get_node', 'workspace_tree', 'move', 'verify_ids']) {
      // get/tree/move are curated, so these names resolve; batch get is
      // refused by the gateway (McpGatewayService.node test).
      expect(fromMcpToolName(toMcpToolName(id))).toBe(id);
    }
    for (const id of [
      'rename',
      'workspace_rename',
      'archive_node',
      'restore_node',
      'archive_container',
      'workspace_restore_node',
    ]) {
      expect(fromMcpToolName(toMcpToolName(id))).toBeNull();
    }
  });
});

/**
 * Every op of the externally exposed tools has an explicit allow / deny.
 * CURATED_TOOL_OPS is an allow list, so an op added to one of these tools later
 * stays denied externally until it is curated; and because each case below also
 * checks that its allow ∪ deny lists cover the tool's whole op enum, adding an
 * op fails this test until the new op is decided here.
 */
describe('external exposure: every op decided', () => {
  const DEFINITIONS: Record<string, ToolDefinition> = {
    doc: docDefinition as ToolDefinition,
    table: tableDefinition as ToolDefinition,
    agent: agentDefinition as ToolDefinition,
    calendar: calendarDefinition as ToolDefinition,
    automation: automationDefinition as ToolDefinition,
  };
  const decide = (toolId: string, allow: string[], deny: Array<string | null>) => {
    const decided = new Set<string | null>([...allow, ...deny]);
    const undecided = toolOpEnum({
      parametersSchema: DEFINITIONS[toolId]!.parameters_schema,
    }).filter((op) => !decided.has(op));
    expect({ toolId, undecided }).toEqual({ toolId, undecided: [] });
    for (const op of allow)
      expect({ toolId, op, allowed: isExternalOpAllowed(toolId, op) }).toEqual({
        toolId,
        op,
        allowed: true,
      });
    for (const op of deny)
      expect({ toolId, op, allowed: isExternalOpAllowed(toolId, op) }).toEqual({
        toolId,
        op,
        allowed: false,
      });
  };

  it('doc: get, outline, create, update, convert-to-container; the rest stay app-local', () => {
    decide(
      'doc',
      ['get', 'outline', 'create', 'update', 'convert-to-container'],
      [
        'delete',
        'duplicate',
        'diff',
        'snapshot',
        'list-snapshots',
        'restore',
        'delete-snapshot',
        'read',
      ]
    );
  });

  it('table: read, write and schema; fields, query and delete (entries) stay app-local', () => {
    expect(CURATED_TOOL_OPS.table).toEqual(['read', 'write', 'schema']);
    decide('table', ['read', 'write', 'schema'], ['fields', 'query', 'delete', null]);
  });

  it('agent: update joins abort, create, get, list; archive, restore, activity stay denied', () => {
    decide(
      'agent',
      ['abort', 'create', 'get', 'list', 'update'],
      ['archive', 'restore', 'activity']
    );
  });

  it('calendar: every op but delete_event', () => {
    decide(
      'calendar',
      [
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
      ['delete_event', null]
    );
  });

  it('automation: every op (writes are own-only in the gateway)', () => {
    decide(
      'automation',
      ['create', 'list', 'get', 'update', 'disable', 'enable', 'cancel', 'run', 'runs'],
      [null]
    );
  });

  it('the old calendar names resolve only to their exposed family', () => {
    expect(fromMcpToolName('snaglet_calendar_read')).toBe('calendar_read');
    expect(fromMcpToolName('snaglet_calendar_write')).toBe('calendar_write');
    expect(fromMcpToolName('snaglet_table_delete')).toBeNull();
    for (const id of ['table_read', 'table_write', 'table_schema']) {
      expect(fromMcpToolName(toMcpToolName(id))).toBe(id);
    }
  });

  it('puts each new tool’s external limits in its schema, and the rest in guidance', () => {
    expect(projectDescription({ id: 'doc', description: 'Doc.' })).toMatch(
      /Read a doc with op get/
    );
    const shaped = projectTools({
      table: { ...(tableDefinition as ToolDefinition), categoryPath: 'x' },
      calendar: { ...(calendarDefinition as ToolDefinition), categoryPath: 'x' },
    });
    const table = shaped[0]!.inputSchema.properties as Record<string, Record<string, unknown>>;
    const ops = table.ops as {
      description: string;
      items: { properties: { op: { enum: string[] } } };
    };
    expect(ops.items.properties.op.enum).toEqual([...EXTERNAL_TABLE_SCHEMA_OPS.allowed]);
    for (const op of EXTERNAL_TABLE_SCHEMA_OPS.allowed) expect(ops.description).toContain(op);
    for (const op of [...EXTERNAL_TABLE_SCHEMA_OPS.denied, 'clear_repeats']) {
      expect(ops.description).not.toContain(op);
    }
    expect((table.op as { enum: string[] }).enum).toEqual(['read', 'write', 'schema']);
    const calendar = shaped[1]!.inputSchema.properties as Record<string, { enum: string[] }>;
    expect(calendar.op!.enum).not.toContain('delete_event');
    expect(projectDescription({ id: 'automation', description: 'A.' })).toMatch(
      /only on automations your MCP member created/
    );
  });
});

/**
 * Calendar coupling. External callers reach table rows (query, list's bound
 * fields, row reminders, the occurrence writes) and automation wakes and
 * reminders through the calendar. The calendar derives an external caller's
 * access from the curation (externalCalendarAccess, used by
 * calendar/access.ts), so narrowing table or automation narrows the calendar.
 * These tests pin the derivation and the current result, which is what the
 * calendar guidance and docs promise.
 */
describe('calendar coupling: calendar access is derived from table and automation exposure', () => {
  const FULL = { tableRead: true, tableWrite: true, automationRead: true };
  const ops = (toolId: string, list: readonly string[]) => ({
    curatedOps: { ...CURATED_TOOL_OPS, [toolId]: list },
  });

  it('today: rows (read and write) and wakes; set_reminders on an automation is own-only', () => {
    expect(CURATED_TOOL_IDS).toContain('calendar');
    expect(externalCalendarAccess()).toEqual({ ...FULL, automationWrite: 'own' });
  });

  it('rows follow table op read and op write', () => {
    expect(externalCalendarAccess(ops('table', ['write', 'schema']))).toMatchObject({
      ...FULL,
      tableRead: false,
    });
    expect(externalCalendarAccess(ops('table', ['read', 'schema']))).toMatchObject({
      ...FULL,
      tableWrite: false,
    });
    expect(
      externalCalendarAccess({ curatedIds: CURATED_TOOL_IDS.filter((id) => id !== 'table') })
    ).toMatchObject({ ...FULL, tableRead: false, tableWrite: false });
  });

  it('wakes and automation reminders follow automation op list, open to every automation', () => {
    const allButList = CURATED_TOOL_OPS.automation!.filter((op) => op !== 'list');
    expect(externalCalendarAccess(ops('automation', allButList))).toMatchObject({
      ...FULL,
      automationRead: false,
    });
    expect(
      externalCalendarAccess({
        automationOps: { open: EXTERNAL_AUTOMATION_OPS.open.filter((op) => op !== 'list') },
      })
    ).toMatchObject({ ...FULL, automationRead: false });
    expect(
      externalCalendarAccess({ curatedIds: CURATED_TOOL_IDS.filter((id) => id !== 'automation') })
    ).toEqual({ ...FULL, automationRead: false, automationWrite: 'none' });
  });

  it('set_reminders on an automation counts as automation update: any, own-only or none', () => {
    expect(
      externalCalendarAccess({
        automationOps: { open: [...EXTERNAL_AUTOMATION_OPS.open, 'update'] },
      }).automationWrite
    ).toBe('any');
    const allButUpdate = CURATED_TOOL_OPS.automation!.filter((op) => op !== 'update');
    expect(externalCalendarAccess(ops('automation', allButUpdate)).automationWrite).toBe('none');
  });
});

/**
 * Fail-closed drift. The external schema-op allow list and
 * the automation own-only default each classify every op the tool has; an op
 * added to the tool fails here until it is put on one side.
 */
describe('external policy sets classify every op', () => {
  it('table schema: allowed ∪ denied is exactly the schema tool’s ops (SCHEMA_OP_KEYS)', () => {
    const { allowed, denied } = EXTERNAL_TABLE_SCHEMA_OPS;
    expect([...allowed, ...denied].sort()).toEqual(Object.keys(SCHEMA_OP_KEYS).sort());
    expect(allowed.filter((op) => (denied as readonly string[]).includes(op))).toEqual([]);
    expect([...denied].sort()).toEqual([
      'archive_field',
      'archive_table',
      'delete_field',
      'delete_table',
    ]);
  });

  it('automation: open ∪ own-only is exactly the tool’s op enum', () => {
    const { open, ownOnly } = EXTERNAL_AUTOMATION_OPS;
    const ops = toolOpEnum({
      parametersSchema: (automationDefinition as ToolDefinition).parameters_schema,
    });
    expect([...open, ...ownOnly].sort()).toEqual([...ops].sort());
    expect([...open].sort()).toEqual(['create', 'get', 'list', 'runs']);
  });
});

describe('published external params', () => {
  it('automation’s external inputSchema publishes thread_id and agent_id; the in-app schema does not', () => {
    const def = { ...(automationDefinition as ToolDefinition), categoryPath: 'automations' };
    const [projected] = projectTools({ automation: def });
    const properties = projected!.inputSchema.properties as Record<string, unknown>;
    expect(properties.thread_id).toEqual(def.unlisted_params!.thread_id);
    expect(properties.agent_id).toEqual(def.unlisted_params!.agent_id);
    expect(properties.op).toBe((def.parameters_schema.properties as Record<string, unknown>).op);
    const inApp = def.parameters_schema.properties as Record<string, unknown>;
    expect(inApp.thread_id).toBeUndefined();
    expect(inApp.agent_id).toBeUndefined();
  });
});

describe('the external inputSchema: unlisted fields published, unusable ones left out', () => {
  /**
   * The external field names, written out: a field that enters or leaves the
   * external schema (EXTERNAL_PUBLISHED_PARAMS, EXTERNAL_OP_PARAMS) must
   * change this list too.
   */
  const PUBLISHED: Array<[string, ToolDefinition, string[]]> = [
    [
      'agent',
      agentDefinition as ToolDefinition,
      [
        'agent_id',
        'identity',
        'include_archived',
        'listAll',
        'model_id',
        'name',
        'op',
        'provider',
        'role',
        'scope',
        'system_prompt',
        'thread_id',
        'tool_access_mode',
      ],
    ],
    [
      'automation',
      automationDefinition as ToolDefinition,
      [
        'agent_id',
        'before',
        'calendar_id',
        'id',
        'limit',
        'mine',
        'name',
        'op',
        'prompt',
        'status',
        'thread_id',
        'when',
      ],
    ],
    [
      'calendar',
      calendarDefinition as ToolDefinition,
      [
        'all_day',
        'at_start',
        'automation_id',
        'before',
        'calendar',
        'calendars',
        'clear',
        'color',
        'cursor',
        'date',
        'days',
        'description',
        'enabled',
        'end',
        'entry_id',
        'field',
        'fields',
        'from',
        'id',
        'kinds',
        'limit',
        'location',
        'move_to',
        'occurrence',
        'op',
        'project_id',
        'range',
        'repeats',
        'rev',
        'sound',
        'start',
        'status',
        'table',
        'tables',
        'text',
        'title',
        'to',
        'tz',
      ],
    ],
    [
      'doc',
      docDefinition as ToolDefinition,
      [
        'allow_archived',
        'category',
        'content',
        'create_backup',
        'edits',
        'id',
        'include_archived',
        'op',
        'parent_id',
        'parent_path',
        'path',
        'raw',
        'sort_order',
        'title',
        'validate_only',
      ],
    ],
    [
      'node',
      nodeDefinition as ToolDefinition,
      [
        'allow_archived',
        'id',
        'include_archived',
        'include_children',
        'kind',
        'kinds',
        'name',
        'op',
        'parent_id',
        'parent_path',
        'path',
        'sort_order',
      ],
    ],
    [
      'table',
      tableDefinition as ToolDefinition,
      [
        'columns',
        'fields',
        'ids',
        'insert',
        'limit',
        'max_cell',
        'op',
        'ops',
        'page',
        'repeat',
        'sort',
        'sql',
        'table',
        'update',
        'where',
      ],
    ],
  ];

  /** Fields whose external schema is narrowed (enum values, a replaced property). */
  const NARROWED: Record<string, string[]> = { agent: ['scope', 'listAll'], table: ['ops'] };

  it.each(PUBLISHED)(
    'snaglet_%s publishes exactly the fields an external caller may use',
    (id, def, names) => {
      const [projected] = projectTools({ [id]: { ...def, categoryPath: 'x' } });
      const external = projected!.inputSchema.properties as Record<string, unknown>;
      const inApp = def.parameters_schema.properties as Record<string, unknown>;
      const unlisted = def.unlisted_params ?? {};
      expect(Object.keys(unlisted).length).toBeGreaterThan(0);
      for (const field of Object.keys(unlisted)) expect(inApp).not.toHaveProperty(field);
      expect(Object.keys(external).sort()).toEqual(names);
      const source = { ...inApp, ...unlisted };
      for (const field of names) {
        if (field === 'op' || NARROWED[id]?.includes(field)) continue;
        expect({ field, schema: external[field] }).toEqual({ field, schema: source[field] });
      }
      // op keeps the definition's order, cut to the curated ops.
      const ops = (source.op as { enum: string[] }).enum;
      expect((external.op as { enum: string[] }).enum).toEqual(
        ops.filter((op) => !CURATED_TOOL_OPS[id] || CURATED_TOOL_OPS[id]!.includes(op))
      );
    }
  );
});

describe('external descriptions drop the in-app pointer to unlisted fields', () => {
  const WITH_POINTER: Array<[string, ToolDefinition]> = [
    ['agent', agentDefinition as ToolDefinition],
    ['automation', automationDefinition as ToolDefinition],
    ['calendar', calendarDefinition as ToolDefinition],
    ['doc', docDefinition as ToolDefinition],
    ['node', nodeDefinition as ToolDefinition],
    ['search', searchDefinition as ToolDefinition],
    ['table', tableDefinition as ToolDefinition],
    ['thread', threadDefinition as ToolDefinition],
  ];

  it.each(WITH_POINTER)(
    'snaglet_%s: no tool op:schema pointer (MCP clients have the full schema and no op schema)',
    (id, def) => {
      expect(def.description).toContain(`tool({op:"schema", name:"${id}"})`);
      const [projected] = projectTools({ [id]: { ...def, categoryPath: 'x' } });
      expect(projected!.description).not.toContain('unlisted_parameters');
      expect(projected!.description).not.toContain('op:"schema"');
      // Everything before the pointer survives, word for word.
      const before = def.description.slice(0, def.description.indexOf('tool({op:"schema"'));
      const kept = before.slice(
        0,
        Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n')) + 1
      );
      expect(kept.length).toBeGreaterThan(0);
      expect(projected!.description.startsWith(kept)).toBe(true);
    }
  );

  it('removes only the pointer sentence, keeping the sentences around it', () => {
    const description =
      'First (e.g. one). Rare fields are not listed: tool({op:"schema", name:"x"}) returns them as unlisted_parameters. Last.';
    expect(projectDescription({ id: 'x', description })).toBe('First (e.g. one). Last.');
  });

  it('leaves a description without the pointer unchanged', () => {
    expect(projectDescription({ id: 'x', description: 'Plain. Text.' })).toBe('Plain. Text.');
  });
});

describe('snaglet_thread external inputSchema: admin fields unlisted in-app stay published', () => {
  const def = threadDefinition as ToolDefinition;
  const [projected] = projectTools({ thread: def });
  const external = projected!.inputSchema.properties as Record<string, Record<string, unknown>>;
  const inApp = def.parameters_schema.properties as Record<string, unknown>;

  it("publishes the create system_prompt verbatim and update's `thread` without tool access", () => {
    expect(external.system_prompt).toEqual(def.unlisted_params!.system_prompt);
    const inner = (def.unlisted_params!.thread as { properties: Record<string, unknown> })
      .properties;
    const published = external.thread!.properties as Record<string, unknown>;
    expect(Object.keys(published).sort()).toEqual(
      Object.keys(inner)
        .filter((field) => !field.startsWith('tool_access_'))
        .sort()
    );
    for (const field of Object.keys(published)) expect(published[field]).toEqual(inner[field]);
  });

  it('publishes agent_ids (create and add_agents) and does not publish participants or agent_id', () => {
    expect(external.agent_ids).toEqual(inApp.agent_ids);
    expect(external.participants).toBeUndefined();
    expect(inApp.participants).toBeUndefined();
    expect(external.agent_id).toBeUndefined();
    expect(def.unlisted_params).not.toHaveProperty('participants');
  });

  it('keeps the admin fields out of the in-app schema', () => {
    for (const field of ['thread', 'system_prompt']) expect(inApp[field]).toBeUndefined();
  });
});

describe('external shape: every allowed param exists, and the gateway check follows it', () => {
  const DEFS: Record<string, ToolDefinition> = {
    agent: agentDefinition as ToolDefinition,
    thread: threadDefinition as ToolDefinition,
    model: modelDefinition as ToolDefinition,
    node: nodeDefinition as ToolDefinition,
    container: containerDefinition as ToolDefinition,
    table: tableDefinition as ToolDefinition,
    doc: docDefinition as ToolDefinition,
  };

  it.each(Object.keys(EXTERNAL_OP_PARAMS))(
    '%s: one entry per curated op, each naming real params',
    (id) => {
      expect(Object.keys(EXTERNAL_OP_PARAMS[id]!).sort()).toEqual(
        [...CURATED_TOOL_OPS[id]!].sort()
      );
      const def = DEFS[id]!;
      const all: Record<string, { properties?: Record<string, unknown> }> = {
        ...(def.parameters_schema.properties as Record<
          string,
          { properties?: Record<string, unknown> }
        >),
        ...((def.unlisted_params ?? {}) as Record<
          string,
          { properties?: Record<string, unknown> }
        >),
      };
      // A param only external callers take (agent listAll) has its own
      // external property schema instead of a definition entry.
      const [projected] = projectTools({ [id]: { ...def, categoryPath: 'x' } });
      const external = projected!.inputSchema.properties as Record<string, unknown>;
      for (const entry of Object.values(EXTERNAL_OP_PARAMS[id]!).flat()) {
        const [name, field] = entry.split('.');
        const known = name! in all || name! in external;
        expect({ id, entry, known }).toEqual({ id, entry, known: true });
        if (field) expect(all[name!]!.properties).toHaveProperty(field);
      }
    }
  );

  it('takes each doc op with its own fields, outline and raw included', () => {
    const doc = docDefinition as ToolDefinition;
    expect(
      externalArgsError(doc, 'outline', { id: 'doc-1', include_archived: true }, 'snaglet_doc')
    ).toBeNull();
    expect(externalArgsError(doc, 'get', { doc_id: 'doc-1', raw: true }, 'snaglet_doc')).toBeNull();
    expect(
      externalArgsError(doc, 'update', { id: 'd', edits: [], raw: true }, 'snaglet_doc')
    ).toBeNull();
    expect(externalArgsError(doc, 'outline', { id: 'doc-1', raw: true }, 'snaglet_doc')).toContain(
      '`raw` is not a parameter of snaglet_doc op outline for MCP clients; it takes '
    );
    expect(externalArgsError(doc, 'get', { id: 'doc-1', force: true }, 'snaglet_doc')).toContain(
      '`force` is not a parameter of snaglet_doc op get for MCP clients; it takes '
    );
  });

  it('refuses a param, an object field or an enum value outside the shape, in a short error', () => {
    const thread = threadDefinition as ToolDefinition;
    expect(
      externalArgsError(thread, 'update', { id: 't', thread: { title: 'x' } }, 'snaglet_thread')
    ).toBeNull();
    expect(
      externalArgsError(
        thread,
        'update',
        { id: 't', thread: { tool_access_mode: 'all' } },
        'snaglet_thread'
      )
    ).toBe(
      '`thread.tool_access_mode` is not a parameter of snaglet_thread op update for MCP clients; ' +
        'thread takes title, project_id, dispatch_mode, system_prompt, max_waves, ' +
        'max_total_output_tokens, max_agent_dispatches, working_directory. Anything else stays ' +
        'in the Snaglet app.'
    );
    expect(
      externalArgsError(
        thread,
        'send',
        { id: 't', content: 'x', sender_agent_id: 'a' },
        'snaglet_thread'
      )
    ).toBe(
      '`sender_agent_id` is not a parameter of snaglet_thread op send for MCP clients; it takes id, ' +
        'content. Anything else stays in the Snaglet app.'
    );
    // param_aliases names count as the param they stand for.
    expect(externalArgsError(thread, 'read', { thread_id: 't' }, 'snaglet_thread')).toBeNull();
    // An old id's rename counts too, where the gateway reports it.
    expect(
      externalArgsError(
        nodeDefinition as ToolDefinition,
        'move',
        { new_parent_id: 'c' },
        'snaglet_move',
        (name) => (name === 'new_parent_id' ? ['parent_id'] : [])
      )
    ).toBeNull();
    expect(
      externalArgsError(
        searchDefinition as ToolDefinition,
        null,
        { kind: 'database' },
        'snaglet_search'
      )
    ).toBe(
      '`kind` must be one of all, workspace, docs, containers, conversations, files, code for MCP clients.'
    );
  });
});
