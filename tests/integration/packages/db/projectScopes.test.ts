/**
 * Project scopes through the models: threads are created flat or in a
 * project and never with a folder placement; `Threads.setProject` validates
 * its target, records placement history and refuses archived threads;
 * project listings follow the manual order (see manualOrder.test.ts);
 * `Projects.nearestProjectForContainer`
 * walks the folder tree; a container's category never crosses 'project' after
 * creation; and custom tables take a project home while built-ins never do.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  Containers,
  Nodes,
  PlacementEvents,
  Projects,
  TableCatalog,
  Threads,
  getDb,
  transaction,
  type CreateThreadInput,
} from '@snaglet/db';

const PROJECT = 'container-2222222222222-project1';
const PROJECT_FOLDER = 'container-2222222222222-folder1';
const NESTED_FOLDER = 'container-2222222222222-folder2';
const OTHER_PROJECT = 'container-2222222222222-project2';
const PLAIN = 'container-2222222222222-plain1';
const PROMOTED = 'container-2222222222222-promote1';
const THREAD_A = 'thread-2222222222222-aaaaaaaaa';
const THREAD_B = 'thread-2222222222222-bbbbbbbbb';
const THREAD_FLAT = 'thread-2222222222222-fffffffff';
const THREAD_MOVED = 'thread-2222222222222-mmmmmmmmm';
const THREAD_ARCHIVED = 'thread-2222222222222-rrrrrrrrr';
const CUSTOM_TABLE = 'table-2222222222222-aaaaaaaaa';
const UNKNOWN = 'container-2222222222222-missing1';

/** Hand a thread write a folder placement the types do not allow. */
function withPlacement(input: CreateThreadInput, placement: object): CreateThreadInput {
  return { ...input, ...placement } as CreateThreadInput;
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM public.table_catalog WHERE id = $1`, [CUSTOM_TABLE]);
  await db.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
    [
      THREAD_A,
      THREAD_B,
      THREAD_FLAT,
      THREAD_MOVED,
      THREAD_ARCHIVED,
      NESTED_FOLDER,
      PROJECT_FOLDER,
      PROJECT,
      OTHER_PROJECT,
      PLAIN,
      PROMOTED,
    ],
  ]);
}

beforeAll(async () => {
  await cleanup();
  await Containers.create({ id: PROJECT, name: 'Scope project', category: 'project' });
  await Containers.create({ id: OTHER_PROJECT, name: 'Other project', category: 'project' });
  await Containers.create({ id: PROJECT_FOLDER, name: 'Project folder', parentId: PROJECT });
  await Containers.create({ id: NESTED_FOLDER, name: 'Nested folder', parentId: PROJECT_FOLDER });
  await Containers.create({ id: PLAIN, name: 'Plain folder' });
  await Containers.create({ id: PROMOTED, name: 'Folder to promote' });
});

describe('project scopes', () => {
  // Nested on purpose: a file-level afterAll runs after the shared database
  // teardown has already closed the pool.
  afterAll(cleanup);

  describe('Threads.create', () => {
    it('creates a thread in a project, or flat, and never with a container', async () => {
      const inProject = await Threads.create({ id: THREAD_A, title: 'A', projectId: PROJECT });
      expect(inProject.projectId).toBe(PROJECT);
      expect(inProject).not.toHaveProperty('containerId');

      const flat = await Threads.create({ id: THREAD_FLAT, title: 'Flat' });
      expect(flat.projectId).toBeNull();

      const { rows } = await getDb().query<{ container_id: string | null }>(
        `SELECT container_id FROM public.nodes WHERE id = ANY($1::text[])`,
        [[THREAD_A, THREAD_FLAT]]
      );
      expect(rows.map((r) => r.container_id)).toEqual([null, null]);
    });

    it('refuses a folder placement and a sort order', async () => {
      const id = 'thread-2222222222222-placed111';
      await expect(
        Threads.create(withPlacement({ id, title: 'Placed' }, { containerId: PROJECT_FOLDER }))
      ).rejects.toThrow(/placed by project_id/);
      await expect(
        Threads.create(withPlacement({ id, title: 'Placed' }, { containerId: null }))
      ).rejects.toThrow(/placed by project_id/);
      await expect(
        Threads.create(withPlacement({ id, title: 'Sorted' }, { sortOrder: 3 }))
      ).rejects.toThrow(/no sort order/);
      expect(await Threads.findById(id)).toBeNull();
    });

    it('refuses a project that is not a project container, or does not exist', async () => {
      const id = 'thread-2222222222222-badproj11';
      await expect(Threads.create({ id, title: 'Bad', projectId: PLAIN })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('not a project'),
      });
      await expect(Threads.create({ id, title: 'Bad', projectId: THREAD_A })).rejects.toMatchObject(
        { statusCode: 400 }
      );
      await expect(Threads.create({ id, title: 'Bad', projectId: UNKNOWN })).rejects.toMatchObject({
        statusCode: 404,
      });
      // The refused create left no spine row behind.
      expect(await Nodes.getType(id)).toBeNull();
    });
  });

  describe('Threads.setProject', () => {
    it('moves a thread between projects and the workspace level, recording history', async () => {
      await Threads.create({ id: THREAD_MOVED, title: 'Moved' });

      const scoped = await Threads.setProject(THREAD_MOVED, PROJECT);
      expect(scoped?.projectId).toBe(PROJECT);
      const moved = await Threads.setProject(THREAD_MOVED, OTHER_PROJECT);
      expect(moved?.projectId).toBe(OTHER_PROJECT);
      // Same project again: no-op, no history row.
      expect((await Threads.setProject(THREAD_MOVED, OTHER_PROJECT))?.projectId).toBe(
        OTHER_PROJECT
      );
      const flat = await Threads.setProject(THREAD_MOVED, null);
      expect(flat?.projectId).toBeNull();

      const history = await PlacementEvents.listByNode(THREAD_MOVED);
      expect(
        history.map((event) => [event.fromContainerId, event.toContainerId]).reverse()
      ).toEqual([
        [null, PROJECT],
        [PROJECT, OTHER_PROJECT],
        [OTHER_PROJECT, null],
      ]);
    });

    it('validates the target and the thread', async () => {
      await expect(Threads.setProject(THREAD_FLAT, PLAIN)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(Threads.setProject(THREAD_FLAT, UNKNOWN)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await Threads.setProject(UNKNOWN, PROJECT)).toBeNull();
      // A container id is not a thread.
      expect(await Threads.setProject(PLAIN, PROJECT)).toBeNull();
      expect((await Threads.findById(THREAD_FLAT))?.projectId).toBeNull();
    });

    it('refuses an archived thread', async () => {
      await Threads.create({ id: THREAD_ARCHIVED, title: 'Archived', projectId: PROJECT });
      await getDb().query(
        `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
        [THREAD_ARCHIVED]
      );
      await expect(Threads.setProject(THREAD_ARCHIVED, OTHER_PROJECT)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('archived'),
      });
      expect((await Threads.findById(THREAD_ARCHIVED))?.projectId).toBe(PROJECT);
    });

    it('is reachable from updateSettings and refuses placement there too', async () => {
      const row = await Threads.updateSettings(THREAD_MOVED, {
        title: 'Moved again',
        projectId: PROJECT,
      });
      expect(row).toMatchObject({ title: 'Moved again', projectId: PROJECT });
      await expect(
        Threads.updateSettings(THREAD_MOVED, { containerId: PROJECT_FOLDER } as never)
      ).rejects.toThrow(/placed by project_id/);
      expect(await Threads.updateSettings(UNKNOWN, { projectId: null })).toBeNull();
    });
  });

  describe('listings', () => {
    it('lists a project and the flat level in manual order, hiding archived threads', async () => {
      await Threads.create({ id: THREAD_B, title: 'B', projectId: PROJECT });
      await Threads.setProject(THREAD_MOVED, null);
      // Activity does not reorder: B is on top because it is the newest.
      await getDb().query(
        `UPDATE public.threads SET last_message_at = '2030-01-01T00:00:00Z' WHERE id = $1`,
        [THREAD_A]
      );

      const inProject = await Threads.listByProject(PROJECT);
      expect(inProject.map((t) => t.id)).toEqual([THREAD_B, THREAD_A]);
      expect(await Threads.findByProject(PROJECT)).toEqual(inProject);
      expect(
        (await Threads.listByProject(PROJECT, { includeArchived: true })).map((t) => t.id)
      ).toContain(THREAD_ARCHIVED);

      const flat = (await Threads.findFlat()).map((t) => t.id);
      expect(flat).toEqual(expect.arrayContaining([THREAD_FLAT, THREAD_MOVED]));
      expect(flat).not.toContain(THREAD_A);
      expect(flat.indexOf(THREAD_MOVED)).toBeLessThan(flat.indexOf(THREAD_FLAT));

      const all = await Threads.listAllOrdered();
      const ids = all.map((t) => t.id);
      expect(ids.indexOf(THREAD_FLAT)).toBeLessThan(ids.indexOf(THREAD_A));
      expect(ids).not.toContain(THREAD_ARCHIVED);
      expect(all.every((t) => 'projectId' in t && !('containerId' in t))).toBe(true);
    });
  });

  describe('Nodes placement guards', () => {
    it('refuses a container for a thread node', async () => {
      await expect(
        Nodes.ensure('thread-2222222222222-ensure111', 'thread', { containerId: PLAIN })
      ).rejects.toThrow(/placed by project_id/);
      await expect(Nodes.assertPlacementParent(PLAIN, undefined, 'thread')).rejects.toThrow(
        /placed by project_id/
      );
      await expect(Nodes.assertPlacementParent(null, undefined, 'thread')).rejects.toThrow(
        /placed by project_id/
      );
      await expect(Nodes.assertPlacementParent(PLAIN, undefined, 'doc')).resolves.toBeUndefined();
      expect(await Nodes.getProjectId(THREAD_A)).toBe(PROJECT);
      expect(await Nodes.getProjectId(THREAD_FLAT)).toBeNull();
    });
  });

  describe('Projects', () => {
    it('finds the nearest project for a container', async () => {
      expect(await Projects.nearestProjectForContainer(PROJECT)).toBe(PROJECT);
      expect(await Projects.nearestProjectForContainer(PROJECT_FOLDER)).toBe(PROJECT);
      expect(await Projects.nearestProjectForContainer(NESTED_FOLDER)).toBe(PROJECT);
      expect(await Projects.nearestProjectForContainer(PLAIN)).toBeNull();
      expect(await Projects.nearestProjectForContainer(null)).toBeNull();
      expect(await Projects.nearestProjectForContainer(UNKNOWN)).toBeNull();
      // A thread id is not a container.
      expect(await Projects.nearestProjectForContainer(THREAD_A)).toBeNull();
    });

    it('asserts a project container', async () => {
      await expect(Projects.assertProjectContainer(PROJECT)).resolves.toBeUndefined();
      await expect(Projects.assertProjectContainer(null)).resolves.toBeUndefined();
      await expect(Projects.assertProjectContainer(PLAIN)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(Projects.assertProjectContainer(UNKNOWN)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('promotes a folder to a project but never lets a project leave the category', async () => {
      // A plain folder may become a project in place (nothing scopes to a folder).
      const promoted = await Containers.update(PROMOTED, { category: 'project' });
      expect(promoted?.category).toBe('project');
      await expect(Projects.assertProjectContainer(PROMOTED)).resolves.toBeUndefined();
      // Neither a born project nor a promoted one can be demoted.
      for (const id of [PROJECT, PROMOTED]) {
        await expect(Containers.update(id, { category: null })).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining("out of 'project'"),
        });
      }
      // A 'status' category is refused by validation, not translated.
      await expect(Containers.update(PLAIN, { category: 'status' as never })).rejects.toMatchObject(
        { statusCode: 400 }
      );
      expect((await Containers.update(PLAIN, { category: null }))?.category).toBeNull();
      // The same project category passes (nothing changes).
      expect((await Containers.update(PROJECT, { category: 'project' }))?.category).toBe('project');
      // The database refuses the raw demotion as well.
      await expect(
        getDb().query(`UPDATE public.containers SET category = NULL WHERE id = $1`, [PROJECT])
      ).rejects.toThrow(/cannot change out of 'project'/);
    });

    it('writes the facet only onto an existing project container', async () => {
      const written = await Projects.create({
        containerId: PROJECT,
        name: 'Scope project renamed',
        folderPath: '/tmp/test-project',
      });
      expect(written).toMatchObject({ id: PROJECT, name: 'Scope project renamed' });
      await expect(Projects.create({ containerId: PLAIN, name: 'Promoted' })).rejects.toMatchObject(
        { statusCode: 400 }
      );
      expect((await Containers.findById(PLAIN))?.category).toBeNull();
    });
  });

  describe('TableCatalog.setProject', () => {
    const setProject = (id: string, projectId: string | null) =>
      transaction((tx) => TableCatalog.setProject(id, projectId, tx));

    it('gives a custom table a project home and lists by it', async () => {
      await TableCatalog.registerCustom({
        id: CUSTOM_TABLE,
        name: 'test_scope_table',
        tableName: 'test_scope_table',
      });
      expect((await TableCatalog.findById(CUSTOM_TABLE))?.projectId).toBeNull();

      const homed = await setProject(CUSTOM_TABLE, PROJECT);
      expect(homed?.projectId).toBe(PROJECT);
      expect((await TableCatalog.listTables({ projectId: PROJECT })).map((t) => t.id)).toEqual([
        CUSTOM_TABLE,
      ]);
      expect((await TableCatalog.listTables({ projectId: 'none' })).map((t) => t.id)).not.toContain(
        CUSTOM_TABLE
      );
      expect((await TableCatalog.listTables({ projectId: 'none' })).map((t) => t.id)).toContain(
        'table-builtin-docs'
      );
      expect((await TableCatalog.listTables()).map((t) => t.id)).toContain(CUSTOM_TABLE);

      const flat = await setProject(CUSTOM_TABLE, null);
      expect(flat?.projectId).toBeNull();
    });

    it('validates the target and writes only a live custom row (null otherwise)', async () => {
      await expect(setProject(CUSTOM_TABLE, PLAIN)).rejects.toMatchObject({ statusCode: 400 });
      await expect(setProject(CUSTOM_TABLE, UNKNOWN)).rejects.toMatchObject({ statusCode: 404 });
      // A built-in or a missing row is null: the domain words that refusal.
      expect(await setProject('table-builtin-docs', PROJECT)).toBeNull();
      expect(await setProject('table-2222222222222-missing11', PROJECT)).toBeNull();
      expect((await TableCatalog.findById('table-builtin-docs'))?.projectId).toBeNull();
    });
  });
});
