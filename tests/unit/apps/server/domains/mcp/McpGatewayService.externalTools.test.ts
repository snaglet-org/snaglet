/**
 * External MCP tools at the MCP boundary: the decided allow / deny of every op of
 * the newly exposed tools (table, calendar, automation, agent update) and the
 * doc unknown-op message, through the real tool definitions, alias registry
 * and curation map. A denied call never reaches the executor.
 */
const getDefinitionMock = jest.fn();
const executeMock = jest.fn();
const findAutomation = jest.fn();
const findAgent = jest.fn();

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    load: jest.fn().mockResolvedValue(undefined),
    getDefinition: (...args: unknown[]) => getDefinitionMock(...args),
    getAllDefinitions: jest.fn().mockReturnValue({}),
  },
}));
jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: { execute: (...args: unknown[]) => executeMock(...args) },
}));
jest.mock('@snaglet/db', () => ({ Containers: {}, Projects: {} }));
jest.mock('@snaglet/db/tables/automations', () => ({
  Automations: { findById: (...args: unknown[]) => findAutomation(...args) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgent(...args) },
}));
jest.mock('@server/realtime/actorContext', () => ({
  runWithActor: (_actor: unknown, operation: () => unknown) => operation(),
}));

import { mcpGatewayService } from '@server/domains/mcp/McpGatewayService';
import agentDefinition from '@server/services/ToolService/tools/agents/agent/definition';
import automationDefinition from '@server/services/ToolService/tools/automations/automation/definition';
import calendarDefinition from '@server/services/ToolService/tools/calendar/calendar/definition';
import tableDefinition from '@server/services/ToolService/tools/tables/table/definition';
import docDefinition from '@server/services/ToolService/tools/docs/doc/definition';
import threadDefinition from '@server/services/ToolService/tools/threads/thread/definition';
import exportNodeDefinition from '@server/services/ToolService/tools/workspace/export-node/definition';
import createImageDefinition from '@server/services/ToolService/tools/media/create-image/definition';
import { HELPER_ROW_EDIT_REFUSAL } from '@server/services/subagents/subagentText';

const caller = { memberId: 'member-1', name: 'External test' };
const DEFINITIONS: Record<string, unknown> = {
  agent: agentDefinition,
  automation: automationDefinition,
  calendar: calendarDefinition,
  table: tableDefinition,
  doc: docDefinition,
  thread: threadDefinition,
  export_node: exportNodeDefinition,
  create_image: createImageDefinition,
};

const call = (name: string, args: Record<string, unknown>) =>
  mcpGatewayService.executeExternalToolCall(name, args, caller);

function text(result: Awaited<ReturnType<typeof call>>): string {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : '';
}

async function expectRuns(name: string, args: Record<string, unknown>) {
  const result = await call(name, args);
  expect({ name, args, error: result.isError ? text(result) : null }).toEqual({
    name,
    args,
    error: null,
  });
  expect(executeMock).toHaveBeenCalledTimes(1);
}

async function expectDenied(name: string, args: Record<string, unknown>, message: RegExp) {
  const result = await call(name, args);
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(message);
  expect(executeMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  getDefinitionMock.mockImplementation((id: string) => DEFINITIONS[id]);
  executeMock.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
  findAutomation.mockResolvedValue(null);
  findAgent.mockResolvedValue({ id: 'agent-1', parentAgentId: null });
});

describe('doc: an op the tool does not have is named as such', () => {
  it('op read is not an op of snaglet_doc and lists the external ops (no alias to get)', async () => {
    await expectDenied(
      'snaglet_doc',
      { op: 'read', id: 'doc-1' },
      /^`read` is not an op of snaglet_doc; external ops: get, outline, create, update, convert-to-container\.$/
    );
  });

  it('get still runs; a real but uncurated op is still a policy denial', async () => {
    await expectRuns('snaglet_doc', { op: 'get', id: 'doc-1' });
    executeMock.mockClear();
    await expectDenied(
      'snaglet_doc',
      { op: 'delete', id: 'doc-1' },
      /^Denied: op `delete` of snaglet_doc is not available to external MCP clients\.$/
    );
  });
});

