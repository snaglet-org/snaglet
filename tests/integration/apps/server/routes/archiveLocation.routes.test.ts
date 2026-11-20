/**
 * GET /api/archive labels an archived root whose parent is still active with
 * that parent's location (its name and its ancestors', outermost first), so
 * the drawer can say and search where the item was. Against real PostgreSQL.
 */
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, Docs, getDb } from '@snaglet/db';
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

import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField } from '@server/domains/tables/tableFields';
import { archiveTable, archiveTableField } from '@server/domains/tables/tableLifecycle';
import { loadNodeLocations } from '@server/services/ArchiveService';
import archiveRouter from '@server/routes/archive';
import { errorHandler } from '@server/middleware/errorHandler';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const PROJECT = 'container-3333333333333-aaaaaaaaa';
const FOLDER = 'container-3333333333333-bbbbbbbbb';
const OLD_FOLDER = 'container-3333333333333-ccccccccc';
const DOC_IN_FOLDER = 'doc-3333333333333-aaaaaaaaa';
const DOC_IN_OLD_FOLDER = 'doc-3333333333333-bbbbbbbbb';
const PROJECT_TABLE = 'table-3333333333333-aaaaaaaaa';
const LOOSE_TABLE = 'table-3333333333333-bbbbbbbbb';
const LIVE_TABLE = 'table-3333333333333-ccccccccc';
const LIVE_TABLE_FIELD = 'field-3333333333333-aaaaaaaaa';

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

const app = express()
  .use(express.json())
  .use((_req, _res, next) => runWithActor(USER, () => next()))
  .use('/api/archive', archiveRouter)
  .use(errorHandler);

interface ArchiveRow {
  id: string;
  location?: string[];
}

async function archiveNodes(ids: string[]): Promise<void> {
  await getDb().query(
    `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = ANY($1::text[])`,
    [ids]
  );
}

beforeAll(async () => {
  // Test project › docs (both active) holds an archived doc; an archived
  // folder in the project took its doc along.
  await Containers.create({ id: PROJECT, name: 'Test project', category: 'project' });
  await Containers.create({ id: FOLDER, name: 'docs', parentId: PROJECT });
  await Containers.create({ id: OLD_FOLDER, name: 'old drafts', parentId: PROJECT });
  await as(() => Docs.create({ id: DOC_IN_FOLDER, title: 'Release notes', containerId: FOLDER }));
  await as(() =>
    Docs.create({ id: DOC_IN_OLD_FOLDER, title: 'First draft', containerId: OLD_FOLDER })
  );
  await archiveNodes([DOC_IN_FOLDER, OLD_FOLDER, DOC_IN_OLD_FOLDER]);

  await as(() => createTable({ id: PROJECT_TABLE, name: 'segments', projectId: PROJECT }));
  await as(() => createTable({ id: LOOSE_TABLE, name: 'loose_notes', projectId: null }));
  await as(() => createTable({ id: LIVE_TABLE, name: 'guests', projectId: PROJECT }));
  await as(() =>
    createTableField(LIVE_TABLE, {
      id: LIVE_TABLE_FIELD,
      name: 'runtime',
      description: null,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
    })
  );
  await as(() => archiveTable(PROJECT_TABLE));
  await as(() => archiveTable(LOOSE_TABLE));
  await as(() => archiveTableField(LIVE_TABLE, LIVE_TABLE_FIELD));
});

async function listing(): Promise<{ roots: ArchiveRow[]; children: ArchiveRow[] }> {
  const res = await request(app).get('/api/archive').expect(200);
  return res.body.data as { roots: ArchiveRow[]; children: ArchiveRow[] };
}

const byId = (rows: ArchiveRow[], id: string) => rows.find((row) => row.id === id);

describe('GET /api/archive locations', () => {
  it('gives a root in an active folder the folder path, outermost first', async () => {
    const { roots } = await listing();
    expect(byId(roots, DOC_IN_FOLDER)?.location).toEqual(['Test project', 'docs']);
    expect(byId(roots, OLD_FOLDER)?.location).toEqual(['Test project']);
  });

  it('gives an archived table in an active project and a column of an active table the project', async () => {
    const { roots } = await listing();
    expect(byId(roots, PROJECT_TABLE)?.location).toEqual(['Test project']);
    expect(byId(roots, LIVE_TABLE_FIELD)?.location).toEqual(['Test project']);
  });

  it('leaves the location off children and items with no parent', async () => {
    const { roots, children } = await listing();
    const child = byId(children, DOC_IN_OLD_FOLDER);
    expect(child).toBeDefined();
    expect(child).not.toHaveProperty('location');
    expect(byId(roots, LOOSE_TABLE)).not.toHaveProperty('location');
  });
});

describe('loadNodeLocations', () => {
  const LOOP_A = 'container-6666666666666-aaaaaaaaa';
  const LOOP_B = 'container-6666666666666-bbbbbbbbb';

  it('stops when the walk up comes back to a node it has visited', async () => {
    await Containers.create({ id: LOOP_A, name: 'Loop A' });
    await Containers.create({ id: LOOP_B, name: 'Loop B', parentId: LOOP_A });
    // Only a malformed tree has a cycle; the guard trigger has to be off to make one.
    await getDb().query('ALTER TABLE public.nodes DISABLE TRIGGER USER');
    try {
      await getDb().query('UPDATE public.nodes SET container_id = $2 WHERE id = $1', [
        LOOP_A,
        LOOP_B,
      ]);
      const locations = await loadNodeLocations([LOOP_A]);
      expect(locations.get(LOOP_A)).toEqual(['Loop B', 'Loop A']);
      await getDb().query('UPDATE public.nodes SET container_id = NULL WHERE id = $1', [LOOP_A]);
    } finally {
      await getDb().query('ALTER TABLE public.nodes ENABLE TRIGGER USER');
    }
  });
});
