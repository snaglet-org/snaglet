/**
 * AgentToolResolver × guarded confirmation defaults.
 *
 * An agent row with null/absent toolOverrides resolves every tool with
 * `requiresConfirmation: false`: guarded defaults apply only at agent
 * creation/seeding time, so a failure there means an existing agent's
 * behavior changed. An agent whose row carries the creation-time guarded
 * overrides resolves those tools as confirming, and a thread-level override
 * still wins over the agent level.
 */

const listResolvableMock = jest.fn();
const findAgentByIdMock = jest.fn();

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { listResolvable: (...args: unknown[]) => listResolvableMock(...args) },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgentByIdMock(...args) },
}));

jest.mock('@server/services/ToolAvailabilityService', () => ({
  getToolAvailability: jest.fn().mockResolvedValue('available'),
}));

jest.mock('@server/services/McpService', () => ({
  mcpService: {
    ensureServersConnected: jest.fn(),
    getToolDefsForServers: jest.fn().mockReturnValue([]),
    getConfirmationPolicy: jest.fn().mockReturnValue(true),
  },
}));

// Small controlled registry for the guarded-set derivation: one destructive
// definition beyond the shared call-time-guarded kinds.
// `merged_thread` stands in for a merged op tool that is destructive on one
// op only: it declares destructiveOps instead of destructive: true.
const DEFINITIONS: Record<string, Record<string, unknown>> = {
  delete_doc: { id: 'delete_doc', destructive: true },
  get_doc: { id: 'get_doc' },
  merged_thread: { id: 'merged_thread', destructiveOps: ['delete'] },
};
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn().mockResolvedValue(undefined),
    getAllDefinitions: jest.fn(() => DEFINITIONS),
    getDefinition: jest.fn((id: string) => DEFINITIONS[id]),
  },
}));

import { confirmationForCall, resolveAgentTools } from '@server/services/AgentToolResolver';
import { withGuardedConfirmationDefaults } from '@server/services/ToolService/lib/guardedTools';
import type { ToolRow } from '@snaglet/db/tables/tools';

function tool(id: string, ops?: string[]): ToolRow {
  return {
    id,
    name: id,
    description: id,
    type: 'builtin',
    parametersSchema: ops ? { properties: { op: { type: 'string', enum: ops } } } : {},
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier: 'standard',
    categoryPath: 'system',
    providerId: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  } as ToolRow;
}

function agentRow(toolOverrides: Record<string, unknown> | null) {
  return {
    id: 'agent-1',
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    toolOverrides,
    mcpServers: null,
  };
}

const byId = (resolved: Awaited<ReturnType<typeof resolveAgentTools>>) =>
  new Map(resolved.map((entry) => [entry.tool.id, entry]));

beforeEach(() => {
  jest.clearAllMocks();
  // The live catalog: merged tools declare an op enum.
  listResolvableMock.mockResolvedValue([
    tool('shell', ['run', 'write']),
    tool('file', ['read', 'list', 'info', 'create', 'update', 'diff']),
    tool('delete_doc'),
    tool('get_doc'),
    tool('merged_thread', ['get', 'send', 'update', 'delete']),
  ]);
});

describe('existing agents (null/absent toolOverrides) are untouched', () => {
  it('resolves every tool with requiresConfirmation: false when toolOverrides is null', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow(null));

    const resolved = await resolveAgentTools('agent-1');

    expect(resolved.length).toBeGreaterThan(0);
    for (const entry of resolved) {
      expect(entry.requiresConfirmation).toBe(false);
    }
  });

  it('resolves identically when toolOverrides is an empty object', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({}));

    const resolved = await resolveAgentTools('agent-1');

    for (const entry of resolved) {
      expect(entry.requiresConfirmation).toBe(false);
    }
  });
});