describe('table', () => {
  it.each([
    [{ op: 'read' }],
    [{ op: 'read', table: 'tasks' }],
    [{ op: 'read', table: 'tasks', ids: ['11111111-1111-4111-8111-111111111111'] }],
    [{ op: 'read', sql: 'SELECT 1' }],
    [{ op: 'write', table: 'tasks', insert: [{ values: { name: 'x' } }] }],
    [{ op: 'write', table: 'tasks', update: [{ id: 'e1', rev: 'abcdef01', values: {} }] }],
    [{ op: 'write', table: 'tasks', repeat: [{ id: 'e1', field: 'due', done: true }] }],
    [{ op: 'schema', table: 'tasks', fields: [{ name: 'due', type: 'date' }] }],
  ])('allows %j', async (args) => {
    await expectRuns('snaglet_table', args);
  });

  it.each([
    'add_field',
    'update_field',
    'reorder_fields',
    'rename_table',
    'set_title_field',
    'restore_field',
    'restore_table',
    'set_project',
  ])('allows schema op %s', async (op) => {
    await expectRuns('snaglet_table', { op: 'schema', table: 'tasks', ops: [{ op }] });
  });

  it.each(['archive_field', 'delete_field', 'archive_table', 'delete_table'])(
    'denies schema op %s, alone or among allowed ones',
    async (op) => {
      await expectDenied(
        'snaglet_table',
        { op: 'schema', table: 'tasks', ops: [{ op }] },
        new RegExp(`^Denied: table schema \`${op}\` is app-local for external MCP clients`)
      );
      await expectDenied(
        'snaglet_table',
        { op: 'schema', table: 'tasks', ops: [{ op: 'add_field' }, { op }] },
        /Nothing was changed/
      );
    }
  );

  it('allows a date field’s repeats and calendar, and repeats off', async () => {
    await expectRuns('snaglet_table', {
      op: 'schema',
      table: 'tasks',
      ops: [
        {
          op: 'add_field',
          field: { name: 'due', type: 'date', repeats: true, calendar: 'Work' },
        },
        { op: 'update_field', name: 'due', set: { repeats: false }, clear_repeats: false },
      ],
    });
  });

  it.each([true, 'yes'])(
    'denies clear_repeats %j (it removes every row’s repeat), even beside allowed ops',
    async (clear) => {
      await expectDenied(
        'snaglet_table',
        {
          op: 'schema',
          table: 'tasks',
          ops: [
            { op: 'add_field', field: { name: 'note', type: 'text' } },
            { op: 'update_field', name: 'due', set: { repeats: false }, clear_repeats: clear },
          ],
        },
        /^Denied: table schema `clear_repeats` is app-local for external MCP clients: it removes every row's repeat\. Nothing was changed;/
      );
    }
  );

  it('denies delete (entries), by op and by its old name', async () => {
    await expectDenied(
      'snaglet_table',
      { op: 'delete', table: 'tasks', ids: ['e1'] },
      /^Denied: op `delete` of snaglet_table is not available to external MCP clients\.$/
    );
    await expectDenied(
      'snaglet_table_delete',
      { table: 'tasks', ids: ['e1'] },
      /^Denied: snaglet_table_delete is not available to external MCP clients; it stays in the Snaglet app\./
    );
  });
});

describe('agent update', () => {
  it.each([
    [{ agent_id: 'agent-1', name: 'Renamed' }],
    [{ agent_id: 'agent-1', role: 'Reviewer', identity: 'Careful.' }],
    [{ agent_id: 'agent-1', provider: 'anthropic', model_id: 'claude-x' }],
    [{ agent_id: 'agent-1', scope: 'agent', name: 'Renamed' }],
  ])('allows %j', async (args) => {
    await expectRuns('snaglet_agent', { op: 'update', ...args });
  });

  it.each(['system_prompt', 'tool_access_mode', 'add_skills', 'remove_skills', 'set_skills'])(
    'denies %s',
    async (field) => {
      await expectDenied(
        'snaglet_agent',
        {
          op: 'update',
          agent_id: 'agent-1',
          name: 'x',
          [field]: field.endsWith('skills') ? ['s'] : 'v',
        },
        new RegExp(
          `^Denied: \`${field}\` is not a parameter of snaglet_agent op update for MCP clients`
        )
      );
    }
  );

  it('denies the unlisted tool_access_* lists too (anything outside the allowed fields)', async () => {
    await expectDenied(
      'snaglet_agent',
      { op: 'update', agent_id: 'agent-1', tool_access_allow_list: ['shell'] },
      /^Denied: `tool_access_allow_list` is not a parameter of snaglet_agent op update/
    );
  });

  it('denies scope self; update_identity (which pins it) is app-local', async () => {
    await expectDenied(
      'snaglet_agent',
      { op: 'update', scope: 'self', name: 'x' },
      /^Denied: `scope` must be one of agent for MCP clients/
    );
    // An old id that pins what MCP clients cannot use is named as app-local,
    // not refused for a param the caller never sent.
    for (const name of ['snaglet_update_identity', 'snaglet_self_inspect']) {
      await expectDenied(
        name,
        { name: 'x' },
        new RegExp(
          `^Denied: ${name} is not available to external MCP clients; it stays in the Snaglet app\\.`
        )
      );
    }
  });

  it.each(['archive', 'restore', 'activity'])('keeps %s denied', async (op) => {
    await expectDenied(
      'snaglet_agent',
      { op, agent_id: 'agent-1' },
      /is not available to external/
    );
  });
});

