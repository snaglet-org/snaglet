/**
 * calendar tool × tool access policy. A table row on the calendar is a
 * custom-table row and an automation wake belongs to the automation tool, so
 * the calendar gives an agent exactly the access those tools give: the real
 * headless gate (agentToolPolicy → toolVisibility → toolOpRules) judges
 * `table {op: "read" | "write"}` and `automation {op: "list"}` against the
 * agent's stored policy and the real definitions. A person (no agent, or
 * the panel acting as one) has every access. The next block runs query and
 * reminders through that real gate. The last ones are an external MCP
 * client, whose access is derived from the MCP curation, and the
 * in-app callers it leaves unchanged.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findAgent = jest.fn();
const findTool = jest.fn();

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgent(...args) },
}));
jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { findById: (...args: unknown[]) => findTool(...args) },
}));
jest.mock('@server/services/subagents/helperInheritance', () => ({
  resolveHelperToolPolicy: jest.fn(async () => null),
}));
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: { getToolIds: () => ['table', 'calendar', 'automation', 'search'] },
}));

// Calendar domain stand-ins for the query / reminders block.
const listOccurrences = jest.fn();
const remindersGet = jest.fn();
const remindersSave = jest.fn();
jest.mock('@server/domains/calendar/calendarService', () => ({
  listCalendars: async () => [
    {
      id: 'cal-work',
      title: 'Work',
      timeZone: 'UTC',
      isDefault: true,
      revision: 1,
      boundFields: [
        {
          tableId: 'table-1111111111111-aaaaaaaaa',
          tableName: 'chores',
          projectId: null,
          fieldId: 'field-1111111111111-due',
          fieldName: 'due',
          fieldType: 'date',
          repeats: true,
          unscheduledCount: 0,
        },
      ],
    },
  ],
}));
jest.mock('@server/domains/calendar/occurrences', () => ({
  listOccurrences: (...args: unknown[]) => listOccurrences(...args),
}));
jest.mock('@server/domains/tables/tableFields', () => ({ listTableFields: async () => [] }));
// Any read or write of a row: a refused occurrence write never gets here.
const touchRow = jest.fn();
jest.mock('@server/domains/tables/tableEntries', () => ({
  getTableEntry: (...args: unknown[]) => touchRow(...args),
  getTableEntryRepeats: (...args: unknown[]) => touchRow(...args),
  tableEntryRepeatAction: (...args: unknown[]) => touchRow(...args),
}));
const describeAgentTable = jest.fn();
jest.mock('@server/domains/tables/tableAgent', () => ({
  describeAgentTable: (...args: unknown[]) => describeAgentTable(...args),
}));
const findAutomation = jest.fn();
jest.mock('@snaglet/db/tables/automations', () => ({
  Automations: {
    list: async () => [{ id: 'auto-1' }],
    findById: (...args: unknown[]) => findAutomation(...args),
  },
}));
jest.mock('@snaglet/db/tables/reminders', () => ({
  Reminders: {
    get: (...args: unknown[]) => remindersGet(...args),
    save: (...args: unknown[]) => remindersSave(...args),
    remove: async () => false,
  },
}));
jest.mock('@server/domains/reminders/reminderInput', () => ({
  ...jest.requireActual<object>('@server/domains/reminders/reminderInput'),
  assertReminderItemExists: async () => undefined,
}));
jest.mock('@server/domains/reminders/upcomingReminders', () => ({
  refreshReminderTables: async () => undefined,
}));
jest.mock('@server/realtime/surfaces/reminders', () => ({ emitRemindersChanged: () => undefined }));

import tableDefinition from '@server/services/ToolService/tools/tables/table/definition';
import automationDefinition from '@server/services/ToolService/tools/automations/automation/definition';
import {
  CURATED_TOOL_IDS,
  CURATED_TOOL_OPS,
  EXTERNAL_AUTOMATION_OPS,
  type ExternalCuration,
} from '@server/domains/mcp/mcpProjection';
import { runWithActor } from '@server/realtime/actorContext';
import {
  assertAutomationAccess,
  assertTableAccess,
  calendarCaller,
} from '@server/services/ToolService/handlers/calendar/access';
import { listCalendarsOp } from '@server/services/ToolService/handlers/calendar/calendars';
import {
  completeOccurrenceOp,
  moveOccurrenceOp,
  skipOccurrenceOp,
} from '@server/services/ToolService/handlers/calendar/occurrences';
import { queryOp } from '@server/services/ToolService/handlers/calendar/query';
import {
  getRemindersOp,
  setRemindersOp,
} from '@server/services/ToolService/handlers/calendar/reminders';

const AGENT = 'test-agent-a';

function toolRow(definition: typeof tableDefinition, enabled = true) {
  return {
    id: definition.id,
    name: definition.name,
    type: 'builtin',
    aliases: definition.aliases ?? [],
    parametersSchema: definition.parameters_schema,
    enabled,
  };
}
const tableRow = (enabled = true) => toolRow(tableDefinition, enabled);
const automationRow = (enabled = true) => toolRow(automationDefinition, enabled);

function agent(mode: string, lists: { allow?: string[]; deny?: string[] } = {}) {
  return {
    id: AGENT,
    parentAgentId: null,
    toolAccessMode: mode,
    toolAccessAllowList: lists.allow ?? [],
    toolAccessDenyList: lists.deny ?? [],
  };
}

async function access(context: Parameters<typeof calendarCaller>[0]) {
  const caller = calendarCaller(context);
  return {
    read: (await caller.tableAccess('read')).allowed,
    write: (await caller.tableAccess('write')).allowed,
  };
}

beforeEach(() => {
  findAgent.mockReset();
  findTool.mockReset();
  findTool.mockImplementation(async (id: unknown) =>
    id === 'table' ? tableRow() : id === 'automation' ? automationRow() : null
  );
});

describe('calendarCaller table access', () => {
  it('a person (no agent context) reads and writes rows, without asking the policy', async () => {
    expect(await access(undefined)).toEqual({ read: true, write: true });
    expect(findAgent).not.toHaveBeenCalled();
  });

  it('the panel acting as an agent (bypassToolAccess) is the person', async () => {
    findAgent.mockResolvedValue(agent('allow_list', { allow: ['calendar'] }));
    expect(await access({ agentId: AGENT, bypassToolAccess: true })).toEqual({
      read: true,
      write: true,
    });
  });

  it.each([
    ['all tools', agent('all'), { read: true, write: true }],
    ['deny table', agent('deny_list', { deny: ['table'] }), { read: false, write: false }],
    // A bare deny naming one of table's definition names (its alias ids) blocks
    // the whole table tool, in chat and headless alike, so its rows too.
    [
      'deny table_read',
      agent('deny_list', { deny: ['table_read'] }),
      { read: false, write: false },
    ],
    [
      'deny table_write',
      agent('deny_list', { deny: ['table_write'] }),
      { read: false, write: false },
    ],
    ['deny another tool', agent('deny_list', { deny: ['shell'] }), { read: true, write: true }],
    [
      'an allow list without table',
      agent('allow_list', { allow: ['calendar'] }),
      { read: false, write: false },
    ],
    [
      'allow table_read only',
      agent('allow_list', { allow: ['calendar', 'table_read'] }),
      { read: true, write: false },
    ],
    [
      'allow table',
      agent('allow_list', { allow: ['calendar', 'table'] }),
      { read: true, write: true },
    ],
  ])('an agent with %s', async (_label, row, expected) => {
    findAgent.mockResolvedValue(row);
    expect(await access({ agentId: AGENT })).toEqual(expected);
  });

  it('a deny names its rule in the reason', async () => {
    findAgent.mockResolvedValue(agent('deny_list', { deny: ['table_read'] }));
    const verdict = await calendarCaller({ agentId: AGENT }).tableAccess('read');
    expect(verdict).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('table_read'),
    });
  });

  it('refuses rows when the table tool is turned off', async () => {
    findAgent.mockResolvedValue(agent('all'));
    findTool.mockImplementation(async (id: unknown) => (id === 'table' ? tableRow(false) : null));
    expect(await access({ agentId: AGENT })).toEqual({ read: false, write: false });
  });

  it('refuses rows for an agent id with no row behind it', async () => {
    findAgent.mockResolvedValue(null);
    expect(await access({ agentId: AGENT })).toEqual({ read: false, write: false });
  });

  it('judges each need once per call', async () => {
    findAgent.mockResolvedValue(agent('all'));
    const caller = calendarCaller({ agentId: AGENT });
    await caller.tableAccess('read');
    await caller.tableAccess('read');
    expect(findAgent).toHaveBeenCalledTimes(1);
  });
});

describe('assertTableAccess', () => {
  it('is a 403 that says nothing changed', async () => {
    findAgent.mockResolvedValue(agent('allow_list', { allow: ['calendar', 'table_read'] }));
    const caller = calendarCaller({ agentId: AGENT });
    await expect(
      assertTableAccess(caller, 'write', 'Skipping an occurrence')
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(
        /^Skipping an occurrence needs table write access.*Nothing was changed\.$/
      ),
    });
    await expect(assertTableAccess(caller, 'read', 'Reading')).resolves.toBeUndefined();
  });
});

describe('calendarCaller automation access', () => {
  const automations = async (context: Parameters<typeof calendarCaller>[0]) =>
    (await calendarCaller(context).automationAccess()).allowed;

  it('a person reads automations without asking the policy', async () => {
    expect(await automations(undefined)).toBe(true);
    expect(await automations({ agentId: AGENT, bypassToolAccess: true })).toBe(true);
    expect(findAgent).not.toHaveBeenCalled();
  });

  it.each([
    ['all tools', agent('all'), true],
    ['deny automation', agent('deny_list', { deny: ['automation'] }), false],
    ['deny table (another tool)', agent('deny_list', { deny: ['table'] }), true],
    ['an allow list without automation', agent('allow_list', { allow: ['calendar'] }), false],
    [
      'an allow list with automation',
      agent('allow_list', { allow: ['calendar', 'automation'] }),
      true,
    ],
  ])('an agent with %s', async (_label, row, expected) => {
    findAgent.mockResolvedValue(row);
    expect(await automations({ agentId: AGENT })).toBe(expected);
  });

  it('judges the automation tool’s read op (list), once per call', async () => {
    findAgent.mockResolvedValue(agent('all'));
    const caller = calendarCaller({ agentId: AGENT });
    await caller.automationAccess();
    await caller.automationAccess();
    expect(findTool.mock.calls.filter(([id]) => id === 'automation')).toHaveLength(1);
  });

  it('refuses when the automation tool is turned off', async () => {
    findAgent.mockResolvedValue(agent('all'));
    findTool.mockImplementation(async (id: unknown) =>
      id === 'automation' ? automationRow(false) : tableRow()
    );
    expect(await automations({ agentId: AGENT })).toBe(false);
  });

  it('assertAutomationAccess is a 403 that says nothing changed', async () => {
    findAgent.mockResolvedValue(agent('deny_list', { deny: ['automation'] }));
    await expect(
      assertAutomationAccess(calendarCaller({ agentId: AGENT }), 'Reminders on an automation')
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(
        /^Reminders on an automation needs automation read access.*Nothing was changed\.$/
      ),
    });
  });
});

// What listOccurrences returns for the query blocks below.
const NOW = new Date('2026-10-15T12:00:00Z');
const TABLE = 'table-1111111111111-aaaaaaaaa';
const ENTRY = '11111111-1111-4111-8111-111111111111';
const row = {
  key: `row:field-1111111111111-due:${ENTRY}:2026-10-15`,
  source: 'row',
  calendarId: 'cal-work',
  title: 'Water plants',
  time: { kind: 'all_day', startDate: '2026-10-15', endDate: '2026-10-16' },
  status: 'upcoming',
  canMove: true,
  canResize: false,
  tableId: TABLE,
  tableName: 'chores',
  projectId: null,
  entryId: ENTRY,
  fieldId: 'field-1111111111111-due',
  range: false,
  hasEnd: false,
  entryRevision: 'abcdef0123456789',
  schemaVersion: 'v1',
  repeat: { occurrence: '2026-10-15', isCurrent: true, summary: 'Every day', shape: 'schedule' },
};
const wake = {
  key: 'automation:auto-1:2026-10-15T20:00:00.000Z',
  source: 'automation',
  calendarId: 'cal-work',
  title: 'Check the build',
  time: { kind: 'timed', start: '2026-10-15T20:00:00.000Z', end: '2026-10-15T20:15:00.000Z' },
  status: 'upcoming',
  canMove: false,
  canResize: false,
  automationId: 'auto-1',
  agentId: AGENT,
  agentName: 'Test Agent A',
  threadId: 'thread-1',
  automationStatus: 'active',
};
const event = {
  key: 'event:event-1',
  source: 'event',
  eventId: 'event-1',
  revision: 1,
  calendarId: 'cal-work',
  title: 'Standup',
  time: { kind: 'timed', start: '2026-10-15T16:00:00.000Z', end: '2026-10-15T16:30:00.000Z' },
  status: 'upcoming',
  canMove: true,
  canResize: true,
};
const interval = {
  key: 'automation:auto-2:span:2026-10-15',
  source: 'automation',
  kind: 'interval',
  automationId: 'auto-2',
  calendarId: 'cal-work',
  name: 'Poll inbox',
  day: '2026-10-15',
  everyMs: 1_800_000,
  startsAt: '2026-10-01T00:00:00.000Z',
  nextRunAt: '2026-10-15T20:30:00.000Z',
  agentId: AGENT,
  agentName: 'Test Agent A',
  threadId: 'thread-1',
};

describe('query and reminders through the real gate (automations)', () => {
  const run = async (context: Parameters<typeof calendarCaller>[0]) =>
    (await queryOp({ range: 'today', tz: 'UTC' }, calendarCaller(context), NOW)) as {
      occurrences: Array<{ kind: string }>;
      intervals?: unknown[];
      hidden?: string;
    };

  beforeEach(() => {
    listOccurrences.mockReset();
    listOccurrences.mockResolvedValue({
      from: '2026-10-15',
      to: '2026-10-16',
      tz: 'UTC',
      occurrences: [event, wake],
      intervals: [interval],
      unavailable: [],
    });
    remindersGet.mockReset();
    remindersGet.mockResolvedValue(null);
    remindersSave.mockReset();
    remindersSave.mockImplementation(async (item: unknown, input: object) => ({
      item,
      ...input,
      updatedAt: '2026-10-15T00:00:00Z',
    }));
  });

  it('an Every line with a daily window says it', async () => {
    findAgent.mockResolvedValue(agent('allow_list', { allow: ['calendar', 'automation'] }));
    const window = { start: '05:05', end: '06:00', tz: 'America/Los_Angeles' };
    listOccurrences.mockResolvedValue({
      from: '2026-10-15',
      to: '2026-10-16',
      tz: 'UTC',
      occurrences: [],
      intervals: [{ ...interval, everyMs: 300_000, window }],
      unavailable: [],
    });
    const result = await run({ agentId: AGENT });
    expect(result.intervals).toEqual([
      expect.objectContaining({ automation_id: 'auto-2', every: '5m', window }),
    ]);
  });

  it('a deny on automation hides the wakes and Every lines, and says why', async () => {
    findAgent.mockResolvedValue(agent('deny_list', { deny: ['automation'] }));
    const result = await run({ agentId: AGENT });
    expect(result.occurrences.map((o) => o.kind)).toEqual(['event']);
    expect(result.intervals).toBeUndefined();
    expect(result.hidden).toMatch(/^automation wakes and Every lines are left out: .*automation/);
  });

  it('with automation access they show', async () => {
    findAgent.mockResolvedValue(agent('allow_list', { allow: ['calendar', 'automation'] }));
    const result = await run({ agentId: AGENT });
    expect(result.occurrences.map((o) => o.kind)).toEqual(['event', 'automation']);
    expect(result.intervals).toEqual([
      expect.objectContaining({ automation_id: 'auto-2', every: '30m' }),
    ]);
    expect(result.intervals?.[0]).not.toHaveProperty('window');
    // Only the rows are left out: this allow list does not name table.
    expect(result.hidden).toMatch(/^table rows and bound table fields are left out/);
    expect(result.hidden).not.toMatch(/automation wakes/);
  });

  it('a deny on automation refuses reminders by automation_id, get and set; nothing is read or saved', async () => {
    findAgent.mockResolvedValue(agent('deny_list', { deny: ['automation'] }));
    const caller = calendarCaller({ agentId: AGENT });
    await expect(getRemindersOp({ automation_id: 'auto-1' }, caller)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/^Reminders on an automation needs automation read access/),
    });
    await expect(
      setRemindersOp({ automation_id: 'auto-1', before: ['15m'] }, caller)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(remindersGet).not.toHaveBeenCalled();
    expect(remindersSave).not.toHaveBeenCalled();
    // An event's reminders do not depend on automation access.
    await expect(getRemindersOp({ id: 'event-1' }, caller)).resolves.toMatchObject({
      reminders: null,
    });
  });

  it('with automation access the reminders read and save', async () => {
    findAgent.mockResolvedValue(agent('all'));
    const caller = calendarCaller({ agentId: AGENT });
    await expect(getRemindersOp({ automation_id: 'auto-1' }, caller)).resolves.toEqual({
      item: { kind: 'automation', automation_id: 'auto-1' },
      reminders: null,
    });
    await expect(
      setRemindersOp({ automation_id: 'auto-1', before: ['15m'] }, caller)
    ).resolves.toMatchObject({ reminders: { before: ['15m'] } });
  });
});

/**
 * An external MCP client. The gateway runs it as the ambient `external` actor
 * (its id is the key's member) with no agent context, so it does not get a
 * person's full access: its access is derived from the MCP curation of table
 * and automation (externalCalendarAccess). Each test narrows that curation the
 * way a change to mcpProjection would, and the calendar narrows with it.
 */