describe('creation-time guarded overrides resolve as confirming', () => {
  it('a guarded agent confirms writing/running ops and destructive tools only', async () => {
    const guarded = await withGuardedConfirmationDefaults(null);
    findAgentByIdMock.mockResolvedValue(agentRow(guarded));

    const resolved = byId(await resolveAgentTools('agent-1'));
    const file = resolved.get('file')!;
    const shell = resolved.get('shell')!;

    // writing ops confirm (aliases file_write / file_edit / apply_patch)
    expect(confirmationForCall(file, { op: 'create' })).toBe(true);
    expect(confirmationForCall(file, { op: 'update' })).toBe(true);
    // read-side ops do not confirm
    for (const op of ['read', 'list', 'info', 'diff']) {
      expect(confirmationForCall(file, { op })).toBe(false);
    }
    // shell: run confirms (aliases shell_exec / exec_command). write follows run when it
    // types chars (typed lines are commands); a poll (no chars) never asks.
    expect(confirmationForCall(shell, { op: 'run' })).toBe(true);
    expect(confirmationForCall(shell, { op: 'write', session_id: 1, chars: 'rm -rf x\n' })).toBe(
      true
    );
    expect(confirmationForCall(shell, { op: 'write', session_id: 1, chars: '' })).toBe(false);
    expect(confirmationForCall(shell, { op: 'write', session_id: 1 })).toBe(false);
    // destructive-flagged definition rides into the guarded set
    expect(resolved.get('delete_doc')!.requiresConfirmation).toBe(true);
    // non-guarded, non-destructive tools stay unconfirmed
    expect(resolved.get('get_doc')!.requiresConfirmation).toBe(false);
  });

  it('a call with no recognized op falls back to the whole-tool flag (asks)', async () => {
    const guarded = await withGuardedConfirmationDefaults(null);
    findAgentByIdMock.mockResolvedValue(agentRow(guarded));

    const file = byId(await resolveAgentTools('agent-1')).get('file')!;

    expect(confirmationForCall(file, {})).toBe(true);
    expect(confirmationForCall(file, { op: 'nonsense' })).toBe(true);
  });

  it('an explicit old-id flag still applies to the op it pinned', async () => {
    const guarded = await withGuardedConfirmationDefaults({
      file_read: { requiresConfirmation: true },
      apply_patch: { requiresConfirmation: false },
    });
    findAgentByIdMock.mockResolvedValue(agentRow(guarded));

    const file = byId(await resolveAgentTools('agent-1')).get('file')!;

    // file_read: true asks on reads
    expect(confirmationForCall(file, { op: 'read' })).toBe(true);
    // the canonical guarded `file` flag outranks an alias flag on a writing op
    expect(confirmationForCall(file, { op: 'update' })).toBe(true);
    expect(confirmationForCall(file, { op: 'list' })).toBe(false);
  });

  it('an old-id flag applies when the agent has no canonical override', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({ file_write: { requiresConfirmation: true } }));

    const file = byId(await resolveAgentTools('agent-1')).get('file')!;

    expect(confirmationForCall(file, { op: 'create' })).toBe(true);
    expect(confirmationForCall(file, { op: 'update' })).toBe(false);
    expect(confirmationForCall(file, { op: 'read' })).toBe(false);
  });

  it('a thread-level override still wins over the agent-level guarded default', async () => {
    const guarded = await withGuardedConfirmationDefaults(null);
    findAgentByIdMock.mockResolvedValue(agentRow(guarded));

    const resolved = byId(
      await resolveAgentTools('agent-1', {
        threadOverrides: { shell_exec: { requiresConfirmation: false } },
      })
    );

    // a thread override stored under the alias id applies to the op it pinned
    expect(confirmationForCall(resolved.get('shell')!, { op: 'run' })).toBe(false);
    // untouched siblings keep the agent-level guarded default
    expect(confirmationForCall(resolved.get('file')!, { op: 'create' })).toBe(true);
  });

  it('a trusted agent skips confirmation on every op', async () => {
    const guarded = await withGuardedConfirmationDefaults(null);
    findAgentByIdMock.mockResolvedValue({ ...agentRow(guarded), trustedToolCalls: true });

    const resolved = byId(await resolveAgentTools('agent-1'));

    expect(confirmationForCall(resolved.get('file')!, { op: 'create' })).toBe(false);
    expect(confirmationForCall(resolved.get('shell')!, { op: 'run' })).toBe(false);
    expect(
      confirmationForCall(resolved.get('shell')!, { op: 'write', session_id: 1, chars: 'ls\n' })
    ).toBe(false);
    expect(confirmationForCall(resolved.get('shell')!, { op: 'write', session_id: 1 })).toBe(false);
  });

  it('an explicit write_stdin override still opts typed input out (run keeps asking)', async () => {
    const guarded = await withGuardedConfirmationDefaults({
      write_stdin: { requiresConfirmation: false },
    });
    findAgentByIdMock.mockResolvedValue(agentRow(guarded));

    const shell = byId(await resolveAgentTools('agent-1')).get('shell')!;

    expect(confirmationForCall(shell, { op: 'run' })).toBe(true);
    expect(confirmationForCall(shell, { op: 'write', session_id: 1, chars: 'ls\n' })).toBe(false);
  });

  it('an explicit write_stdin: true asks on typed input even for a non-guarded agent; polls never ask', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({ write_stdin: { requiresConfirmation: true } }));

    const shell = byId(await resolveAgentTools('agent-1')).get('shell')!;

    expect(confirmationForCall(shell, { op: 'run' })).toBe(false);
    expect(confirmationForCall(shell, { op: 'write', session_id: 1, chars: 'ls\n' })).toBe(true);
    expect(confirmationForCall(shell, { op: 'write', session_id: 1 })).toBe(false);
  });
});