describe('agent get and create', () => {
  it.each([[{}], [{ listAll: true }]])('get %j runs as the slim roster', async (args) => {
    await expectRuns('snaglet_agent', { op: 'get', ...args });
    const [callArg] = executeMock.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(callArg.input).toMatchObject({ op: 'get', listAll: true });
  });

  it('get refuses listAll false (get is always the roster for MCP clients)', async () => {
    await expectDenied(
      'snaglet_agent',
      { op: 'get', listAll: false },
      /^Denied: `listAll` must be one of true for MCP clients/
    );
  });

  it('get refuses a single-agent view', async () => {
    await expectDenied(
      'snaglet_agent',
      { op: 'get', agent: 'Venus' },
      /^Denied: `agent` is not a parameter of snaglet_agent op get for MCP clients/
    );
  });

  it.each(['skills', 'tool_access_allow_list'])('create refuses %s', async (field) => {
    await expectDenied(
      'snaglet_agent',
      { op: 'create', name: 'New', [field]: ['s'] },
      new RegExp(
        `^Denied: \`${field}\` is not a parameter of snaglet_agent op create for MCP clients`
      )
    );
  });

  it('create runs with the published fields', async () => {
    await expectRuns('snaglet_agent', { op: 'create', name: 'New', role: 'Reviewer' });
  });
});

describe('calendar', () => {
  it.each([
    'list',
    'query',
    'focus',
    'dates',
    'get_event',
    'get_reminders',
    'create_event',
    'update_event',
    'restore_event',
    'move_occurrence',
    'complete_occurrence',
    'skip_occurrence',
    'set_reminders',
  ])('allows %s', async (op) => {
    await expectRuns('snaglet_calendar', { op });
  });

  it('denies delete_event, by name and through calendar_write', async () => {
    await expectDenied(
      'snaglet_calendar',
      { op: 'delete_event', id: 'event-1', rev: '1' },
      /^Denied: op `delete_event` of snaglet_calendar is not available to external MCP clients\.$/
    );
    await expectDenied(
      'snaglet_calendar_write',
      { op: 'delete_event', id: 'event-1', rev: '1' },
      /`delete_event` of snaglet_calendar_write is not available/
    );
  });
});

describe('automation', () => {
  it.each([
    [{ op: 'list' }],
    [{ op: 'list', status: 'all', mine: false }],
    [{ op: 'get', id: 'automation-1' }],
    [{ op: 'runs', id: 'automation-1' }],
  ])('allows the read %j for any automation', async (args) => {
    findAutomation.mockResolvedValue({ id: 'automation-1', createdByMemberId: 'someone-else' });
    await expectRuns('snaglet_automation', args);
  });

  it('create needs explicit thread_id and agent_id', async () => {
    const create = { op: 'create', name: 'n', prompt: 'p', when: { in: '1h' } };
    await expectDenied(
      'snaglet_automation',
      create,
      /^Denied: automation create needs explicit thread_id and agent_id/
    );
    await expectDenied(
      'snaglet_automation',
      { ...create, thread_id: 'thread-1' },
      /needs explicit agent_id for external/
    );
    await expectRuns('snaglet_automation', {
      ...create,
      thread_id: 'thread-1',
      agent_id: 'agent-1',
    });
  });

  it.each(['update', 'disable', 'enable', 'cancel', 'run'])(
    '%s runs on an automation this member created and is denied on another’s',
    async (op) => {
      findAutomation.mockResolvedValue({ id: 'automation-1', createdByMemberId: 'member-1' });
      await expectRuns('snaglet_automation', { op, id: 'automation-1' });
      executeMock.mockClear();
      for (const createdBy of ['member-2', null]) {
        findAutomation.mockResolvedValue({ id: 'automation-1', createdByMemberId: createdBy });
        await expectDenied(
          'snaglet_automation',
          { op, id: 'automation-1' },
          new RegExp(
            `^Denied: automation ${op} works only on automations this MCP key's member created`
          )
        );
      }
    }
  );

  it('a missing automation is left to the tool’s own not-found', async () => {
    findAutomation.mockResolvedValue(null);
    await expectRuns('snaglet_automation', { op: 'disable', id: 'automation-missing' });
  });
});

