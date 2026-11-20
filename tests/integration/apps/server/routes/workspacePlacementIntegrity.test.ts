/**
 * Placement integrity against the real database. `nodes.container_id`
 * references any node and cascades on delete, so a doc, thread or archived
 * container accepted as a parent would hide the placed node or delete it with
 * that "parent". Every model placement write refuses such a parent, so the HTTP
 * routes and workspace_move return a clean 400/404 and leave placement
 * untouched. Threads are never placed: they are scoped by `nodes.project_id`
 * to a live project or are flat, and other targets are refused the same way.
 * Create paths validate up front and write the spine, placement and kind rows
 * in one transaction, so a failed create leaves no orphan `nodes` row.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, Docs, Threads, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import docsRouter from '@server/domains/docs/docs.routes';
import containersRouter from '@server/domains/containers/containers.routes';
import threadsRouter from '@server/domains/threads/threads.routes';
import workspaceMove from '@server/services/ToolService/handlers/workspace/moveNode';

const PREFIX = 'placement-test';
const HOME = `container-${PREFIX}-home`;
const OTHER = `container-${PREFIX}-other`;
const NESTED = `container-${PREFIX}-nested`;
const ARCHIVED = `container-${PREFIX}-archived`;
const PROJECT = `container-${PREFIX}-project`;
const ARCHIVED_PROJECT = `container-${PREFIX}-archived-project`;
const MOVER = `doc-${PREFIX}-mover`;
const DOC_PARENT = `doc-${PREFIX}-parent`;
const THREAD = `thread-${PREFIX}-chat`;

const app = express();
app.use(express.json());
app.use('/api/docs', docsRouter);
app.use('/api/containers', containersRouter);
app.use('/api/threads', threadsRouter);
app.use(errorHandler);

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.nodes WHERE id LIKE $1`, [`%-${PREFIX}-%`]);
}

async function parentOf(id: string): Promise<string | null | undefined> {
  const { rows } = await getDb().query<{ container_id: string | null }>(
    `SELECT container_id FROM public.nodes WHERE id = $1`,
    [id]
  );
  return rows[0]?.container_id;
}

async function projectOf(id: string): Promise<string | null | undefined> {
  const { rows } = await getDb().query<{ project_id: string | null }>(
    `SELECT project_id FROM public.nodes WHERE id = $1`,
    [id]
  );
  return rows[0]?.project_id;
}

async function nodeExists(id: string): Promise<boolean> {
  const { rows } = await getDb().query(`SELECT 1 FROM public.nodes WHERE id = $1`, [id]);
  return rows.length > 0;
}

async function nodeCount(): Promise<number> {
  const { rows } = await getDb().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.nodes`
  );
  return Number(rows[0]?.count ?? 0);
}

describe('placement parent guard', () => {
  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: HOME, name: 'Placement home' });
    await Containers.create({ id: OTHER, name: 'Placement other' });
    await Containers.create({ id: NESTED, name: 'Placement nested', parentId: HOME });
    await Containers.create({ id: ARCHIVED, name: 'Placement archived' });
    await getDb().query(
      `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
      [ARCHIVED]
    );
    await Containers.create({ id: PROJECT, name: 'Placement project', category: 'project' });
    await Containers.create({
      id: ARCHIVED_PROJECT,
      name: 'Placement archived project',
      category: 'project',
    });
    await getDb().query(
      `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
      [ARCHIVED_PROJECT]
    );
    await Docs.create({ id: MOVER, title: 'Mover', containerId: HOME });
    await Docs.create({ id: DOC_PARENT, title: 'Would-be parent', containerId: HOME });
    await Threads.create({ id: THREAD, title: 'Placement chat' });
  });
  afterAll(cleanup);

  it('refuses a doc as the parent at the model layer', async () => {
    await expect(Docs.moveTo(MOVER, DOC_PARENT)).rejects.toMatchObject({ statusCode: 400 });
    expect(await parentOf(MOVER)).toBe(HOME);
  });

  it.each([
    ['a doc', DOC_PARENT, 400, /not a project/],
    ['a plain container', HOME, 400, /not a project/],
    ['an archived project', ARCHIVED_PROJECT, 400, /is archived/],
    ['a missing id', `container-${PREFIX}-missing`, 404, /not found/],
  ])('Threads.setProject refuses %s', async (_label, target, status, message) => {
    await expect(Threads.setProject(THREAD, target)).rejects.toMatchObject({
      statusCode: status,
      message: expect.stringMatching(message),
    });
    expect(await projectOf(THREAD)).toBeNull();
  });

  it('a thread is never placed in a container, even through its create input', async () => {
    await expect(
      Threads.create({ id: `thread-${PREFIX}-placed`, title: 'Placed', containerId: HOME } as never)
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/project_id/) });
    expect(await nodeExists(`thread-${PREFIX}-placed`)).toBe(false);
  });

  it('PATCH /api/threads/:id refuses folder placement and non-project scopes, then scopes to a project', async () => {
    const placed = await request(app).patch(`/api/threads/${THREAD}`).send({ container_id: HOME });
    expect(placed.status).toBe(400);
    expect(placed.body.error.message).toMatch(/project_id/);

    const plain = await request(app).patch(`/api/threads/${THREAD}`).send({ project_id: HOME });
    expect(plain.status).toBe(400);
    expect(plain.body.error.message).toMatch(/not a project/);

    const archived = await request(app)
      .patch(`/api/threads/${THREAD}`)
      .send({ project_id: ARCHIVED_PROJECT });
    expect(archived.status).toBe(400);
    expect(await projectOf(THREAD)).toBeNull();

    const scoped = await request(app).patch(`/api/threads/${THREAD}`).send({ project_id: PROJECT });
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.projectId).toBe(PROJECT);
    expect(await projectOf(THREAD)).toBe(PROJECT);
    expect(await parentOf(THREAD)).toBeNull();

    const flat = await request(app).patch(`/api/threads/${THREAD}`).send({ project_id: null });
    expect(flat.status).toBe(200);
    expect(await projectOf(THREAD)).toBeNull();
  });

  it.each([
    ['a doc', DOC_PARENT, 400, /is a doc, not a container/],
    ['a thread', THREAD, 400, /is a thread, not a container/],
    ['an archived container', ARCHIVED, 400, /is archived/],
    ['a missing id', `container-${PREFIX}-missing`, 404, /not found/],
  ])('PATCH /api/docs/:id into %s is refused', async (_label, target, status, message) => {
    const res = await request(app).patch(`/api/docs/${MOVER}`).send({ containerId: target });
    expect(res.status).toBe(status);
    expect(res.body.error.message).toMatch(message);
    expect(await parentOf(MOVER)).toBe(HOME);
  });

  it('PATCH /api/containers/:id refuses a doc parent and a cycle with a 400', async () => {
    const intoDoc = await request(app)
      .patch(`/api/containers/${OTHER}`)
      .send({ parentId: DOC_PARENT });
    expect(intoDoc.status).toBe(400);
    expect(await parentOf(OTHER)).toBeNull();

    const intoDescendant = await request(app)
      .patch(`/api/containers/${HOME}`)
      .send({ parentId: NESTED });
    expect(intoDescendant.status).toBe(400);
    expect(intoDescendant.body.error.message).toMatch(/its own descendants/);
    expect(await parentOf(HOME)).toBeNull();
  });

  it('workspace_move refuses a doc destination', async () => {
    await expect(workspaceMove({ id: MOVER, new_parent_id: DOC_PARENT }, {}, {})).rejects.toThrow(
      /not a container/
    );
    expect(await parentOf(MOVER)).toBe(HOME);
  });

  it('a rejected move cannot make deleting the would-be parent cascade', async () => {
    const target = `doc-${PREFIX}-disposable`;
    await Docs.create({ id: target, title: 'Disposable', containerId: HOME });
    await request(app).patch(`/api/docs/${MOVER}`).send({ containerId: target }).expect(400);
    await Docs.delete(target);
    expect(await nodeExists(MOVER)).toBe(true);
  });

  it('still moves into a live container', async () => {
    const res = await request(app).patch(`/api/docs/${MOVER}`).send({ containerId: OTHER });
    expect(res.status).toBe(200);
    expect(await parentOf(MOVER)).toBe(OTHER);
    await request(app).patch(`/api/docs/${MOVER}`).send({ containerId: HOME }).expect(200);
  });

  it('validates dueAt before a PATCH moves anything', async () => {
    const res = await request(app)
      .patch(`/api/docs/${MOVER}`)
      .send({ containerId: OTHER, dueAt: 'next tuesday' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/dueAt must be an ISO 8601 date/);
    expect(await parentOf(MOVER)).toBe(HOME);
  });
});

describe('create paths leave no orphan nodes row', () => {
  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: HOME, name: 'Placement home' });
    await Docs.create({ id: DOC_PARENT, title: 'Would-be parent', containerId: HOME });
  });
  afterAll(cleanup);

  it('POST /api/docs with a bad dueAt is a 400 that writes nothing', async () => {
    const before = await nodeCount();
    const res = await request(app)
      .post('/api/docs')
      .send({ title: 'Bad due date', containerId: HOME, dueAt: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/dueAt/);
    expect(await nodeCount()).toBe(before);
  });

  it('Docs.create rejects bad input up front', async () => {
    const id = `doc-${PREFIX}-rejected`;
    await expect(Docs.create({ id, title: 'Rejected', dueAt: '2026-02-30' })).rejects.toMatchObject(
      { statusCode: 400 }
    );
    await expect(
      Docs.create({ id, title: 'Rejected', containerId: DOC_PARENT })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await nodeExists(id)).toBe(false);
  });

  it('Containers.create rejects an unknown category up front', async () => {
    const id = `container-${PREFIX}-rejected`;
    await expect(
      Containers.create({ id, name: 'Rejected', category: 'bogus' as never })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await nodeExists(id)).toBe(false);
  });

  it.each([
    ['doc', () => Docs.create({ id: `doc-${PREFIX}-nul`, title: 'bad\u0000title' })],
    [
      'container',
      () => Containers.create({ id: `container-${PREFIX}-nul`, name: 'bad\u0000name' }),
    ],
    ['thread', () => Threads.create({ id: `thread-${PREFIX}-nul`, title: 'bad\u0000title' })],
  ])('a failed %s insert rolls back its nodes row', async (kind, create) => {
    await expect(create()).rejects.toThrow();
    expect(await nodeExists(`${kind}-${PREFIX}-nul`)).toBe(false);
  });
});