describe('an external MCP client follows the MCP curation', () => {
  const MEMBER = 'member-1111111111111-aaaaaaaaa';
  const OTHER_MEMBER = 'member-2222222222222-bbbbbbbbb';
  const asExternal = <T>(fn: () => T): T =>
    runWithActor({ actorKind: 'external', actorId: MEMBER, actorName: 'Test client' }, fn);
  /** An external caller under `curation` (today's when left out). */
  const externalCaller = (curation?: Partial<ExternalCuration>) =>
    asExternal(() => calendarCaller({}, curation));
  const withOps = (toolId: string, ops: readonly string[]): Partial<ExternalCuration> => ({
    curatedOps: { ...CURATED_TOOL_OPS, [toolId]: ops },
  });
  const without = (toolId: string): Partial<ExternalCuration> => ({
    curatedIds: CURATED_TOOL_IDS.filter((id) => id !== toolId),
  });
  const verdicts = async (curation?: Partial<ExternalCuration>) => {
    const caller = externalCaller(curation);
    return {
      tableRead: (await caller.tableAccess('read')).allowed,
      tableWrite: (await caller.tableAccess('write')).allowed,
      automationRead: (await caller.automationAccess()).allowed,
    };
  };
  const query = async (curation?: Partial<ExternalCuration>) =>
    (await queryOp({ range: 'today', tz: 'UTC' }, externalCaller(curation), NOW)) as {
      occurrences: Array<{ kind: string }>;
      intervals?: unknown[];
      hidden?: string;
    };
  const occurrenceInput = {
    table: 'chores',
    entry_id: ENTRY,
    field: 'due',
    rev: 'abcdef01',
    move_to: '2026-10-16',
  };

  beforeEach(() => {
    listOccurrences.mockReset();
    listOccurrences.mockResolvedValue({
      from: '2026-10-15',
      to: '2026-10-16',
      tz: 'UTC',
      occurrences: [event, row, wake],
      intervals: [interval],
      unavailable: [],
    });
    remindersGet.mockReset();
    remindersGet.mockResolvedValue(null);
    remindersSave.mockReset();
    remindersSave.mockImplementation(async (item: unknown, input: object) => ({
      item,
      ...input,
      updatedAt: '2026-10-15T00:00:00Z',
    }));
    findAutomation.mockReset();
    findAutomation.mockResolvedValue({ id: 'auto-1', createdByMemberId: OTHER_MEMBER });
    touchRow.mockReset();
    describeAgentTable.mockReset();
  });

  it('today’s curation shows rows and wakes, judged without any agent policy', async () => {
    expect(await verdicts()).toEqual({ tableRead: true, tableWrite: true, automationRead: true });
    const result = await query();
    expect(result.occurrences.map((o) => o.kind)).toEqual(['event', 'table_row', 'automation']);
    expect(result.intervals).toEqual([expect.objectContaining({ automation_id: 'auto-2' })]);
    expect(result.hidden).toBeUndefined();
    expect(findAgent).not.toHaveBeenCalled();
    expect(findTool).not.toHaveBeenCalled();
  });

  it.each([
    ['table without read', withOps('table', ['write', 'schema']), [false, true]],
    ['table without write', withOps('table', ['read', 'schema']), [true, false]],
    ['table with schema only', withOps('table', ['schema']), [false, false]],
    ['no table tool', without('table'), [false, false]],
  ])('the curation with %s narrows the rows', async (_label, curation, [read, write]) => {
    expect(await verdicts(curation)).toEqual({
      tableRead: read,
      tableWrite: write,
      automationRead: true,
    });
  });

  it('narrowing table read and write: query and list hide the rows, the occurrence writes are refused', async () => {
    const narrowed = withOps('table', ['schema']);
    const result = await query(narrowed);
    expect(result.occurrences.map((o) => o.kind)).toEqual(['event', 'automation']);
    expect(result.hidden).toBe(
      'table rows and bound table fields are left out: table read is not available to external MCP clients'
    );
    const listed = (await listCalendarsOp({}, externalCaller(narrowed))) as {
      calendars: Array<Record<string, unknown>>;
      hidden?: string;
    };
    expect(listed.calendars[0]).not.toHaveProperty('bound_fields');
    expect(listed.hidden).toMatch(/^table rows and bound table fields are left out/);
    for (const op of [moveOccurrenceOp, completeOccurrenceOp, skipOccurrenceOp]) {
      await expect(op(occurrenceInput, externalCaller(narrowed))).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(
          /occurrence needs table write access, which your tool access does not give \(table write is not available to external MCP clients\)\. Nothing was changed\.$/
        ),
      });
    }
    await expect(
      getRemindersOp({ table: 'chores', entry_id: ENTRY, field: 'due' }, externalCaller(narrowed))
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(describeAgentTable).not.toHaveBeenCalled();
    expect(touchRow).not.toHaveBeenCalled();
    expect(remindersGet).not.toHaveBeenCalled();
  });

  it('narrowing table read alone hides the rows; the curated write stays', async () => {
    const narrowed = withOps('table', ['write', 'schema']);
    expect((await query(narrowed)).occurrences.map((o) => o.kind)).toEqual(['event', 'automation']);
    // The write passes access and goes on to address the row.
    describeAgentTable.mockRejectedValue(new Error('row lookup reached'));
    await expect(moveOccurrenceOp(occurrenceInput, externalCaller(narrowed))).rejects.toThrow(
      'row lookup reached'
    );
  });

  it.each([
    ['automation without list', withOps('automation', ['create', 'get', 'runs', 'update'])],
    [
      'list own-only (not open)',
      { automationOps: { open: EXTERNAL_AUTOMATION_OPS.open.filter((op) => op !== 'list') } },
    ],
    ['no automation tool', without('automation')],
  ])(
    'the curation with %s hides wakes and Every lines and refuses reminders on an automation',
    async (_label, curation) => {
      expect(await verdicts(curation)).toEqual({
        tableRead: true,
        tableWrite: true,
        automationRead: false,
      });
      const result = await query(curation);
      expect(result.occurrences.map((o) => o.kind)).toEqual(['event', 'table_row']);
      expect(result.intervals).toBeUndefined();
      expect(result.hidden).toBe(
        'automation wakes and Every lines are left out: automation list is not available to external MCP clients'
      );
      const caller = externalCaller(curation);
      await expect(getRemindersOp({ automation_id: 'auto-1' }, caller)).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(/^Reminders on an automation needs automation read access/),
      });
      await expect(
        setRemindersOp({ automation_id: 'auto-1', before: ['15m'] }, caller)
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(remindersGet).not.toHaveBeenCalled();
      expect(remindersSave).not.toHaveBeenCalled();
    }
  );

  it('set_reminders on an automation is own-only while automation update is; reading is open', async () => {
    const caller = externalCaller();
    await expect(
      setRemindersOp({ automation_id: 'auto-1', before: ['15m'] }, caller)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(
        /^Setting reminders on an automation needs automation write access, which your tool access does not give \(external MCP clients change only automations their key's member created; change this one from the Snaglet app\)\. Nothing was changed\.$/
      ),
    });
    await expect(
      setRemindersOp({ automation_id: 'auto-1', clear: true }, caller)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(remindersSave).not.toHaveBeenCalled();
    expect(findAutomation).toHaveBeenCalledWith('auto-1');
    await expect(getRemindersOp({ automation_id: 'auto-1' }, caller)).resolves.toMatchObject({
      reminders: null,
    });
    findAutomation.mockResolvedValue({ id: 'auto-1', createdByMemberId: MEMBER });
    await expect(
      setRemindersOp({ automation_id: 'auto-1', before: ['15m'] }, caller)
    ).resolves.toMatchObject({ reminders: { before: ['15m'] } });
    // An event's reminders do not look at automations.
    findAutomation.mockClear();
    await expect(setRemindersOp({ id: 'event-1', before: ['15m'] }, caller)).resolves.toMatchObject(
      { reminders: { before: ['15m'] } }
    );
    expect(findAutomation).not.toHaveBeenCalled();
  });

  it('set_reminders follows the curated automation update: open → any automation, not curated → none', async () => {
    const open = externalCaller({
      automationOps: { open: [...EXTERNAL_AUTOMATION_OPS.open, 'update'] },
    });
    await expect(
      setRemindersOp({ automation_id: 'auto-1', before: ['15m'] }, open)
    ).resolves.toMatchObject({ reminders: { before: ['15m'] } });
    expect(findAutomation).not.toHaveBeenCalled();

    findAutomation.mockResolvedValue({ id: 'auto-1', createdByMemberId: MEMBER });
    const none = externalCaller(withOps('automation', ['create', 'list', 'get', 'runs']));
    await expect(
      setRemindersOp({ automation_id: 'auto-1', before: ['15m'] }, none)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/\(automation update is not available to external MCP/),
    });
    expect(remindersSave).toHaveBeenCalledTimes(1);
  });
});