describe('per-op destructiveness (destructiveOps)', () => {
  it('a guarded agent confirms only the destructive op of a merged tool', async () => {
    const guarded = await withGuardedConfirmationDefaults(null);
    expect(guarded.merged_thread?.requiresConfirmation).toBe(true);
    findAgentByIdMock.mockResolvedValue(agentRow(guarded));

    const thread = byId(await resolveAgentTools('agent-1')).get('merged_thread')!;

    expect(confirmationForCall(thread, { op: 'delete' })).toBe(true);
    for (const op of ['get', 'send', 'update']) {
      expect(confirmationForCall(thread, { op })).toBe(false);
    }
  });

  it('an unknown or missing op falls back to the whole-tool flag (asks)', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow(await withGuardedConfirmationDefaults(null)));

    const thread = byId(await resolveAgentTools('agent-1')).get('merged_thread')!;

    expect(confirmationForCall(thread, {})).toBe(true);
    expect(confirmationForCall(thread, { op: 'purge' })).toBe(true);
  });

  it('a thread-level canonical flag covers every op (explicit user choice)', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow(null));

    const thread = byId(
      await resolveAgentTools('agent-1', {
        threadOverrides: { merged_thread: { requiresConfirmation: true } },
      })
    ).get('merged_thread')!;

    for (const op of ['get', 'send', 'update', 'delete']) {
      expect(confirmationForCall(thread, { op })).toBe(true);
    }
  });

  it('a trusted agent never confirms, destructive op included', async () => {
    findAgentByIdMock.mockResolvedValue({
      ...agentRow(await withGuardedConfirmationDefaults(null)),
      trustedToolCalls: true,
    });

    const thread = byId(await resolveAgentTools('agent-1')).get('merged_thread')!;

    expect(confirmationForCall(thread, { op: 'delete' })).toBe(false);
  });

  it('whole-tool destructive tools without an op enum are unchanged', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow(await withGuardedConfirmationDefaults(null)));

    const resolved = byId(await resolveAgentTools('agent-1'));

    expect(resolved.get('delete_doc')!.requiresConfirmation).toBe(true);
    expect(resolved.get('get_doc')!.requiresConfirmation).toBe(false);
  });
});

