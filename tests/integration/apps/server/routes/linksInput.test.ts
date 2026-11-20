/**
 * /api/links answers bad input with a 4xx instead of letting it reach
 * PostgreSQL: a malformed page bound falls back to the default (never
 * `LIMIT NaN`), an unknown node is a 404, and an unknown relation, a
 * disallowed (source, relation, target) triple or non-object metadata is a
 * 400. A doc may reference a chat message; a thread may not. Database access
 * is real.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Docs, Links, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import linksRouter from '@server/domains/links/links.routes';

const SOURCE = 'doc-1111111111111-aaaaaaaaa';
const TARGET = 'doc-2222222222222-bbbbbbbbb';
const THREAD = 'thread-1111111111111-aaaaaaaaa';
const MESSAGE = 'message-1111111111111-aaaaaaaaa';

const app = express();
app.use(express.json());
app.use('/api/links', linksRouter);
app.use(errorHandler);

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
    [SOURCE, TARGET, MESSAGE, THREAD],
  ]);
}

/** A thread holding one chat message, on the node spine. */
async function createThreadWithMessage(): Promise<void> {
  const db = getDb();
  await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread'), ($2, 'message')`, [
    THREAD,
    MESSAGE,
  ]);
  await db.query(`INSERT INTO public.threads (id, title) VALUES ($1, 'Test thread')`, [THREAD]);
  await db.query(
    `INSERT INTO public.messages (id, thread_id, role, content) VALUES ($1, $2, 'user', 'Hello')`,
    [MESSAGE, THREAD]
  );
}

describe('/api/links input validation', () => {
  beforeAll(async () => {
    await cleanup();
    await Docs.create({ id: SOURCE, title: 'Link source' });
    await Docs.create({ id: TARGET, title: 'Link target' });
    await Links.upsert({ sourceId: SOURCE, targetId: TARGET, relation: 'references' });
    await createThreadWithMessage();
  });
  afterAll(cleanup);

  it.each([
    ['/api/links?source_id=' + SOURCE + '&limit=abc&offset=xyz'],
    ['/api/links?source_id=' + SOURCE + '&limit=-5&offset=-1'],
    ['/api/links?source_id=' + SOURCE + '&include_types=1&limit=abc&offset=xyz'],
    ['/api/links/node?id=' + SOURCE + '&limit=abc'],
    ['/api/links/backlinks?target_id=' + TARGET + '&limit=abc'],
  ])('a malformed page bound is not a server error: %s', async (url) => {
    const res = await request(app).get(url).expect(200);
    const rows = Array.isArray(res.body.data) ? res.body.data : res.body.data.rows;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('404s a link from a node that does not exist', async () => {
    const res = await request(app)
      .post('/api/links')
      .send({ source_id: 'doc-0000000000000-missing00', target_id: TARGET })
      .expect(404);
    expect(res.body.error.message).toMatch(/source node .* not found/);
  });

  it('400s an unknown relation on create and on update', async () => {
    await request(app)
      .post('/api/links')
      .send({ source_id: SOURCE, target_id: TARGET, relation: 'bogus' })
      .expect(400);
    const link = await Links.upsert({ sourceId: SOURCE, targetId: TARGET, relation: 'references' });
    await request(app).patch(`/api/links/${link.id}`).send({ relation: 'bogus' }).expect(400);
  });

  it('400s a relation the type matrix does not allow between the two nodes', async () => {
    const res = await request(app)
      .post('/api/links')
      .send({ source_id: SOURCE, target_id: TARGET, relation: 'summarizes' })
      .expect(400);
    expect(res.body.error.message).toMatch(/invalid link triple/);
  });

  it('lets a doc reference a chat message, but not a thread', async () => {
    const res = await request(app)
      .post('/api/links')
      .send({ source_id: SOURCE, target_id: MESSAGE, relation: 'references' })
      .expect(201);
    expect(res.body.data).toMatchObject({
      sourceId: SOURCE,
      targetId: MESSAGE,
      relation: 'references',
    });

    const rejected = await request(app)
      .post('/api/links')
      .send({ source_id: THREAD, target_id: MESSAGE, relation: 'references' })
      .expect(400);
    expect(rejected.body.error.message).toMatch(/invalid link triple/);
  });

  it('400s metadata that is not an object', async () => {
    await request(app)
      .post('/api/links')
      .send({ source_id: SOURCE, target_id: TARGET, metadata: 'text' })
      .expect(400);
  });
});
