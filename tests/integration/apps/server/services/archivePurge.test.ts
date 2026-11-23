/**
 * Sweeping archived projects with many custom tables, against real
 * PostgreSQL:
 *
 * - no sweep transaction holds more than a bounded number of locks, however
 *   many tables go (each dropped table holds about a dozen until commit);
 * - a project's tables and its node go in the same transaction;
 * - a failed transaction keeps what earlier ones deleted, the error says so,
 *   and running the sweep again finishes;
 * - a table kept for a link from a table that goes later in the same sweep
 *   goes too, as in one transaction; one linked from a live table stays;
 * - the TTL sweep still deletes only what has expired;
 * - no restore lands while a sweep runs, and one already running wins;
 * - a table many others link to never puts them all in one transaction;
 * - cutoffs hold exactly when the session time zone changes clocks.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, getDb, getDbClient, quoteIdentifier, Threads, transaction } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { Actor } from '@snaglet/shared/types/workspace-events';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableHistoryChanged: jest.fn(),
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeArchived: jest.fn(),
  emitTreeNodeRestored: jest.fn(),
  emitTreeNodeDeleted: jest.fn(),
  emitTreeNodeCreated: jest.fn(),
  emitTreeNodeUpdated: jest.fn(),
  snapshotFromContainer: jest.fn(),
  snapshotFromDoc: jest.fn(),
  snapshotFromThread: jest.fn(),
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField } from '@server/domains/tables/tableFields';
import { archiveItem, restoreItem } from '@server/services/ArchiveService';
import { restoreTable } from '@server/domains/tables/tableLifecycle';
import { emitTableRemoved } from '@server/realtime/surfaces/tables';
import { TableLifecycle } from '@snaglet/db/tables/table_history';
import { TableFields } from '@snaglet/db/tables/table_fields';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { purgeExpiredArchivedNodes } from '@server/services/ArchivePurge';
import { archiveTtlSweeper } from '@server/services/ArchiveTtlSweeper';
import archiveRouter from '@server/routes/archive';
import { errorHandler } from '@server/middleware/errorHandler';
import { getPanelToken } from '@server/middleware/panelAuth';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const PREFIX = 'swplk';
const THREAD = `thread-1111111111111-${PREFIX}`;

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);
const containerId = (key: string) => `container-1111111111111-${PREFIX}${key}`;
const tableId = (key: string, index: number) =>
  `table-1111111111111-${key}${String(index).padStart(3, '0')}`;

function app(): express.Application {
  const result = express();
  result.use(express.json());
  result.use((_req, _res, next) => runWithActor(USER, () => next()));
  result.use('/api/archive', archiveRouter);
  result.use(errorHandler);
  return result;
}

const sweep = () =>
  request(app()).post('/api/archive/sweep-all').set({ 'X-Snaglet-Panel-Token': getPanelToken() });

async function clean(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    "SELECT table_name FROM public.table_catalog WHERE origin = 'custom'"
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
  await getDb().query('DELETE FROM public.table_history');
  await getDb().query('DELETE FROM public.nodes WHERE id LIKE $1', [`%${PREFIX}%`]);
}

/** A project (`key` of four letters or digits) with `tables` custom tables, archived unless in a folder. */
async function project(key: string, tables: number, parentId?: string): Promise<string> {
  const id = containerId(key);
  await Containers.create({ id, name: `Show ${key}`, category: 'project', parentId });
  for (let index = 0; index < tables; index += 1)
    await as(() =>
      createTable({ id: tableId(key, index), name: `${key}_${index}`, projectId: id })
    );
  if (!parentId) await as(() => archiveItem(id, { actor: USER }));
  return id;
}

/** A relation field `id` on table `from` pointing at table `to`. */
const link = (from: string, to: string, id: string) =>
  as(() =>
    createTableField(from, {
      id: `field-1111111111111-${id}`,
      name: id,
      description: null,
      type: 'relation',
      nullable: true,
      defaultValue: null,
      referenceTableId: to,
    })
  );

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

const customTables = () =>
  count("SELECT count(*)::int AS n FROM public.table_catalog WHERE origin = 'custom'");