describe('real merged `thread` definition', () => {
  // Uses the shipped definition, not the stand-in, so a later edit that drops
  // destructiveOps or adds a whole-tool flag fails here.
  it('a guarded agent confirms thread{delete} only; every other op runs without asking', async () => {
    const { default: threadDefinition } =
      await import('@server/services/ToolService/tools/threads/thread/definition');
    const ops = (
      threadDefinition.parameters_schema as unknown as { properties: { op: { enum: string[] } } }
    ).properties.op.enum;
    expect(ops).toEqual([
      'send',
      'read',
      'create',
      'update',
      'add_agents',
      'remove_agents',
      'delete',
      'leave',
      'dm_send',
      'dm_list',
      'dm_read',
    ]);
    expect((threadDefinition as { destructive?: boolean }).destructive).toBeUndefined();

    DEFINITIONS.thread = threadDefinition as unknown as Record<string, unknown>;
    try {
      listResolvableMock.mockResolvedValue([tool('get_doc'), tool('thread', ops)]);
      const guarded = await withGuardedConfirmationDefaults(null);
      expect(guarded.thread?.requiresConfirmation).toBe(true);
      findAgentByIdMock.mockResolvedValue(agentRow(guarded));

      const thread = byId(await resolveAgentTools('agent-1')).get('thread')!;

      expect(confirmationForCall(thread, { op: 'delete' })).toBe(true);
      // leave and op remove_agents only take an agent out of the room,
      // and remove_agents refuses an agent a person set up for the thread,
      // so neither asks first; only delete does.
      for (const op of [
        'read',
        'send',
        'create',
        'update',
        'add_agents',
        'remove_agents',
        'leave',
      ]) {
        expect(confirmationForCall(thread, { op })).toBe(false);
      }
    } finally {
      delete DEFINITIONS.thread;
    }
  });
});

const NON_DELETE_DOC_OPS = [
  'get',
  'create',
  'update',
  'duplicate',
  'diff',
  'snapshot',
  'list-snapshots',
  'restore',
  'delete-snapshot',
  'convert-to-container',
];

describe('real merged `doc` definition', () => {
  // A stored per-agent `tool_overrides.delete_doc` confirmation must keep
  // gating doc{delete} only, through the shipped op-pinned alias, and a guarded
  // agent confirms doc{delete} only.
  const withDoc = async (overrides: Record<string, unknown>) => {
    const { default: docDefinition } =
      await import('@server/services/ToolService/tools/docs/doc/definition');
    const ops = (
      docDefinition.parameters_schema as unknown as { properties: { op: { enum: string[] } } }
    ).properties.op.enum;
    expect(ops).toEqual([
      'get',
      'outline',
      'create',
      'update',
      'delete',
      'duplicate',
      'diff',
      'snapshot',
      'list-snapshots',
      'restore',
      'delete-snapshot',
      'convert-to-container',
    ]);
    DEFINITIONS.doc = docDefinition as unknown as Record<string, unknown>;
    listResolvableMock.mockResolvedValue([tool('doc', ops)]);
    findAgentByIdMock.mockResolvedValue(agentRow(overrides));
    return byId(await resolveAgentTools('agent-1')).get('doc')!;
  };

  afterEach(() => {
    delete DEFINITIONS.doc;
  });

  it('a stored delete_doc override confirms doc{delete} and nothing else', async () => {
    const doc = await withDoc({ delete_doc: { requiresConfirmation: true } });
    expect(confirmationForCall(doc, { op: 'delete' })).toBe(true);
    for (const op of NON_DELETE_DOC_OPS) {
      expect(confirmationForCall(doc, { op })).toBe(false);
    }
  });

  it('a guarded agent (canonical doc flag) confirms doc{delete} only', async () => {
    const guarded = await withGuardedConfirmationDefaults(null);
    const doc = await withDoc(guarded);
    expect(confirmationForCall(doc, { op: 'delete' })).toBe(true);
    for (const op of NON_DELETE_DOC_OPS) {
      expect(confirmationForCall(doc, { op })).toBe(false);
    }
  });
});