/**
 * In-app callers are unchanged by the external derivation: a person keeps
 * every access and an agent its policy, even with a curation that would
 * leave an external client nothing, and neither is held to own-only.
 */
describe('in-app people and agents ignore the MCP curation', () => {
  const nothing: Partial<ExternalCuration> = {
    curatedIds: CURATED_TOOL_IDS.filter((id) => id !== 'table' && id !== 'automation'),
  };
  const asUser = <T>(fn: () => T): T =>
    runWithActor({ actorKind: 'user', actorId: 'test-user-1', actorName: 'Test User' }, fn);

  beforeEach(() => {
    findAutomation.mockReset();
    findAutomation.mockResolvedValue({ id: 'auto-1', createdByMemberId: 'member-2' });
  });

  it.each([
    ['no ambient actor', () => calendarCaller(undefined, nothing)],
    ['the user actor', () => asUser(() => calendarCaller(undefined, nothing))],
    [
      'the panel acting as an agent',
      () => asUser(() => calendarCaller({ agentId: AGENT, bypassToolAccess: true }, nothing)),
    ],
  ])('a person (%s) has every access, on any automation', async (_label, make) => {
    const caller = make();
    expect(caller.agentId).toBeNull();
    expect((await caller.tableAccess('read')).allowed).toBe(true);
    expect((await caller.tableAccess('write')).allowed).toBe(true);
    expect((await caller.automationAccess()).allowed).toBe(true);
    expect((await caller.automationWriteAccess('auto-1')).allowed).toBe(true);
    expect(findAgent).not.toHaveBeenCalled();
    expect(findAutomation).not.toHaveBeenCalled();
  });

  it('an agent keeps its own policy, and reading automations is enough for their reminders', async () => {
    findAgent.mockResolvedValue(agent('all'));
    const allowed = calendarCaller({ agentId: AGENT }, nothing);
    expect(allowed.agentId).toBe(AGENT);
    expect((await allowed.tableAccess('read')).allowed).toBe(true);
    expect((await allowed.tableAccess('write')).allowed).toBe(true);
    expect((await allowed.automationAccess()).allowed).toBe(true);
    expect((await allowed.automationWriteAccess('auto-1')).allowed).toBe(true);

    findAgent.mockResolvedValue(agent('deny_list', { deny: ['table'] }));
    const denied = calendarCaller({ agentId: AGENT });
    expect((await denied.tableAccess('read')).allowed).toBe(false);
    expect((await denied.automationAccess()).allowed).toBe(true);
    expect(findAutomation).not.toHaveBeenCalled();
  });
});