const tablesOf = (projectId: string) =>
  count(
    "SELECT count(*)::int AS n FROM public.table_catalog WHERE origin = 'custom' AND state = 'archived' AND project_id = $1",
    [projectId]
  );
const archivedNodes = () =>
  count('SELECT count(*)::int AS n FROM public.nodes WHERE archived AND id LIKE $1', [
    `%${PREFIX}%`,
  ]);
const nodeExists = async (id: string) =>
  (await count('SELECT count(*)::int AS n FROM public.nodes WHERE id = $1', [id])) === 1;

async function state(id: string) {
  const row = await TableCatalog.findById(id);
  return row ? { state: row.state, projectId: row.projectId } : null;
}

/** Shared lock-table slots each transaction holds when its work is done (its peak). */
let lockPeaks: number[] = [];
let restoreTransaction: (() => void) | null = null;
/** Time zone every transaction runs in, when set. */
let txZone: string | null = null;
/** Runs at the end of every transaction, before it commits. */
let txCheck: ((tx: { query: ReturnType<typeof getDb>['query'] }) => Promise<void>) | null = null;

beforeEach(async () => {
  await clean();
  lockPeaks = [];
  txZone = null;
  txCheck = null;
  const client = await getDbClient();
  const original = client.transaction.bind(client);
  const spy = jest.spyOn(client, 'transaction').mockImplementation(((
    fn: (tx: typeof client) => Promise<unknown>
  ) =>
    original(async (tx) => {
      if (txZone) await tx.query(`SET LOCAL TIME ZONE '${txZone}'`);
      const value = await fn(tx);
      const { rows } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND NOT fastpath'
      );
      lockPeaks.push(rows[0]?.n ?? 0);
      await txCheck?.(tx);
      return value;
    })) as typeof client.transaction);
  restoreTransaction = () => spy.mockRestore();
});

/** Wait until some session of this database waits for a lock. */
async function lockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await count(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('No session started waiting for a lock');
}

afterEach(() => {
  restoreTransaction?.();
  activeRunTracker.releaseThreadPurge(THREAD);
});

