/**
 * The `calendar` tool through ToolExecutor against real PostgreSQL and the
 * real tool catalog: query returns events and a bound table's rows (repeats
 * expanded) as the pane shows them; table rows follow the calling agent's
 * `table` access (left out of query and list, occurrence writes and row
 * reminders refused); occurrence writes run the table repeat action (an undo
 * step) behind the row's rev; event writes map rev to expectedRevision and
 * name the current rev on a conflict; delete_event archives and
 * restore_event undoes it; another op's field is refused before anything
 * runs; the calendar_read / calendar_write aliases resolve.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Agents, getDb, getDbClient } from '@snaglet/db';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import { loadTestClusterHandoff } from '../../../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const readerPassword = createHash('sha256')
  .update(`${TABLES_READER_ROLE}:${handoff.runToken}`)
  .digest('base64url');
{
  const url = new URL('postgresql://localhost');
  url.username = TABLES_READER_ROLE;
  url.password = readerPassword;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_TABLES_READER_URL = url.toString();
}

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createCalendar } from '@server/domains/calendar/calendarService';
import { createTable } from '@server/domains/tables/tableCatalog';
import {
  createTableEntry,
  listTableEntries,
  tableEntryRepeatAction,
} from '@server/domains/tables/tableEntries';
import {
  createTableField,
  listTableFields,
  setTableFieldCalendar,
  updateTableField,
} from '@server/domains/tables/tableFields';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { findResolvedAgentTool } from '@server/services/ToolService/lib/resolveAgentTool';

const AGENT_A = 'test-agent-a';
const AGENT_NO_TABLES = 'test-agent-b';
const AGENT_READ_ONLY = 'test-agent-c';
const USER: Actor = { actorKind: 'user', actorId: 'test-user-cal', actorName: 'Test User' };
const TABLE = 'table-1111111111111-calttool';
const DUE = 'field-1111111111111-caltdue';
const STATUS = 'field-1111111111111-caltstat';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const E3 = '33333333-3333-4333-8333-333333333333';
const CHECKS = 'table-1111111111111-calcheck';
const AT = 'field-1111111111111-caltat';
const TZ = 'America/New_York';

let calendarId = '';

type Result = Awaited<ReturnType<typeof toolExecutor.execute>>;

async function call(
  agentId: string | null,
  input: Record<string, unknown>,
  name = 'calendar'
): Promise<Result> {
  const tools = agentId ? await resolveAgentTools(agentId) : [];
  const agentTool =
    findResolvedAgentTool(tools, 'calendar') ??
    ({
      agentId: '',
      tool: { id: 'calendar', name: 'Calendar' },
      settings: {},
      requiresConfirmation: false,
    } as unknown as Parameters<typeof toolExecutor.execute>[1]);
  const actor: Actor = agentId
    ? { actorKind: 'agent', actorId: agentId, actorName: agentId }
    : USER;
  return runWithActor(actor, () =>
    toolExecutor.execute({ name, input }, agentTool, agentId ? { agentId } : undefined)
  );
}

async function ok<T = Record<string, unknown>>(
  agentId: string | null,
  input: Record<string, unknown>,
  name?: string
): Promise<T> {
  const result = await call(agentId, input, name);
  if (!result.success) throw new Error(`calendar call failed: ${result.error}`);
  return JSON.parse(result.output) as T;
}

async function failure(agentId: string | null, input: Record<string, unknown>): Promise<string> {
  const result = await call(agentId, input);
  expect(result.success).toBe(false);
  return result.error ?? '';
}

interface Occurrence {
  kind: string;
  title: string;
  start: string;
  end: string;
  status: string;
  rev: string;
  event_id?: string;
  entry_id?: string;
  values?: Record<string, unknown>;
  repeat?: { occurrence: string; current: boolean };
}

interface QueryResult {
  occurrences: Occurrence[];
  hidden?: string;
}

const week = { from: '2026-03-09', days: 3, tz: TZ };

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

async function historySteps(actorId: string): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.table_history WHERE actor_id = $1',
    [actorId]
  );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  await provisionTablesReaderRole(await getDbClient(), {
    password: readerPassword,
    database: database!,
    revokePublic: true,
  });
  await toolRegistry.load();
  await toolRegistry.syncToDatabase();
  const { rows } = await getDb().query<{ provider_id: string; model_id: string }>(
    `SELECT provider_id, model_id FROM public.models
      WHERE is_active AND supports_tools AND type = 'llm'
      ORDER BY provider_id, sort_order LIMIT 1`
  );
  const model = { providerId: rows[0]!.provider_id, modelId: rows[0]!.model_id };
  await Agents.create({ id: AGENT_A, name: 'Test Agent A', ...model });
  await Agents.create({
    id: AGENT_NO_TABLES,
    name: 'Test Agent B',
    ...model,
    toolAccessMode: 'deny_list',
    toolAccessDenyList: ['table'],
  });
  await Agents.create({
    id: AGENT_READ_ONLY,
    name: 'Test Agent C',
    ...model,
    toolAccessMode: 'allow_list',
    toolAccessAllowList: ['calendar', 'table_read'],
  });

  calendarId = (await as(() => createCalendar({ title: 'Work', timeZone: TZ }))).id;
  await as(() => createTable({ id: TABLE, name: 'test_chores' }));
  for (const body of [
    { id: DUE, name: 'due', type: 'date' },
    { id: STATUS, name: 'status', type: 'select', options: [{ label: 'todo' }, { label: 'done' }] },
  ])
    await as(() =>
      createTableField(TABLE, {
        description: null,
        nullable: true,
        defaultValue: null,
        referenceTableId: null,
        ...body,
      })
    );
  const due = (await listTableFields(TABLE)).find((field) => field.id === DUE)!;
  await as(() => setTableFieldCalendar(TABLE, DUE, { calendarId, expectedRevision: due.revision }));
  const bound = (await listTableFields(TABLE)).find((field) => field.id === DUE)!;
  await as(() =>
    updateTableField(TABLE, DUE, {
      name: bound.name,
      description: bound.description,
      type: bound.type,
      nullable: bound.nullable,
      defaultValue: bound.defaultValue,
      referenceTableId: bound.referenceTableId,
      expectedRevision: bound.revision,
      recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
    })
  );
  const add = async (id: string, name: string, day: string) => {
    const { schemaVersion } = await listTableEntries(TABLE);
    await as(() =>
      createTableEntry(TABLE, {
        id,
        values: { [`field-title-${TABLE}`]: name, [DUE]: day, [STATUS]: 'todo' },
        schemaVersion,
      })
    );
  };
  await add(E1, 'Water plants', '2026-03-09');
  await add(E2, 'File taxes', '2026-03-10');
  const { entries, schemaVersion } = await listTableEntries(TABLE);
  const water = entries.find((entry) => entry.id === E1)!;
  await as(() =>
    tableEntryRepeatAction(TABLE, E1, DUE, 'set', {
      rrule: 'FREQ=DAILY',
      expectedRevision: water.revision,
      schemaVersion,
    })
  );
});

describe('calendar tool', () => {
  it('is a registered standard builtin', () => {
    expect(toolRegistry.getDefinition('calendar')).toMatchObject({
      id: 'calendar',
      tier: 'standard',
      destructiveOps: ['delete_event'],
    });
  });

  it('creates an event from wall time in the calendar’s zone, and query shows it with the rows', async () => {
    const created = await ok<{ event: Record<string, unknown> }>(AGENT_A, {
      op: 'create_event',
      title: 'Standup',
      calendar: 'work',
      start: '2026-03-09T09:00',
      end: '2026-03-09T09:30',
    });
    expect(created.event).toMatchObject({
      start: '2026-03-09T09:00:00-04:00',
      end: '2026-03-09T09:30:00-04:00',
      tz: TZ,
      calendar: 'Work',
      rev: '1',
    });

    const result = await ok<QueryResult>(AGENT_A, { op: 'query', ...week });
    expect(result.hidden).toBeUndefined();
    expect(result.occurrences.map((o) => [o.kind, o.title, o.start, o.status])).toEqual([
      ['table_row', 'Water plants', '2026-03-09', 'upcoming'],
      ['event', 'Standup', '2026-03-09T09:00:00-04:00', 'upcoming'],
      ['table_row', 'Water plants', '2026-03-10', 'upcoming'],
      ['table_row', 'File taxes', '2026-03-10', 'upcoming'],
      ['table_row', 'Water plants', '2026-03-11', 'upcoming'],
    ]);
    const water = result.occurrences[0]!;
    expect(water).toMatchObject({
      entry_id: E1,
      values: { status: 'todo' },
      repeat: { occurrence: '2026-03-09', current: true },
    });
  });

  it('calendar_read resolves to query; calendar_write cannot be steered into a read', async () => {
    const viaAlias = await ok<QueryResult>(AGENT_A, { ...week }, 'calendar_read');
    expect(viaAlias.occurrences.length).toBeGreaterThan(0);
    const steered = await call(AGENT_A, { op: 'query', ...week }, 'calendar_write');
    expect(steered.success).toBe(false);
    expect(steered.error).toMatch(/op is required/);
  });

  it('refuses another op’s field before anything runs', async () => {
    const before = await historySteps(AGENT_A);
    expect(await failure(AGENT_A, { op: 'query', ...week, move_to: '2026-03-12' })).toMatch(
      /`move_to` belongs to op move_occurrence, not query\. Nothing was changed\./
    );
    expect(await historySteps(AGENT_A)).toBe(before);
  });

  describe('table access', () => {
    it('an agent that cannot read tables gets no rows from query and no bound fields from list', async () => {
      const result = await ok<QueryResult>(AGENT_NO_TABLES, { op: 'query', ...week });
      expect(result.occurrences.map((o) => o.kind)).toEqual(['event']);
      expect(result.hidden).toMatch(/table rows .* left out/);
      const rowsOnly = await ok<QueryResult>(AGENT_NO_TABLES, {
        op: 'query',
        ...week,
        tables: ['test_chores'],
      });
      expect(rowsOnly.occurrences).toEqual([]);
      const listed = await ok<{ calendars: Array<Record<string, unknown>> }>(AGENT_NO_TABLES, {
        op: 'list',
      });
      expect(listed.calendars.find((c) => c.id === calendarId)).not.toHaveProperty('bound_fields');
      const open = await ok<{ calendars: Array<Record<string, unknown>> }>(AGENT_A, {
        op: 'list',
      });
      expect(open.calendars.find((c) => c.id === calendarId)!.bound_fields).toEqual([
        expect.objectContaining({ table: 'test_chores', field: 'due', repeats: true }),
      ]);
    });

    it('occurrence writes on a table the agent cannot write are refused, and change nothing', async () => {
      const row = (await ok<QueryResult>(AGENT_A, { op: 'query', ...week })).occurrences[0]!;
      const target = { table: 'test_chores', entry_id: E1, field: 'due', rev: row.rev };
      for (const agent of [AGENT_READ_ONLY, AGENT_NO_TABLES])
        for (const input of [
          { op: 'complete_occurrence', ...target },
          { op: 'skip_occurrence', ...target },
          { op: 'move_occurrence', ...target, move_to: '2026-03-12' },
        ])
          expect(await failure(agent, input)).toMatch(
            /error 403: .* needs table write access, which your tool access does not give/
          );
      const after = (await ok<QueryResult>(AGENT_A, { op: 'query', ...week })).occurrences[0]!;
      expect(after).toMatchObject({ rev: row.rev, status: 'upcoming' });
    });

    it('reminders on a row the agent cannot read are refused; an event’s are not', async () => {
      const item = { table: 'test_chores', entry_id: E2, field: 'due' };
      expect(await failure(AGENT_NO_TABLES, { op: 'get_reminders', ...item })).toMatch(
        /error 403: Reminders on a table row needs table read access/
      );
      expect(
        await failure(AGENT_NO_TABLES, { op: 'set_reminders', ...item, before: ['1h'] })
      ).toMatch(/error 403/);
      expect(await ok(AGENT_READ_ONLY, { op: 'get_reminders', ...item })).toMatchObject({
        reminders: null,
      });
      const event = (await ok<QueryResult>(AGENT_A, { op: 'query', ...week, kinds: ['events'] }))
        .occurrences[0]!;
      const set = await ok(AGENT_NO_TABLES, {
        op: 'set_reminders',
        id: event.event_id,
        before: ['15m'],
      });
      expect(set).toMatchObject({ reminders: { enabled: true, at_start: true, before: ['15m'] } });
      expect(await ok(AGENT_NO_TABLES, { op: 'get_reminders', id: event.event_id })).toMatchObject({
        reminders: { before: ['15m'] },
      });
    });
  });

  it('completes the current occurrence behind the row rev, as one undo step', async () => {
    const row = (await ok<QueryResult>(AGENT_A, { op: 'query', ...week })).occurrences[0]!;
    const before = await historySteps(AGENT_A);
    const done = await ok(AGENT_A, {
      op: 'complete_occurrence',
      table: 'test_chores',
      entry_id: E1,
      field: 'due',
      occurrence: '2026-03-09',
      rev: row.rev,
    });
    expect(done).toMatchObject({
      done: '2026-03-09',
      changed: true,
      repeat: { current: '2026-03-10' },
    });
    expect(await historySteps(AGENT_A)).toBe(before + 1);

    // The old rev is now stale: a 409 that names the current one.
    expect(
      await failure(AGENT_A, {
        op: 'skip_occurrence',
        table: 'test_chores',
        entry_id: E1,
        field: 'due',
        rev: row.rev,
      })
    ).toMatch(
      new RegExp(`error 409: .*\\(row ${E1} is at rev ${(done as { rev: string }).rev}\\)`)
    );

    const result = await ok<QueryResult>(AGENT_A, {
      op: 'query',
      ...week,
      tables: ['test_chores'],
    });
    const water = result.occurrences.filter((o) => o.title === 'Water plants');
    expect(water.map((o) => [o.start, o.status, o.repeat?.current])).toEqual([
      ['2026-03-09', 'done', false],
      ['2026-03-10', 'upcoming', true],
      ['2026-03-11', 'upcoming', false],
    ]);
    const onlyDone = await ok<QueryResult>(AGENT_A, { op: 'query', ...week, status: ['done'] });
    expect(onlyDone.occurrences.map((o) => o.title)).toEqual(['Water plants']);
    const noRepeats = await ok<QueryResult>(AGENT_A, {
      op: 'query',
      ...week,
      kinds: ['table_rows'],
      repeats: 'exclude',
    });
    expect(noRepeats.occurrences.map((o) => o.title)).toEqual(['File taxes']);
  });

  it('a non-repeating row has no occurrences to complete', async () => {
    const row = (await ok<QueryResult>(AGENT_A, { op: 'query', ...week, text: 'taxes' }))
      .occurrences[0]!;
    expect(
      await failure(AGENT_A, {
        op: 'complete_occurrence',
        table: 'test_chores',
        entry_id: E2,
        field: 'due',
        rev: row.rev,
      })
    ).toMatch(/error 400: .*doesn't repeat/);
  });

  it('update_event maps rev; a stale rev names the current one; delete archives, restore undoes', async () => {
    const event = (await ok<QueryResult>(AGENT_A, { op: 'query', ...week, kinds: ['events'] }))
      .occurrences[0]!;
    const moved = await ok<{ event: Record<string, unknown> }>(AGENT_A, {
      op: 'update_event',
      id: event.event_id,
      rev: event.rev,
      start: '2026-03-10T10:00',
    });
    expect(moved.event).toMatchObject({
      start: '2026-03-10T10:00:00-04:00',
      end: '2026-03-10T10:30:00-04:00',
      rev: '2',
    });
    expect(
      await failure(AGENT_A, { op: 'update_event', id: event.event_id, rev: event.rev, title: 'x' })
    ).toMatch(new RegExp(`error 409: .*\\(event ${event.event_id} is at rev 2\\)`));

    expect(await ok(AGENT_A, { op: 'delete_event', id: event.event_id, rev: '2' })).toMatchObject({
      deleted: event.event_id,
    });
    const gone = await ok<QueryResult>(AGENT_A, { op: 'query', ...week, kinds: ['events'] });
    expect(gone.occurrences).toEqual([]);
    await ok(AGENT_A, { op: 'restore_event', id: event.event_id });
    const back = await ok<QueryResult>(AGENT_A, { op: 'query', ...week, kinds: ['events'] });
    expect(back.occurrences.map((o) => o.event_id)).toEqual([event.event_id]);
  });

  it('refuses a window over 62 days', async () => {
    expect(await failure(AGENT_A, { op: 'query', from: '2026-01-01', to: '2026-04-01' })).toMatch(
      /error 400: a query covers at most 62 days/
    );
  });

  it('an interval repeat (every 2 hours) shows its summary; complete and skip advance it', async () => {
    // Its own calendar and table, so the queries above stay as they are.
    const ops = await as(() => createCalendar({ title: 'Ops', timeZone: TZ }));
    await as(() => createTable({ id: CHECKS, name: 'test_checks' }));
    await as(() =>
      createTableField(CHECKS, {
        id: AT,
        name: 'at',
        type: 'datetime',
        description: null,
        nullable: true,
        defaultValue: null,
        referenceTableId: null,
      })
    );
    const at = (await listTableFields(CHECKS)).find((field) => field.id === AT)!;
    await as(() =>
      setTableFieldCalendar(CHECKS, AT, { calendarId: ops.id, expectedRevision: at.revision })
    );
    const boundAt = (await listTableFields(CHECKS)).find((field) => field.id === AT)!;
    await as(() =>
      updateTableField(CHECKS, AT, {
        name: boundAt.name,
        description: boundAt.description,
        type: boundAt.type,
        nullable: boundAt.nullable,
        defaultValue: boundAt.defaultValue,
        referenceTableId: boundAt.referenceTableId,
        expectedRevision: boundAt.revision,
        recurrence: {
          statusFieldId: null,
          doneOptionIds: [],
          resetOptionId: null,
        },
      })
    );
    const { schemaVersion } = await listTableEntries(CHECKS);
    await as(() =>
      createTableEntry(CHECKS, {
        id: E3,
        values: { [`field-title-${CHECKS}`]: 'Stretch', [AT]: '2026-03-09T13:00:00Z' },
        schemaVersion,
      })
    );
    const listed = await listTableEntries(CHECKS);
    const created = listed.entries.find((entry) => entry.id === E3)!;
    await as(() =>
      tableEntryRepeatAction(CHECKS, E3, AT, 'set', {
        rrule: 'FREQ=HOURLY;INTERVAL=2',
        expectedRevision: created.revision,
        schemaVersion: listed.schemaVersion,
      })
    );
    // 09:00–15:59 EDT: the four wakes at 09, 11, 13 and 15.
    const span = {
      op: 'query',
      calendars: ['Ops'],
      from: '2026-03-09T09:00',
      to: '2026-03-09T16:00',
      tz: TZ,
    };
    const first = await ok<QueryResult>(AGENT_A, span);
    expect(first.occurrences.map((o) => [o.start, o.status, o.repeat?.current])).toEqual([
      ['2026-03-09T09:00:00-04:00', 'upcoming', true],
      ['2026-03-09T11:00:00-04:00', 'upcoming', false],
      ['2026-03-09T13:00:00-04:00', 'upcoming', false],
      ['2026-03-09T15:00:00-04:00', 'upcoming', false],
    ]);
    const summary = (first.occurrences[0]!.repeat as { summary: string }).summary;
    expect(summary).toMatch(/^Every 2 h/);

    const target = { table: 'test_checks', entry_id: E3, field: 'at' };
    const done = await ok<{ rev: string; repeat: { current: string } }>(AGENT_A, {
      op: 'complete_occurrence',
      ...target,
      occurrence: first.occurrences[0]!.repeat!.occurrence,
      rev: first.occurrences[0]!.rev,
    });
    expect(done.repeat.current).toBe(first.occurrences[1]!.repeat!.occurrence);
    await ok(AGENT_A, {
      op: 'skip_occurrence',
      ...target,
      occurrence: first.occurrences[1]!.repeat!.occurrence,
      rev: done.rev,
    });
    const after = await ok<QueryResult>(AGENT_A, span);
    expect(after.occurrences.map((o) => [o.start, o.status, o.repeat?.current])).toEqual([
      ['2026-03-09T09:00:00-04:00', 'done', false],
      ['2026-03-09T11:00:00-04:00', 'skipped', false],
      ['2026-03-09T13:00:00-04:00', 'upcoming', true],
      ['2026-03-09T15:00:00-04:00', 'upcoming', false],
    ]);
  });
});