describe('real merged `table` definition', () => {
  // The one stored setting naming a table tool is a per-agent
  // `tool_overrides.table_delete` confirmation. Through the shipped op-pinned
  // alias it must keep gating table{delete} only; schema stays unconfirmed,
  // and a guarded agent confirms table{delete} only.
  const withTable = async (overrides: Record<string, unknown>) => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/tables/table/definition');
    DEFINITIONS.table = definition as unknown as Record<string, unknown>;
    const ops = (
      definition.parameters_schema as unknown as { properties: { op: { enum: string[] } } }
    ).properties.op.enum;
    listResolvableMock.mockResolvedValue([tool('table', ops)]);
    findAgentByIdMock.mockResolvedValue(agentRow(overrides));
    return byId(await resolveAgentTools('agent-1')).get('table')!;
  };

  afterEach(() => {
    delete DEFINITIONS.table;
  });

  it('a stored table_delete override confirms table{delete} and nothing else', async () => {
    const table = await withTable({ table_delete: { requiresConfirmation: true } });
    expect(confirmationForCall(table, { op: 'delete' })).toBe(true);
    for (const op of ['read', 'write', 'schema']) {
      expect(confirmationForCall(table, { op })).toBe(false);
    }
  });

  it('a guarded agent (canonical table flag) confirms table{delete} only', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/tables/table/definition');
    DEFINITIONS.table = definition as unknown as Record<string, unknown>;
    const guarded = await withGuardedConfirmationDefaults(null);
    expect(guarded.table?.requiresConfirmation).toBe(true);
    const table = await withTable(guarded);
    expect(confirmationForCall(table, { op: 'delete' })).toBe(true);
    for (const op of ['read', 'write', 'schema']) {
      expect(confirmationForCall(table, { op })).toBe(false);
    }
  });
});

describe('real merged `calendar` definition', () => {
  // calendar{delete_event} is the tool's one destructive op (it archives the
  // event; restore_event undoes it): a guarded agent confirms it and nothing
  // else, and an agent with no overrides confirms nothing, as for table.
  const withCalendar = async (overrides: Record<string, unknown> | null) => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/calendar/calendar/definition');
    DEFINITIONS.calendar = definition as unknown as Record<string, unknown>;
    const ops = (
      definition.parameters_schema as unknown as { properties: { op: { enum: string[] } } }
    ).properties.op.enum;
    listResolvableMock.mockResolvedValue([tool('calendar', ops)]);
    findAgentByIdMock.mockResolvedValue(agentRow(overrides));
    return { calendar: byId(await resolveAgentTools('agent-1')).get('calendar')!, ops };
  };

  afterEach(() => {
    delete DEFINITIONS.calendar;
  });

  it('a guarded agent (canonical calendar flag) confirms delete_event only', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/calendar/calendar/definition');
    DEFINITIONS.calendar = definition as unknown as Record<string, unknown>;
    const guarded = await withGuardedConfirmationDefaults(null);
    expect(guarded.calendar?.requiresConfirmation).toBe(true);
    const { calendar, ops } = await withCalendar(guarded);
    expect(confirmationForCall(calendar, { op: 'delete_event' })).toBe(true);
    expect(confirmationForCall(calendar, { op: 'remove_done' })).toBe(true);
    for (const op of ops.filter(
      (candidate) => candidate !== 'delete_event' && candidate !== 'remove_done'
    )) {
      expect(confirmationForCall(calendar, { op })).toBe(false);
    }
  });

  it('an agent with no overrides confirms nothing', async () => {
    const { calendar, ops } = await withCalendar(null);
    for (const op of ops) expect(confirmationForCall(calendar, { op })).toBe(false);
  });
});