describe('sweeping archived projects with many tables', () => {
  it('drops them all without any transaction holding more than a bounded number of locks', async () => {
    for (let index = 0; index < 20; index += 1) await project(`p${index}`.padEnd(4, 'x'), 10);
    // A folder of projects archived in one go: one cohort with more tables
    // than one transaction takes.
    const folder = containerId('fold');
    await Containers.create({ id: folder, name: 'Shows' });
    for (let index = 0; index < 6; index += 1)
      await project(`f${index}`.padEnd(4, 'x'), 10, folder);
    await as(() => archiveItem(folder, { actor: USER }));
    expect(await customTables()).toBe(260);

    const res = await sweep();

    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({
      deletedContainers: 27,
      deletedTables: 260,
      skippedTables: [],
    });
    expect(await customTables()).toBe(0);
    expect(await archivedNodes()).toBe(0);
    // The bundled cluster's lock table holds 64 x ~50 slots for all sessions
    // together by default; dropping all 260 tables in one transaction takes
    // over 3,000 of them.
    expect(lockPeaks.length).toBeGreaterThan(1);
    expect(Math.max(...lockPeaks)).toBeLessThan(1000);
    // 260 real tables created and dropped: slow machines need more than the 5-second default.
  }, 60_000);

  it('keeps what earlier transactions deleted when a later one fails, and finishes when run again', async () => {
    const early = containerId('earl');
    const late = containerId('late');
    for (const [key, id] of [
      ['earl', early],
      ['late', late],
    ] as const) {
      await Containers.create({ id, name: `Show ${key}`, category: 'project' });
      for (let index = 0; index < 20; index += 1)
        await as(() =>
          createTable({ id: tableId(key, index), name: `${key}_${index}`, projectId: id })
        );
    }
    // A table of the later project links to one of the earlier: the earlier
    // one is kept (then without a project) until the later one is gone.
    const linked = tableId('earl', 0);
    await link(tableId('late', 0), linked, 'swplklnk');
    await as(() => archiveItem(early, { actor: USER }));
    await as(() => archiveItem(late, { actor: USER }));
    await Threads.create({ id: THREAD, title: 'Notes' });
    await as(() => archiveItem(THREAD, { actor: USER }));
    // A run holds the thread archived last, so the last transaction fails.
    expect(activeRunTracker.reserveThreadPurge(THREAD)).toBe(true);

    const stopped = await sweep();

    expect(stopped.status).toBe(409);
    expect(stopped.body.error.message).toMatch(
      /^Sweep stopped partway: Thread .* has an active run.*\. What it deleted stays deleted; sweep again to finish\.$/
    );
    expect(stopped.body.error.details).toMatchObject({ deletedContainers: 1, deletedTables: 19 });
    // The earlier project went with its tables but the linked one, left
    // archived without a project; the later one is untouched.
    expect(await nodeExists(early)).toBe(false);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM public.table_catalog WHERE origin = 'custom' AND id LIKE 'table-1111111111111-earl%'"
      )
    ).toBe(1);
    expect(await state(linked)).toEqual({ state: 'archived', projectId: null });
    expect(await nodeExists(late)).toBe(true);
    expect(await tablesOf(late)).toBe(20);

    activeRunTracker.releaseThreadPurge(THREAD);
    const finished = await sweep();

    expect(finished.status).toBe(200);
    // The archived-tables pass takes the kept table once nothing links to it.
    expect(finished.body.data.result).toMatchObject({
      deletedContainers: 1,
      deletedOther: 1,
      deletedTables: 21,
      skippedTables: [],
    });
    expect(await state(linked)).toBeNull();
    expect(await customTables()).toBe(0);
    expect(await archivedNodes()).toBe(0);
  });

  it('drops a table kept for a link from a table swept later, and keeps one a live table links to', async () => {
    const first = containerId('frst');
    const second = containerId('scnd');
    const live = containerId('live');
    await Containers.create({ id: first, name: 'First', category: 'project' });
    await Containers.create({ id: second, name: 'Second', category: 'project' });
    await Containers.create({ id: live, name: 'Live', category: 'project' });
    const [target, linkedFromLive, source, outside] = [
      tableId('frst', 0),
      tableId('frst', 1),
      tableId('scnd', 0),
      tableId('live', 0),
    ] as const;
    await as(() => createTable({ id: target, name: 'first_target', projectId: first }));
    await as(() => createTable({ id: linkedFromLive, name: 'first_kept', projectId: first }));
    await as(() => createTable({ id: source, name: 'second_source', projectId: second }));
    await as(() => createTable({ id: outside, name: 'live_source', projectId: live }));
    await link(source, target, 'swplkone');
    await link(outside, linkedFromLive, 'swplktwo');
    await as(() => archiveItem(first, { actor: USER }));
    await as(() => archiveItem(second, { actor: USER }));

    // One table per transaction: the two projects go in separate ones.
    const result = await purgeExpiredArchivedNodes('0 seconds', { maxTablesPerTransaction: 1 });

    expect(await state(target)).toBeNull();
    expect(await state(source)).toBeNull();
    expect(await state(linkedFromLive)).toEqual({ state: 'archived', projectId: null });
    expect(await state(outside)).toEqual({ state: 'active', projectId: live });
    expect(result.tables.kept).toEqual([linkedFromLive]);
    expect(result.tables.dropped.map((table) => table.id).sort()).toEqual([source, target].sort());
    expect(await nodeExists(first)).toBe(false);
    expect(await nodeExists(second)).toBe(false);
  });

  it('deletes only expired projects on the TTL sweep, in bounded transactions', async () => {
    const expired = await project('expd', 40);
    const fresh = await project('frsh', 3);
    await getDb().query(
      `UPDATE public.nodes SET archived_at = archived_at - interval '31 days' WHERE id = $1`,
      [expired]
    );

    const result = await archiveTtlSweeper.tick();

    expect(result?.deletedContainers).toBe(1);
    expect(await nodeExists(expired)).toBe(false);
    expect(await tablesOf(expired)).toBe(0);
    expect(await nodeExists(fresh)).toBe(true);
    expect(await tablesOf(fresh)).toBe(3);
    expect(lockPeaks.length).toBeGreaterThan(1);
  });
});

