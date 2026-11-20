/**
 * `table_entry:occurrence` against real PostgreSQL: one hook
 * event per occurrence action on a repeating row, sent after the commit from
 * every path that makes one: the repeat actions (row, calendar tool, agent
 * `repeat`), a status set to done (entry update and agent batch, after the
 * row's `table_entry:update`) and table undo/redo. Failed and no-op writes
 * send nothing. The last block runs real registered hooks: a `{action:
 * 'done'}` filter, and a hook that marks its own row done without looping.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import path from 'path';
import express from 'express';
import { getDb, quoteIdentifier } from '@snaglet/db';
import { writeRepeat } from '@snaglet/db/tables/table_entries/repeats';
import type { TableField, TableFieldRecurrence } from '@snaglet/shared/types';
import { userTimeZone, tableRepeatToday } from '@snaglet/shared/utils';
import type { Actor } from '@snaglet/shared/types/workspace-events';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: () => undefined,
  emitTableUpdated: () => undefined,
  emitTableFieldsChanged: () => undefined,
  emitTableEntriesChanged: () => undefined,
  emitTableRemoved: () => undefined,
  emitTableRestored: () => undefined,
  emitTableHistoryChanged: () => undefined,
}));

import { runWithActor } from '@server/realtime/actorContext';
import { runAtChainDepth } from '@server/realtime/runContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  updateTableField,
} from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  getTableEntry,
  getTableEntryRepeats,
  listTableEntries,
  tableEntryRepeatAction,
  updateTableEntry,
  type RepeatAction,
} from '@server/domains/tables/tableEntries';
import { stepTableHistory } from '@server/domains/tables/tableHistory';
import { writeAgentEntries } from '@server/domains/tables/tableAgent';
import { completeOccurrenceOp } from '@server/services/ToolService/handlers/calendar/occurrences';
import type { CalendarCaller } from '@server/services/ToolService/handlers/calendar/access';
import { hooks, type HookEventMap } from '@server/services/HookService';
import { resolveHookInvocations } from '@server/services/customHooks/resolveHookInvocation';
import { HookRegistryService } from '@server/services/customHooks/HookRegistryService';
import executionRoutes from '@server/domains/tools/routes/execution.routes';
import { toolDispatchAuthMiddleware } from '@server/middleware/panelAuth';
import { errorHandler } from '@server/middleware/errorHandler';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';

type Occurrence = HookEventMap['table_entry:occurrence'];

const USER: Actor = { actorKind: 'user', actorId: 'test-user-occurrence', actorName: 'Test User' };
const AGENT: Actor = { actorKind: 'agent', actorId: 'test-agent-a', actorName: 'Test Agent A' };
const TABLE = 'table-1111111111111-occurhk';
const TABLE_NAME = 'occurrence_hook_rows';
const NAME = `field-title-${TABLE}`;
const DAY = 'field-1111111111111-ocday';
const AT = 'field-1111111111111-ocat';
const STATUS = 'field-1111111111111-ocstatus';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const E3 = '33333333-3333-4333-8333-333333333333';
const NAMES: Record<string, string> = { [E1]: 'Water plants', [E2]: 'Gym', [E3]: 'Stretch' };

const as = <T>(fn: () => Promise<T>, actor: Actor = USER): Promise<T> => runWithActor(actor, fn);

async function clean(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    'SELECT table_name FROM public.table_catalog WHERE id = $1',
    [TABLE]
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  for (const table of ['table_entry_occurrences', 'table_entry_repeats', 'table_fields'])
    await getDb().query(`DELETE FROM public.${table} WHERE table_id = $1`, [TABLE]);
  await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [TABLE]);
  await getDb().query('DELETE FROM public.table_history WHERE actor_id = ANY($1::text[])', [
    [USER.actorId, AGENT.actorId],
  ]);
}

const def = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: null,
  type,
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  ...extra,
});

async function field(id: string): Promise<TableField> {
  const found = (await listTableFields(TABLE)).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing field ${id}`);
  return found;
}

async function enableRepeat(id: string, recurrence: TableFieldRecurrence): Promise<void> {
  const current = await field(id);
  await as(() =>
    updateTableField(TABLE, id, {
      name: current.name,
      description: current.description,
      type: current.type,
      nullable: current.nullable,
      defaultValue: current.defaultValue,
      referenceTableId: current.referenceTableId,
      expectedRevision: current.revision,
      recurrence,
    })
  );
}

async function setup(): Promise<void> {
  await as(() => createTable({ id: TABLE, name: TABLE_NAME }));
  await as(() => createTableField(TABLE, def(DAY, 'day', 'date')));
  await as(() => createTableField(TABLE, def(AT, 'at', 'datetime')));
  await as(() =>
    createTableField(
      TABLE,
      def(STATUS, 'status', 'select', { options: [{ label: 'To do' }, { label: 'Done' }] })
    )
  );
  const options = new Map(((await field(STATUS)).options ?? []).map((o) => [o.label, o.id]));
  const recurrence: TableFieldRecurrence = {
    statusFieldId: STATUS,
    doneOptionIds: [options.get('Done')!],
    resetOptionId: options.get('To do')!,
  };
  await enableRepeat(DAY, recurrence);
  await enableRepeat(AT, recurrence);
  for (const id of [E1, E2, E3]) {
    const { schemaVersion } = await listTableEntries(TABLE);
    await as(() =>
      createTableEntry(TABLE, {
        id,
        values: { [NAME]: NAMES[id], [DAY]: '2026-10-05', [STATUS]: 'To do' },
        schemaVersion,
      })
    );
  }
}

async function act(
  entryId: string,
  fieldId: string,
  action: RepeatAction,
  body: Record<string, unknown> = {},
  actor: Actor = USER
) {
  const current = await getTableEntry(TABLE, entryId);
  return as(
    () =>
      tableEntryRepeatAction(TABLE, entryId, fieldId, action, {
        expectedRevision: current.entry.revision,
        schemaVersion: current.schemaVersion,
        ...body,
      }),
    actor
  );
}

const weekly = (id: string) => act(id, DAY, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });

async function setStatus(id: string, status: string, actor: Actor = USER) {
  const current = await getTableEntry(TABLE, id);
  return as(
    () =>
      updateTableEntry(TABLE, id, {
        values: { [STATUS]: status },
        expectedRevision: current.entry.revision,
        schemaVersion: current.schemaVersion,
      }),
    actor
  );
}

const undo = () => as(() => stepTableHistory('undo', {}));
const redo = () => as(() => stepTableHistory('redo', {}));

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string };
  }
  throw new Error('expected a rejection');
}

const interval = (rrule: string, current = '2026-10-31T09:00:00') => ({
  rrule,
  dtstart: '2026-10-31T09:00:00',
  current,
  tz: 'America/New_York',
});

/** The defaults of an event for E1's day field, as the user did it. */
const base = (entryId = E1): Omit<Occurrence, 'action' | 'occurrence' | 'current'> => ({
  tableId: TABLE,
  entryId,
  fieldId: DAY,
  entryName: NAMES[entryId]!,
  lastOccurrence: expect.any(String) as unknown as string,
  count: 1,
  tz: userTimeZone(),
  movedTo: null,
  undoneAction: null,
  ended: false,
  logId: null,
  logIds: [],
  via: 'action',
  actor: { kind: 'user', id: USER.actorId },
});