describe('external tool edge cases', () => {
  it('agent update on a subagent helper is refused (its row is Snaglet’s), a normal agent’s runs', async () => {
    findAgent.mockResolvedValue({ id: 'helper-1', parentAgentId: 'agent-1' });
    await expectDenied(
      'snaglet_agent',
      { op: 'update', agent_id: 'helper-1', name: 'x' },
      new RegExp(`^Denied: ${HELPER_ROW_EDIT_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    );
    expect(findAgent).toHaveBeenCalledWith('helper-1');
    findAgent.mockResolvedValue({ id: 'agent-1', parentAgentId: null });
    await expectRuns('snaglet_agent', { op: 'update', agent_id: 'agent-1', name: 'x' });
  });

  it('table schema fails closed: an unclassified or malformed op is refused', async () => {
    await expectDenied(
      'snaglet_table',
      { op: 'schema', table: 'tasks', ops: [{ op: 'drop_everything' }] },
      /^Denied: table schema `drop_everything` is app-local for external MCP clients \(they may run add_field, /
    );
    await expectDenied(
      'snaglet_table',
      { op: 'schema', table: 'tasks', ops: [{ name: 'x' }] },
      /^Denied: table schema `\(none\)` is app-local/
    );
  });

  it('calendar set_reminders on an automation reaches the tool, which applies own-only', async () => {
    // The calendar derives an external caller's access from the curation
    // (calendar/access.ts, tested there); the gateway adds no calendar check.
    findAutomation.mockResolvedValue({ id: 'automation-1', createdByMemberId: 'member-2' });
    await expectRuns('snaglet_calendar', {
      op: 'set_reminders',
      automation_id: 'automation-1',
      before: ['15m'],
    });
    expect(findAutomation).not.toHaveBeenCalled();
  });

  it('a family alias names the op the caller sent and lists only its own ops', async () => {
    const read = await call('snaglet_calendar_read', { op: 'delete_event', id: 'event-1' });
    expect(text(read)).toBe(
      '`delete_event` is not an op of snaglet_calendar_read; external ops: list, query, focus, dates, get_event, get_reminders.'
    );
    const write = await call('snaglet_calendar_write', {});
    expect(text(write)).toBe(
      'snaglet_calendar_write needs an op; external ops: create_calendar, create_event, update_event, restore_event, move_occurrence, complete_occurrence, skip_occurrence, set_reminders.'
    );
    for (const result of [read, write]) {
      expect(result.isError).toBe(true);
      expect(text(result)).not.toMatch(/__not_a/);
    }
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('create_image stays app-local', () => {
  it('names it as a Snaglet tool MCP clients cannot use, not as an unknown tool', async () => {
    await expectDenied(
      'snaglet_create_image',
      { title: 'x', mime_type: 'image/png', data_base64: 'iVBORw0KGgo=' },
      /^Denied: snaglet_create_image is not available to external MCP clients; it stays in the Snaglet app\. Call tools\/list/
    );
  });

  it('a name Snaglet does not know is still unknown', async () => {
    await expectDenied('snaglet_no_such_tool', {}, /^Unknown tool: snaglet_no_such_tool\./);
  });
});

describe('export_node', () => {
  it('refuses kind own_memories (it binds to an agent id; an external member has none)', async () => {
    await expectDenied(
      'snaglet_export_node',
      { kind: 'own_memories' },
      /^Denied: `kind` must be one of doc, thread, image for MCP clients/
    );
  });
});

describe('thread: taking agents out stays app-local', () => {
  it('add_agents runs, but remove_agents is not an external op', async () => {
    await expectRuns('snaglet_thread', {
      op: 'add_agents',
      id: 'thread-1',
      agent_ids: ['agent-1'],
    });
    jest.clearAllMocks();
    await expectDenied(
      'snaglet_thread',
      { op: 'remove_agents', id: 'thread-1', agent_ids: ['agent-1'] },
      /^Denied: op `remove_agents` of snaglet_thread is not available to external MCP clients/
    );
  });

  it('agent_ids is a parameter of add_agents but not of send', async () => {
    await expectDenied(
      'snaglet_thread',
      { op: 'send', id: 'thread-1', content: 'hi', agent_ids: ['agent-1'] },
      /^Denied: `agent_ids` is not a parameter of snaglet_thread op send for MCP clients/
    );
    await expectRuns('snaglet_thread', { op: 'send', id: 'thread-1', content: 'hi' });
  });

  it('op leave (and its aliases) is not an external op', async () => {
    for (const op of ['leave', 'leave_thread', 'remove_me']) {
      const result = await call('snaglet_thread', { op, id: 'thread-1' });
      expect(result.isError).toBe(true);
    }
    expect(executeMock).not.toHaveBeenCalled();
  });
});