describe('restores while a sweep runs', () => {
  it('refuses them between the transactions of a large project and leaves nothing half-dropped', async () => {
    const show = await project('rstr', 6);
    const attempts: Array<Promise<unknown>> = [];
    // The first chunk of tables has committed; the project is still archived.
    jest.mocked(emitTableRemoved).mockImplementationOnce(() => {
      attempts.push(as(() => restoreItem(show, { actor: USER })));
      attempts.push(as(() => restoreItem(tableId('rstr', 5), { actor: USER })));
      attempts.push(as(() => restoreTable(tableId('rstr', 4), {})));
    });

    await purgeExpiredArchivedNodes('0 seconds', { maxTablesPerTransaction: 2 });

    expect(attempts).toHaveLength(3);
    for (const attempt of attempts)
      await expect(attempt).rejects.toMatchObject({
        statusCode: 409,
        message: 'A sweep is running; try again in a moment.',
      });
    expect(await nodeExists(show)).toBe(false);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM public.table_catalog WHERE id LIKE 'table-1111111111111-rstr%'"
      )
    ).toBe(0);
    // Free again once the sweep is done.
    const later = await project('rst2', 1);
    await expect(as(() => restoreItem(later, { actor: USER }))).resolves.toMatchObject({
      alreadyActive: false,
    });
  });

  it('lets a restore that was already running commit first and sweeps nothing of it', async () => {
    const show = await project('wait', 3);
    let holding = () => {};
    const held = new Promise<void>((resolve) => (holding = resolve));
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const restoreTables = TableLifecycle.restoreProjectTables.bind(TableLifecycle);
    const pause = jest
      .spyOn(TableLifecycle, 'restoreProjectTables')
      .mockImplementationOnce(async (...args) => {
        // The project row is restored but not committed: the sweep must wait for it.
        holding();
        await released;
        return restoreTables(...args);
      });

    const restoring = as(() => restoreItem(show, { actor: USER }));
    await held;
    const sweeping = purgeExpiredArchivedNodes('0 seconds');
    await lockWaiter();
    release();
    const restored = await restoring;
    await sweeping;
    pause.mockRestore();

    expect(restored).toMatchObject({ alreadyActive: false });
    expect(await nodeExists(show)).toBe(true);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM public.table_catalog WHERE project_id = $1 AND state = 'active'",
        [show]
      )
    ).toBe(3);
  });
});

describe('a table many others link to', () => {
  it('never locks all of them in one transaction', async () => {
    // Baseline: the same number of tables with no links, three per transaction.
    await project('base', 25);
    await purgeExpiredArchivedNodes('0 seconds', { maxTablesPerTransaction: 3 });
    const baseline = Math.max(...lockPeaks);
    lockPeaks = [];

    const hubProject = containerId('hubp');
    await Containers.create({ id: hubProject, name: 'Hub', category: 'project' });
    const hub = tableId('hubp', 0);
    await as(() => createTable({ id: hub, name: 'hub_people', projectId: hubProject }));
    for (let index = 1; index <= 24; index += 1) {
      await as(() =>
        createTable({
          id: tableId('hubp', index),
          name: `hub_spoke_${index}`,
          projectId: hubProject,
        })
      );
      await link(tableId('hubp', index), hub, `swplkhub${index}`);
    }
    await as(() => archiveItem(hubProject, { actor: USER }));
    const locked: number[] = [];
    const lockTables = TableFields.lockTables.bind(TableFields);
    const lockSpy = jest.spyOn(TableFields, 'lockTables').mockImplementation((ids, tx) => {
      locked.push(new Set(ids).size);
      return lockTables(ids, tx);
    });

    await purgeExpiredArchivedNodes('0 seconds', { maxTablesPerTransaction: 3 });
    lockSpy.mockRestore();

    expect(await nodeExists(hubProject)).toBe(false);
    expect(await customTables()).toBe(0);
    // Dropping the hub first would lock all 24 tables that link to it, to
    // drop their relation fields, in one transaction.
    expect(Math.max(...locked)).toBeLessThanOrEqual(3);
    expect(Math.max(...lockPeaks)).toBeLessThanOrEqual(baseline + 30);
  });

  it('drops tables that all link to each other a few links at a time', async () => {
    const mesh = containerId('mesh');
    await Containers.create({ id: mesh, name: 'Mesh', category: 'project' });
    for (let index = 0; index < 5; index += 1)
      await as(() =>
        createTable({ id: tableId('mesh', index), name: `mesh_${index}`, projectId: mesh })
      );
    for (let from = 0; from < 5; from += 1)
      for (let to = 0; to < 5; to += 1)
        if (from !== to)
          await link(tableId('mesh', from), tableId('mesh', to), `swplkm${from}${to}`);
    await as(() => archiveItem(mesh, { actor: USER }));
    const locked: number[] = [];
    const lockTables = TableFields.lockTables.bind(TableFields);
    const lockSpy = jest.spyOn(TableFields, 'lockTables').mockImplementation((ids, tx) => {
      locked.push(new Set(ids).size);
      return lockTables(ids, tx);
    });

    await purgeExpiredArchivedNodes('0 seconds', { maxTablesPerTransaction: 3 });
    lockSpy.mockRestore();

    expect(await nodeExists(mesh)).toBe(false);
    expect(await customTables()).toBe(0);
    expect(Math.max(...locked)).toBeLessThanOrEqual(3);
  });
});