describe('table_entry:occurrence (real DB)', () => {
  let emit: jest.SpiedFunction<typeof hooks.emit>;
  const emitted = (name: string) =>
    emit.mock.calls.filter(([event]) => event === name).map(([, payload]) => payload);
  const occurrences = () => emitted('table_entry:occurrence') as Occurrence[];
  /** Table entry hook events in emit order: [name, entryId]. */
  const order = () =>
    emit.mock.calls
      .filter(([event]) => event === 'table_entry:update' || event === 'table_entry:occurrence')
      .map(([event, payload]) => [event, (payload as { entryId: string }).entryId]);

  beforeEach(async () => {
    await clean();
    await setup();
    emit = jest.spyOn(hooks, 'emit');
  });
  afterEach(() => emit.mockRestore());
  afterAll(clean);

  describe('each action sends one event', () => {
    it('done: names the row, the occurrence and the repeat after the write, after the update event', async () => {
      await weekly(E1);
      emit.mockClear();
      const done = await act(E1, DAY, 'complete');
      const id = done.logged[0]!.id;
      expect(occurrences()).toEqual([
        {
          ...base(),
          action: 'done',
          occurrence: '2026-10-05',
          lastOccurrence: '2026-10-05',
          current: '2026-10-12',
          logId: id,
          logIds: [id],
        },
      ]);
      expect(order()).toEqual([
        ['table_entry:update', E1],
        ['table_entry:occurrence', E1],
      ]);
      // Not part of the route's answer.
      expect(done).not.toHaveProperty('occurrences');
    });

    it('skip, move, a move back to its slot, and shift; set and clear send none', async () => {
      await weekly(E1);
      expect(occurrences()).toEqual([]);
      const skipped = await act(E1, DAY, 'skip');
      const moved = await act(E1, DAY, 'move', { to: '2026-10-14' });
      await act(E1, DAY, 'move', { to: '2026-10-12' });
      await act(E1, DAY, 'shift', { to: '2026-10-13' });
      await act(E1, DAY, 'clear');
      expect(occurrences()).toEqual([
        {
          ...base(),
          action: 'skipped',
          occurrence: '2026-10-05',
          lastOccurrence: '2026-10-05',
          current: '2026-10-12',
          logId: skipped.logged[0]!.id,
          logIds: [skipped.logged[0]!.id],
        },
        {
          ...base(),
          action: 'moved',
          occurrence: '2026-10-12',
          lastOccurrence: '2026-10-12',
          movedTo: '2026-10-14',
          current: '2026-10-12',
          logId: moved.logged[0]!.id,
          logIds: [moved.logged[0]!.id],
        },
        // Back to its own slot: the move is gone, nothing is logged.
        {
          ...base(),
          action: 'moved',
          occurrence: '2026-10-12',
          lastOccurrence: '2026-10-12',
          movedTo: '2026-10-12',
          current: '2026-10-12',
        },
        {
          ...base(),
          action: 'shifted',
          occurrence: '2026-10-12',
          lastOccurrence: '2026-10-12',
          movedTo: '2026-10-13',
          current: '2026-10-13',
        },
      ]);
    });

    it('an interval jumped to now: one jumped event, nothing logged', async () => {
      await writeRepeat(getDb(), TABLE, AT, E2, interval('FREQ=MINUTELY;INTERVAL=30'));
      await act(E2, AT, 'skip', { jump: true, now: '2026-10-31T10:10:00' });
      expect(occurrences()).toEqual([
        {
          ...base(E2),
          fieldId: AT,
          tz: 'America/New_York',
          action: 'jumped',
          occurrence: '2026-10-31T09:00:00',
          lastOccurrence: '2026-10-31T09:00:00',
          current: '2026-10-31T10:30:00',
        },
      ]);
    });

    it('Skip to upcoming is one event with count, first, last and every log id; undo and redo are one each', async () => {
      await act(E1, DAY, 'set', { rrule: 'FREQ=DAILY' });
      const skipped = await act(E1, DAY, 'skip', { toUpcoming: true, now: '2026-10-09' });
      const ids = skipped.logged.map((row) => row.id);
      expect(ids).toHaveLength(4);
      const skip = {
        ...base(),
        occurrence: '2026-10-05',
        lastOccurrence: '2026-10-08',
        count: 4,
        logId: ids[0]!,
        logIds: ids,
      };
      expect(occurrences()).toEqual([{ ...skip, action: 'skipped', current: '2026-10-09' }]);
      emit.mockClear();
      await undo();
      expect(occurrences()).toEqual([
        {
          ...skip,
          action: 'undone',
          undoneAction: 'skipped',
          current: '2026-10-05',
          via: 'history',
        },
      ]);
      emit.mockClear();
      await redo();
      expect(occurrences()).toEqual([
        { ...skip, action: 'skipped', current: '2026-10-09', via: 'history' },
      ]);
    });

    it('the last occurrence of a series says ended', async () => {
      await act(E1, DAY, 'set', { rrule: 'FREQ=DAILY;COUNT=1' });
      await act(E1, DAY, 'complete');
      expect(occurrences()).toMatchObject([
        { action: 'done', occurrence: '2026-10-05', current: '2026-10-05', ended: true },
      ]);
    });
  });

  describe('undo sends one undone, by either path, never both', () => {
    it('undoOccurrence (REST) sends exactly one undone; undoing that sends the done back', async () => {
      await weekly(E1);
      const done = await act(E1, DAY, 'complete');
      const id = done.logged[0]!.id;
      emit.mockClear();
      await act(E1, DAY, 'undoOccurrence', { occurrenceId: id });
      expect(occurrences()).toEqual([
        {
          ...base(),
          action: 'undone',
          undoneAction: 'done',
          occurrence: '2026-10-05',
          lastOccurrence: '2026-10-05',
          current: '2026-10-05',
          logId: id,
          logIds: [id],
        },
      ]);
      emit.mockClear();
      // The toast Undo of that undo puts the same row back: the done again.
      await undo();
      expect(occurrences()).toEqual([
        {
          ...base(),
          action: 'done',
          occurrence: '2026-10-05',
          lastOccurrence: '2026-10-05',
          current: '2026-10-12',
          logId: id,
          logIds: [id],
          via: 'history',
        },
      ]);
    });

    it('the toast Undo of a done sends exactly one undone; redo sends the done again', async () => {
      await weekly(E1);
      const done = await act(E1, DAY, 'complete');
      const id = done.logged[0]!.id;
      emit.mockClear();
      await undo();
      const undone = occurrences();
      expect(undone).toHaveLength(1);
      expect(undone[0]).toMatchObject({
        action: 'undone',
        undoneAction: 'done',
        logIds: [id],
        current: '2026-10-05',
        via: 'history',
      });
      emit.mockClear();
      await redo();
      expect(occurrences()).toMatchObject([
        { action: 'done', logIds: [id], current: '2026-10-12', via: 'history' },
      ]);
    });
  });

  describe('a status set to done', () => {
    it('through the entry route: table_entry:update first, then one done via status', async () => {
      await weekly(E1);
      emit.mockClear();
      await setStatus(E1, 'Done');
      expect(order()).toEqual([
        ['table_entry:update', E1],
        ['table_entry:occurrence', E1],
      ]);
      expect(occurrences()).toEqual([
        {
          ...base(),
          action: 'done',
          occurrence: '2026-10-05',
          lastOccurrence: '2026-10-05',
          current: '2026-10-12',
          logId: expect.stringMatching(/^tocc-/) as unknown as string,
          logIds: [expect.stringMatching(/^tocc-/) as unknown as string],
          via: 'status',
        },
      ]);
      // The status reset itself back (To do): no change, no event.
      emit.mockClear();
      await setStatus(E1, 'To do');
      expect(occurrences()).toEqual([]);
    });

    it('in an agent batch: each row’s update comes right before its own occurrence', async () => {
      await weekly(E1);
      await weekly(E3);
      emit.mockClear();
      await as(
        () =>
          writeAgentEntries(TABLE_NAME, {
            update: [
              { id: E1, values: { status: 'Done' } },
              { id: E3, values: { status: 'Done' } },
            ],
          }),
        AGENT
      );
      expect(order()).toEqual([
        ['table_entry:update', E1],
        ['table_entry:occurrence', E1],
        ['table_entry:update', E3],
        ['table_entry:occurrence', E3],
      ]);
      expect(occurrences()).toMatchObject([
        { entryName: 'Water plants', action: 'done', via: 'status', actor: { kind: 'agent' } },
        { entryName: 'Stretch', action: 'done', via: 'status', actor: { kind: 'agent' } },
      ]);
      // A person undoing the agent's step: one undone per row, in the step's order.
      emit.mockClear();
      await as(() => stepTableHistory('undo', { actor: { kind: 'agent', id: AGENT.actorId } }));
      expect(occurrences()).toMatchObject([
        { entryId: E1, action: 'undone', undoneAction: 'done', via: 'history' },
        { entryId: E3, action: 'undone', undoneAction: 'done', via: 'history' },
      ]);
      expect(occurrences().map((event) => event.actor)).toEqual([
        { kind: 'user', id: USER.actorId },
        { kind: 'user', id: USER.actorId },
      ]);
    });
  });

  describe('agents and the calendar tool', () => {
    it('agent write repeat and calendar complete_occurrence name the agent as actor', async () => {
      await weekly(E1);
      emit.mockClear();
      await as(
        () => writeAgentEntries(TABLE_NAME, { repeat: [{ id: E1, field: 'day', done: true }] }),
        AGENT
      );
      const caller: CalendarCaller = {
        agentId: AGENT.actorId,
        tableAccess: () => Promise.resolve({ allowed: true }),
        automationAccess: () => Promise.resolve({ allowed: true }),
        automationWriteAccess: () => Promise.resolve({ allowed: true }),
      };
      const { entry } = await getTableEntry(TABLE, E1);
      await as(
        () =>
          completeOccurrenceOp(
            { table: TABLE_NAME, entry_id: E1, field: 'day', rev: entry.revision.slice(0, 12) },
            caller
          ),
        AGENT
      );
      const agent = { kind: 'agent', id: AGENT.actorId };
      expect(occurrences()).toMatchObject([
        { action: 'done', occurrence: '2026-10-05', current: '2026-10-12', actor: agent },
        { action: 'done', occurrence: '2026-10-12', current: '2026-10-19', actor: agent },
      ]);
      expect(occurrences().every((event) => event.via === 'action')).toBe(true);
    });
  });

  describe('nothing is sent', () => {
    it('for a 409: a stale revision, an ended series, a jump with nothing to skip', async () => {
      await weekly(E1);
      const old = await getTableEntry(TABLE, E1);
      await act(E1, DAY, 'complete');
      emit.mockClear();
      const stale = await caught(() =>
        as(() =>
          tableEntryRepeatAction(TABLE, E1, DAY, 'complete', {
            expectedRevision: old.entry.revision,
            schemaVersion: old.schemaVersion,
          })
        )
      );
      expect(stale.statusCode).toBe(409);

      await act(E3, DAY, 'set', { rrule: 'FREQ=DAILY;COUNT=1' });
      await act(E3, DAY, 'complete');
      emit.mockClear();
      expect((await caught(() => act(E3, DAY, 'complete'))).statusCode).toBe(409);

      await writeRepeat(getDb(), TABLE, AT, E2, interval('FREQ=MINUTELY;INTERVAL=30'));
      const jump = await caught(() =>
        act(E2, AT, 'skip', { jump: true, now: '2026-10-31T08:00:00' })
      );
      expect(jump.statusCode).toBe(409);
      expect(jump.message).toContain('not in the past');
      expect(occurrences()).toEqual([]);
    });

    it('for a move to where it already is', async () => {
      await weekly(E1);
      const same = await act(E1, DAY, 'move', { to: '2026-10-05' });
      expect(same.changed).toBe(false);
      expect(occurrences()).toEqual([]);
    });

    it('for a batch whose second update fails: the first row’s done is rolled back too', async () => {
      await weekly(E1);
      await weekly(E3);
      emit.mockClear();
      const failed = await caught(() =>
        as(
          () =>
            writeAgentEntries(TABLE_NAME, {
              update: [
                { id: E1, values: { status: 'Done' } },
                { id: E3, values: { status: 'Done' }, rev: '00000000' },
              ],
            }),
          AGENT
        )
      );
      expect(failed.statusCode).toBe(409);
      expect(emitted('table_entry:update')).toEqual([]);
      expect(occurrences()).toEqual([]);
      expect((await getTableEntryRepeats(TABLE, E1)).log).toEqual([]);
    });
  });

  it('a hook’s own tool call is stamped as the origin; table_entry:update stays as it was', async () => {
    await weekly(E1);
    emit.mockClear();
    await runAtChainDepth(1, () => act(E1, DAY, 'complete'), {
      kind: 'hook',
      hookName: 'test-hook',
    });
    expect(occurrences()).toMatchObject([
      { action: 'done', origin: { kind: 'hook', hookName: 'test-hook' } },
    ]);
    expect(emitted('table_entry:update')).toEqual([
      {
        tableId: TABLE,
        entryId: E1,
        changes: [{ field: DAY, from: '2026-10-05', to: '2026-10-12' }],
      },
    ]);
  });

  it('a test run resolves a sample from the row’s newest logged occurrence', async () => {
    await weekly(E1);
    await expect(
      resolveHookInvocations('test-hook', {
        tableId: TABLE,
        entryId: E1,
        eventName: 'table_entry:occurrence',
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await act(E1, DAY, 'complete');
    const moved = await act(E1, DAY, 'move', { to: '2026-10-14' });
    const [invocation] = await resolveHookInvocations('test-hook', {
      tableId: TABLE,
      entryId: E1,
      eventName: 'table_entry:occurrence',
    });
    expect(invocation).toMatchObject({ nodeId: E1, eventName: 'table_entry:occurrence' });
    expect(invocation!.event).toEqual({
      ...base(),
      action: 'moved',
      occurrence: '2026-10-12',
      lastOccurrence: '2026-10-12',
      movedTo: '2026-10-14',
      current: '2026-10-12',
      logId: moved.logged[0]!.id,
      logIds: [moved.logged[0]!.id],
    });
  });
});

describe('table_entry:occurrence with registered hooks (real DB, real hook builds)', () => {
  let hooksRoot: string;
  let server: http.Server;
  let serverUrl: string;
  let registry: HookRegistryService;

  async function writeHook(name: string, source: string): Promise<void> {
    const dir = path.join(hooksRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'hook.ts'), source, 'utf-8');
    await registry.registerHookFolder(name);
    await registry.setEnabled(name, true);
  }

  async function until(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out waiting');
  }

  /** Until no hook run is in flight for a while (the dispatch defers a settings read first). */
  async function quiet(): Promise<void> {
    let idleSince = Date.now();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await registry.getRunner().settle();
      if (registry.getRunner().inFlightCount > 0) idleSince = Date.now();
      if (Date.now() - idleSince >= 1_500) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    await toolRegistry.load();
    const sync = await toolRegistry.syncToDatabase();
    expect(sync.errors).toEqual([]);
    hooksRoot = await mkdtemp(path.join(tmpdir(), 'snaglet-occurrence-hooks-'));
    // The real tool route a hook's snaglet.tools.execute calls, as a person's request.
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithActor(USER, () => next()));
    app.use('/api/tools', toolDispatchAuthMiddleware, executionRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  beforeEach(async () => {
    await clean();
    await setup();
    registry = new HookRegistryService({
      dir: hooksRoot,
      serverUrl,
      hookTimeoutMs: 20_000,
      describeTimeoutMs: 20_000,
      concurrency: 2,
    });
  });

  afterEach(async () => {
    await quiet();
    registry.stop();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(hooksRoot, { recursive: true, force: true });
    await clean();
  });

  it('a hook filtered on {action: "done"} gets the done event and not the skipped one', async () => {
    const run = jest.spyOn(registry.getRunner(), 'run').mockResolvedValue(undefined);
    await writeHook(
      'occurrence-done-filter',
      `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'table_entry:occurrence',
  filter: { action: 'done' },
  async run(event) {
    await snaglet.log.info(event.entryName + ' was ' + event.action + ' for ' + event.occurrence);
  },
});
`
    );
    await weekly(E1);
    await act(E1, DAY, 'complete');
    await act(E1, DAY, 'skip');
    await until(async () => run.mock.calls.length >= 1);
    await quiet();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({
      hookName: 'occurrence-done-filter',
      eventName: 'table_entry:occurrence',
      event: {
        type: 'table_entry:occurrence',
        action: 'done',
        entryName: 'Water plants',
        occurrence: '2026-10-05',
      },
    });
  }, 90_000);

  it('a hook that marks its own row done on a done event does not trigger itself again', async () => {
    const run = jest.spyOn(registry.getRunner(), 'run');
    const seen: Array<HookEventMap['table_entry:occurrence']> = [];
    const onOccurrence = (event: HookEventMap['table_entry:occurrence']) => void seen.push(event);
    hooks.on('table_entry:occurrence', onOccurrence);
    try {
      await writeHook(
        'occurrence-loop',
        `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'table_entry:occurrence',
  filter: { action: 'done' },
  async run(event) {
    const result = await snaglet.tools.execute('table', {
      op: 'write',
      table: ${JSON.stringify(TABLE_NAME)},
      update: [{ id: event.entryId, values: { status: 'Done' } }],
    });
    if (!result.success) throw new Error(result.error || 'table write failed');
  },
});
`
      );
      await weekly(E1);
      // A person marks it done; the hook marks the next one done; that one
      // carries the hook as its origin, so the hook never sees it.
      await setStatus(E1, 'Done');
      await until(async () => (await getTableEntryRepeats(TABLE, E1)).log.length >= 2);
      await quiet();
      expect(run).toHaveBeenCalledTimes(1);
      const log = (await getTableEntryRepeats(TABLE, E1)).log;
      expect(log.map((row) => [row.occurrence, row.kind]).sort()).toEqual([
        ['2026-10-05', 'done'],
        ['2026-10-12', 'done'],
      ]);
      expect((await getTableEntryRepeats(TABLE, E1)).repeats[DAY]?.current).toBe('2026-10-19');
      expect(seen).toMatchObject([
        { action: 'done', occurrence: '2026-10-05', via: 'status' },
        {
          action: 'done',
          occurrence: '2026-10-12',
          via: 'status',
          origin: { kind: 'hook', hookName: 'occurrence-loop' },
        },
      ]);
      expect(seen[0]).not.toHaveProperty('origin');
    } finally {
      hooks.off('table_entry:occurrence', onOccurrence);
    }
  }, 120_000);
});