describe('real merged `custom_tool` definition (code-authoring gate)', () => {
  // custom_tool builds and runs agent-authored Node code as the user, so both
  // its ops (create, update) are gated: a guarded agent confirms them and a
  // trusted agent skips every prompt.
  const withCustomTool = async (overrides: Record<string, unknown> | null, trusted = false) => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/system/custom-tool/definition');
    DEFINITIONS.custom_tool = definition as unknown as Record<string, unknown>;
    const ops = (
      definition.parameters_schema as unknown as { properties: { op: { enum: string[] } } }
    ).properties.op.enum;
    listResolvableMock.mockResolvedValue([tool('custom_tool', ops)]);
    findAgentByIdMock.mockResolvedValue(
      trusted ? { ...agentRow(overrides), trustedToolCalls: true } : agentRow(overrides)
    );
    return { custom: byId(await resolveAgentTools('agent-1')).get('custom_tool')!, ops };
  };

  afterEach(() => {
    delete DEFINITIONS.custom_tool;
  });

  it('declares both ops destructive', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/system/custom-tool/definition');
    expect((definition as { destructiveOps?: string[] }).destructiveOps).toEqual([
      'create',
      'update',
    ]);
  });

  it('a guarded agent confirms create and update', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/system/custom-tool/definition');
    DEFINITIONS.custom_tool = definition as unknown as Record<string, unknown>;
    const guarded = await withGuardedConfirmationDefaults(null);
    expect(guarded.custom_tool?.requiresConfirmation).toBe(true);
    const { custom } = await withCustomTool(guarded);
    expect(confirmationForCall(custom, { op: 'create' })).toBe(true);
    expect(confirmationForCall(custom, { op: 'update' })).toBe(true);
  });

  it('an agent with no overrides confirms nothing', async () => {
    const { custom, ops } = await withCustomTool(null);
    for (const op of ops) expect(confirmationForCall(custom, { op })).toBe(false);
  });

  it('a trusted agent skips confirmation on create', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/system/custom-tool/definition');
    DEFINITIONS.custom_tool = definition as unknown as Record<string, unknown>;
    const guarded = await withGuardedConfirmationDefaults(null);
    const { custom } = await withCustomTool(guarded, true);
    expect(confirmationForCall(custom, { op: 'create' })).toBe(false);
    expect(confirmationForCall(custom, { op: 'update' })).toBe(false);
  });
});

describe('real merged `hook` definition (code-authoring gate)', () => {
  // hook create writes agent-authored code, run executes a saved hook's code,
  // and update/enable/run_as stage or hand code an actor's access — all run as
  // the user, so each is gated. disable (turns a hook off) is not.
  const GATED_HOOK_OPS = ['create', 'run', 'update', 'enable', 'run_as'];
  const UNGATED_HOOK_OPS = ['disable'];

  const withHook = async (overrides: Record<string, unknown> | null, trusted = false) => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/hooks/hook/definition');
    DEFINITIONS.hook = definition as unknown as Record<string, unknown>;
    const ops = (
      definition.parameters_schema as unknown as { properties: { op: { enum: string[] } } }
    ).properties.op.enum;
    listResolvableMock.mockResolvedValue([tool('hook', ops)]);
    findAgentByIdMock.mockResolvedValue(
      trusted ? { ...agentRow(overrides), trustedToolCalls: true } : agentRow(overrides)
    );
    return { hook: byId(await resolveAgentTools('agent-1')).get('hook')!, ops };
  };

  afterEach(() => {
    delete DEFINITIONS.hook;
  });

  it('declares create, run, update, enable and run_as destructive', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/hooks/hook/definition');
    expect((definition as { destructiveOps?: string[] }).destructiveOps).toEqual(GATED_HOOK_OPS);
  });

  it('a guarded agent confirms every gated op and not disable', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/hooks/hook/definition');
    DEFINITIONS.hook = definition as unknown as Record<string, unknown>;
    const guarded = await withGuardedConfirmationDefaults(null);
    expect(guarded.hook?.requiresConfirmation).toBe(true);
    const { hook } = await withHook(guarded);
    for (const op of GATED_HOOK_OPS) {
      expect({ op, confirm: confirmationForCall(hook, { op }) }).toEqual({ op, confirm: true });
    }
    for (const op of UNGATED_HOOK_OPS) {
      expect({ op, confirm: confirmationForCall(hook, { op }) }).toEqual({ op, confirm: false });
    }
  });

  it('an agent with no overrides confirms nothing', async () => {
    const { hook, ops } = await withHook(null);
    for (const op of ops) expect(confirmationForCall(hook, { op })).toBe(false);
  });

  it('a trusted agent skips confirmation on create and run', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/hooks/hook/definition');
    DEFINITIONS.hook = definition as unknown as Record<string, unknown>;
    const guarded = await withGuardedConfirmationDefaults(null);
    const { hook } = await withHook(guarded, true);
    expect(confirmationForCall(hook, { op: 'create' })).toBe(false);
    expect(confirmationForCall(hook, { op: 'run' })).toBe(false);
  });
});