describe('cutoffs across a daylight-saving change', () => {
  it('deletes in each transaction exactly what a sweep up to its cutoff deletes', async () => {
    txZone = 'America/Los_Angeles';
    // The first project's table is kept for a live table's link, so the
    // first transaction drops no table (the schema locks run in UTC).
    const live = containerId('dstl');
    await Containers.create({ id: live, name: 'Live', category: 'project' });
    await as(() => createTable({ id: tableId('dstl', 0), name: 'dst_live', projectId: live }));
    const shows = ['dst0', 'dst1', 'dst2'].map(containerId);
    for (const [index, show] of shows.entries()) {
      await Containers.create({ id: show, name: `Show ${index}`, category: 'project' });
      await as(() =>
        createTable({ id: tableId(`dst${index}`, 0), name: `dst_${index}`, projectId: show })
      );
    }
    await link(tableId('dstl', 0), tableId('dst0', 0), 'swplkdst');
    for (const show of shows) await as(() => archiveItem(show, { actor: USER }));
    // A cutoff with one clock change between it and now, where
    // `now() - (now() - cutoff)` lands an hour away from it.
    const { rows } = await transaction((tx) =>
      tx.query<{ cutoff: string }>(
        `SELECT (now() - make_interval(days => k + 2))::text AS cutoff
           FROM generate_series(1, 400) AS k
          WHERE now() - (now() - (now() - make_interval(days => k)))
             <> now() - make_interval(days => k)
          ORDER BY k LIMIT 1`
      )
    );
    const cutoff = rows[0]?.cutoff;
    expect(cutoff).toBeDefined();
    for (const [index, show] of shows.entries())
      await getDb().query(
        `UPDATE public.nodes SET archived_at = $2::timestamptz + make_interval(mins => $3)
          WHERE id = $1`,
        [show, cutoff, (index - 1) * 30]
      );
    const left: string[][] = [];
    txCheck = async (tx) => {
      const { rows: present } = await tx.query<{ id: string }>(
        'SELECT id FROM public.nodes WHERE id = ANY($1::text[]) ORDER BY id',
        [shows]
      );
      left.push(present.map((row) => row.id));
    };

    // One table per transaction: sweeps up to the second and third archive
    // times, then the rest.
    await purgeExpiredArchivedNodes('0 seconds', { maxTablesPerTransaction: 1 });

    expect(left).toEqual([[shows[1], shows[2]], [shows[2]], []]);
    expect(await state(tableId('dst0', 0))).toEqual({ state: 'archived', projectId: null });
    expect(await state(tableId('dst1', 0))).toBeNull();
    expect(await state(tableId('dst2', 0))).toBeNull();
  });
});
