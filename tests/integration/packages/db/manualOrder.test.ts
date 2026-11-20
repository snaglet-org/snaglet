/**
 * Manual sidebar order through the models. Threads: a new thread starts at
 * the top of its project's list (or the flat list), `Threads.moveTo` puts a
 * thread at a slot and shifts the live siblings at or after it down by one,
 * a project change without a slot lands at the top, archived siblings are
 * never rewritten, and activity never reorders anything. Custom tables: a
 * new table lands at the bottom of the workspace-wide list,
 * `TableCatalog.place` shifts live custom siblings (and returns them) the
 * same way, a project change without a slot lands at the bottom, and
 * built-ins are never placed.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  Containers,
  PlacementEvents,
  TableCatalog,
  Threads,
  getDb,
  tombstoneName,
  transaction,
  type CreateThreadInput,
  type TablePlacementInput,
} from '@snaglet/db';

const PROJECT = 'container-4444444444444-project1';
const OTHER_PROJECT = 'container-4444444444444-project2';
const THREAD_A = 'thread-4444444444444-aaaaaaaa1';
const THREAD_B = 'thread-4444444444444-bbbbbbbb1';
const THREAD_C = 'thread-4444444444444-cccccccc1';
const THREAD_D = 'thread-4444444444444-dddddddd1';
const FLAT_A = 'thread-4444444444444-flataaaa1';
const FLAT_B = 'thread-4444444444444-flatbbbb1';
const UNKNOWN_THREAD = 'thread-4444444444444-missing01';
const THREADS = [THREAD_A, THREAD_B, THREAD_C, THREAD_D, FLAT_A, FLAT_B];

const TABLE_ONE = 'table-4444444444444-aaaaaaaaa';
const TABLE_TWO = 'table-4444444444444-bbbbbbbbb';
const TABLE_THREE = 'table-4444444444444-ccccccccc';
const TABLES = [TABLE_ONE, TABLE_TWO, TABLE_THREE];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM public.table_catalog WHERE id = ANY($1::text[])`, [TABLES]);
  // Threads first: deleting a project rewrites its archived threads' scope,
  // which collides with deleting those same rows in one statement.
  await db.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [THREADS]);
  await db.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [[PROJECT, OTHER_PROJECT]]);
}

async function threadIds(projectId: string | null): Promise<string[]> {
  return (await Threads.listByProject(projectId)).map((thread) => thread.id);
}

async function slots(ids: string[]): Promise<Record<string, number>> {
  const { rows } = await getDb().query<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM public.nodes WHERE id = ANY($1::text[])`,
    [ids]
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.sort_order]));
}

function place(id: string, placement: TablePlacementInput) {
  return transaction((tx) => TableCatalog.place(id, placement, tx));
}

async function tableIds(projectId: string | 'none'): Promise<string[]> {
  return (await TableCatalog.listTables({ origin: 'custom', projectId }))
    .map((table) => table.id)
    .filter((id) => TABLES.includes(id));
}

beforeAll(async () => {
  await cleanup();
  await Containers.create({ id: PROJECT, name: 'Order project', category: 'project' });
  await Containers.create({ id: OTHER_PROJECT, name: 'Other order project', category: 'project' });
});

describe('manual order', () => {
  // Nested on purpose: a file-level afterAll runs after the shared database
  // teardown has already closed the pool.
  afterAll(cleanup);

  describe('threads', () => {
    it('starts a new thread at the top of its list, shifting the others down', async () => {
      await Threads.create({ id: THREAD_A, title: 'A', projectId: PROJECT });
      await Threads.create({ id: THREAD_B, title: 'B', projectId: PROJECT });
      const newest = await Threads.create({ id: THREAD_C, title: 'C', projectId: PROJECT });

      expect(newest.sortOrder).toBe(0);
      expect(await threadIds(PROJECT)).toEqual([THREAD_C, THREAD_B, THREAD_A]);
      expect(await slots([THREAD_A, THREAD_B, THREAD_C])).toEqual({
        [THREAD_C]: 0,
        [THREAD_B]: 1,
        [THREAD_A]: 2,
      });
    });

    it('refuses a sort order on create', async () => {
      const id = 'thread-4444444444444-sorted001';
      await expect(
        Threads.create({ id, title: 'Sorted', sortOrder: 2 } as unknown as CreateThreadInput)
      ).rejects.toThrow(/no sort order/);
      expect(await Threads.findById(id)).toBeNull();
    });

    it('puts a thread at a slot, shifting the live siblings at or after it', async () => {
      const top = await Threads.moveTo(THREAD_A, { sortOrder: 0 });
      expect(top).toMatchObject({ id: THREAD_A, projectId: PROJECT, sortOrder: 0 });
      expect(await threadIds(PROJECT)).toEqual([THREAD_A, THREAD_C, THREAD_B]);

      // Down the list: the slot leaves a gap where the thread was.
      await Threads.moveTo(THREAD_A, { sortOrder: 2 });
      expect(await slots([THREAD_A, THREAD_B, THREAD_C])).toEqual({
        [THREAD_C]: 1,
        [THREAD_A]: 2,
        [THREAD_B]: 3,
      });
      expect(await threadIds(PROJECT)).toEqual([THREAD_C, THREAD_A, THREAD_B]);

      // A reorder is not a move: no placement history.
      expect(await PlacementEvents.listByNode(THREAD_A)).toEqual([]);
      // Re-sending the current project with no slot changes nothing.
      expect((await Threads.moveTo(THREAD_A, { projectId: PROJECT }))?.sortOrder).toBe(2);
      expect((await Threads.moveTo(THREAD_A, {}))?.sortOrder).toBe(2);
    });

    it('lands a thread moved to another project without a slot at the top there', async () => {
      const moved = await Threads.setProject(THREAD_B, OTHER_PROJECT);
      expect(moved).toMatchObject({ projectId: OTHER_PROJECT, sortOrder: 0 });
      await Threads.create({ id: THREAD_D, title: 'D', projectId: OTHER_PROJECT });
      await Threads.moveTo(THREAD_C, { projectId: OTHER_PROJECT });

      expect(await threadIds(OTHER_PROJECT)).toEqual([THREAD_C, THREAD_D, THREAD_B]);
      expect(await threadIds(PROJECT)).toEqual([THREAD_A]);
      const history = await PlacementEvents.listByNode(THREAD_C);
      expect(history.map((event) => [event.fromContainerId, event.toContainerId])).toEqual([
        [PROJECT, OTHER_PROJECT],
      ]);
    });

    it('moves a thread to another project at an explicit slot', async () => {
      const moved = await Threads.updateSettings(THREAD_A, {
        projectId: OTHER_PROJECT,
        sortOrder: 1,
      });
      expect(moved).toMatchObject({ projectId: OTHER_PROJECT, sortOrder: 1 });
      expect(await threadIds(OTHER_PROJECT)).toEqual([THREAD_C, THREAD_A, THREAD_D, THREAD_B]);
      expect(await threadIds(PROJECT)).toEqual([]);
    });

    it('never reorders on activity; it only breaks ties', async () => {
      await getDb().query(
        `UPDATE public.threads SET last_message_at = '2099-01-01T00:00:00Z' WHERE id = $1`,
        [THREAD_B]
      );
      expect(await threadIds(OTHER_PROJECT)).toEqual([THREAD_C, THREAD_A, THREAD_D, THREAD_B]);
      const all = (await Threads.listAllOrdered())
        .filter((thread) => thread.projectId === OTHER_PROJECT)
        .map((thread) => thread.id);
      expect(all).toEqual([THREAD_C, THREAD_A, THREAD_D, THREAD_B]);

      // Equal positions fall back to activity, most recent first.
      await getDb().query(`UPDATE public.nodes SET sort_order = 9 WHERE id = ANY($1::text[])`, [
        [THREAD_D, THREAD_B],
      ]);
      expect(await threadIds(OTHER_PROJECT)).toEqual([THREAD_C, THREAD_A, THREAD_B, THREAD_D]);
    });

    it('skips archived siblings and refuses to move an archived thread', async () => {
      await getDb().query(
        `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
        [THREAD_D]
      );
      const before = (await slots([THREAD_D]))[THREAD_D];
      // THREAD_D sits past slot 0; shifting it would trip the immutable guard.
      await Threads.moveTo(THREAD_B, { sortOrder: 0 });
      expect((await slots([THREAD_D]))[THREAD_D]).toBe(before);
      expect(await threadIds(OTHER_PROJECT)).toEqual([THREAD_B, THREAD_C, THREAD_A]);

      await expect(Threads.moveTo(THREAD_D, { sortOrder: 0 })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('archived'),
      });
    });

    it('validates the slot and the thread', async () => {
      for (const sortOrder of [-1, 1.5, Number.NaN]) {
        await expect(Threads.moveTo(THREAD_A, { sortOrder })).rejects.toMatchObject({
          statusCode: 400,
        });
        await expect(Threads.updateSettings(THREAD_A, { sortOrder })).rejects.toMatchObject({
          statusCode: 400,
        });
      }
      expect(await Threads.moveTo(UNKNOWN_THREAD, { sortOrder: 0 })).toBeNull();
      expect(await Threads.moveTo(PROJECT, { sortOrder: 0 })).toBeNull();
    });

    it('orders the flat list the same way, ahead of every project list', async () => {
      await Threads.create({ id: FLAT_A, title: 'Flat A' });
      await Threads.create({ id: FLAT_B, title: 'Flat B' });
      const flat = await threadIds(null);
      expect(flat.indexOf(FLAT_B)).toBeLessThan(flat.indexOf(FLAT_A));

      await Threads.moveTo(FLAT_A, { projectId: null, sortOrder: 0 });
      const reordered = await threadIds(null);
      expect(reordered[0]).toBe(FLAT_A);
      expect(reordered.indexOf(FLAT_A)).toBeLessThan(reordered.indexOf(FLAT_B));

      const all = (await Threads.listAllOrdered()).map((thread) => thread.id);
      expect(all.indexOf(FLAT_B)).toBeLessThan(all.indexOf(THREAD_B));
    });
  });

  describe('custom tables', () => {
    it('registers a new table at the bottom of the workspace-wide list', async () => {
      const one = await TableCatalog.registerCustom({
        id: TABLE_ONE,
        name: 'order_one',
        tableName: 'order_one',
      });
      const two = await TableCatalog.registerCustom({
        id: TABLE_TWO,
        name: 'order_two',
        tableName: 'order_two',
      });
      const three = await TableCatalog.registerCustom({
        id: TABLE_THREE,
        name: 'order_three',
        tableName: 'order_three',
      });
      expect(two.sortOrder).toBe(one.sortOrder + 1);
      expect(three.sortOrder).toBe(two.sortOrder + 1);
      // Name order would put "order_three" before "order_two"; position wins.
      expect(await tableIds('none')).toEqual([TABLE_ONE, TABLE_TWO, TABLE_THREE]);
    });

    it('places a table at a slot and returns every sibling it shifted', async () => {
      const first = (await TableCatalog.findById(TABLE_ONE))?.sortOrder ?? -1;
      const result = await place(TABLE_THREE, { sortOrder: first });
      expect(result?.table).toMatchObject({ id: TABLE_THREE, sortOrder: first, projectId: null });
      expect(result?.shifted.map((row) => [row.id, row.sortOrder])).toEqual([
        [TABLE_ONE, first + 1],
        [TABLE_TWO, first + 2],
      ]);
      expect(await tableIds('none')).toEqual([TABLE_THREE, TABLE_ONE, TABLE_TWO]);

      // Nothing to change: the current row back, nothing shifted.
      expect(await place(TABLE_TWO, {})).toEqual({
        table: await TableCatalog.findById(TABLE_TWO),
        shifted: [],
      });
    });

    it('lands a table moved to a project without a slot at the bottom there', async () => {
      expect((await place(TABLE_ONE, { projectId: PROJECT }))?.table.sortOrder).toBe(0);
      const two = await place(TABLE_TWO, { projectId: PROJECT });
      expect(two).toMatchObject({ table: { projectId: PROJECT, sortOrder: 1 }, shifted: [] });
      expect(await tableIds(PROJECT)).toEqual([TABLE_ONE, TABLE_TWO]);

      // setProject is the same placement with no slot.
      const back = await transaction((tx) => TableCatalog.setProject(TABLE_TWO, null, tx));
      expect(back?.projectId).toBeNull();
      expect(await tableIds('none')).toEqual([TABLE_THREE, TABLE_TWO]);
    });

    it('moves a table into a project at an explicit slot, shifting live siblings only', async () => {
      await place(TABLE_TWO, { projectId: PROJECT });
      await getDb().query(
        `UPDATE public.table_catalog
            SET state = 'archived', state_changed_at = now(), table_name = $2
          WHERE id = $1`,
        [TABLE_TWO, tombstoneName(TABLE_TWO)]
      );
      const archivedSlot = (await TableCatalog.findById(TABLE_TWO))?.sortOrder;

      const result = await place(TABLE_THREE, { projectId: PROJECT, sortOrder: 0 });
      expect(result?.table).toMatchObject({ projectId: PROJECT, sortOrder: 0 });
      expect(result?.shifted.map((row) => row.id)).toEqual([TABLE_ONE]);
      expect((await TableCatalog.findById(TABLE_TWO))?.sortOrder).toBe(archivedSlot);
      expect(await tableIds(PROJECT)).toEqual([TABLE_THREE, TABLE_ONE]);

      // An archived or built-in table is never placed (the domain words why).
      expect(await place(TABLE_TWO, { sortOrder: 0 })).toBeNull();
      expect(await place('table-builtin-docs', { sortOrder: 1 })).toBeNull();
      expect((await TableCatalog.findById('table-builtin-docs'))?.sortOrder).toBe(0);
    });

    it('keeps built-ins first, by name', async () => {
      const builtins = await TableCatalog.listTables({ origin: 'builtin' });
      const names = builtins.map((table) => table.name.toLowerCase());
      expect(names).toEqual([...names].sort());
      expect(builtins.every((table) => table.sortOrder === 0)).toBe(true);
    });
  });
});
