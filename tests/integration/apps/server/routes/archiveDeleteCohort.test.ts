/**
 * DELETE /api/archive/:id re-lists the threads its delete takes under lock,
 * like DELETE /api/containers/:id. Against real PostgreSQL: the locked
 * cohort must match the preflight read for an archived project (so the
 * delete goes through), and a thread scoped into the project after that
 * read aborts the delete with nothing removed.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, getDb } from '@snaglet/db';
import { Threads } from '@snaglet/db/tables/threads';

jest.mock('@server/realtime/surfaces/tree', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/tree'),
  emitTreeNodeArchived: jest.fn(),
  emitTreeNodeDeleted: jest.fn(),
}));
jest.mock('@server/realtime/surfaces/threads', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/threads'),
  emitThreadDeleted: jest.fn(),
  emitThreadUpdated: jest.fn(),
}));

const mockListThreadIdsInNodeSubtree = jest.fn<(id: string) => Promise<string[]>>();
jest.mock('@server/services/ThreadExecutionPurgeService', () => {
  const actual = jest.requireActual<typeof import('@server/services/ThreadExecutionPurgeService')>(
    '@server/services/ThreadExecutionPurgeService'
  );
  mockListThreadIdsInNodeSubtree.mockImplementation(actual.listThreadIdsInNodeSubtree);
  return {
    ...actual,
    listThreadIdsInNodeSubtree: (id: string) => mockListThreadIdsInNodeSubtree(id),
  };
});

import archiveRouter from '@server/routes/archive';
import { errorHandler } from '@server/middleware/errorHandler';

const PROJECT = 'container-archive-cohort-test';
const THREAD = 'thread-archive-cohort-test';

const app = express().use(express.json()).use('/api/archive', archiveRouter).use(errorHandler);

async function nodeExists(id: string): Promise<boolean> {
  const { rows } = await getDb().query(`SELECT 1 FROM public.nodes WHERE id = $1`, [id]);
  return rows.length > 0;
}

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [[THREAD, PROJECT]]);
}

async function seedArchivedProjectWithThread(): Promise<void> {
  await cleanup();
  await Containers.create({ id: PROJECT, name: 'Archived project', category: 'project' });
  await Threads.create({ id: THREAD, title: 'Thread in the project', projectId: PROJECT });
  await getDb().query(
    `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
    [PROJECT]
  );
}

describe('DELETE /api/archive/:id thread cohort', () => {
  beforeEach(seedArchivedProjectWithThread);
  afterAll(cleanup);

  it('deletes an archived project and the thread scoped to it', async () => {
    const res = await request(app).delete(`/api/archive/${PROJECT}`).expect(200);
    expect(res.body.data).toMatchObject({ id: PROJECT, deleted: 1 });
    expect(await nodeExists(PROJECT)).toBe(false);
    expect(await nodeExists(THREAD)).toBe(false);
  });

  it('refuses with 409 and deletes nothing when the preflight missed a thread', async () => {
    // A stale preflight: the thread joined the project after it was read.
    mockListThreadIdsInNodeSubtree.mockResolvedValueOnce([]);
    await request(app).delete(`/api/archive/${PROJECT}`).expect(409);
    expect(await nodeExists(PROJECT)).toBe(true);
    expect(await nodeExists(THREAD)).toBe(true);
  });
});
