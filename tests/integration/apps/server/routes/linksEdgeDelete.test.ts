/**
 * DELETE /api/links/edge removes a link by (source, target, relation). It must
 * be registered before DELETE /api/links/:id, which would otherwise capture
 * "edge" as a link id and answer 404.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Docs, Links, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import linksRouter from '@server/domains/links/links.routes';

const SOURCE = 'doc-links-edge-test-source';
const TARGET = 'doc-links-edge-test-target';

const app = express();
app.use(express.json());
app.use('/api/links', linksRouter);
app.use(errorHandler);

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [[SOURCE, TARGET]]);
}

async function linkCount(): Promise<number> {
  const { rows } = await getDb().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.links
      WHERE source_id = $1 AND target_id = $2 AND relation = 'references'`,
    [SOURCE, TARGET]
  );
  return Number(rows[0]?.count ?? 0);
}

describe('DELETE /api/links/edge', () => {
  beforeAll(async () => {
    await cleanup();
    await Docs.create({ id: SOURCE, title: 'Edge source' });
    await Docs.create({ id: TARGET, title: 'Edge target' });
  });
  afterAll(cleanup);

  it('deletes the matching link instead of routing "edge" to DELETE /:id', async () => {
    await Links.upsert({ sourceId: SOURCE, targetId: TARGET, relation: 'references' });
    expect(await linkCount()).toBe(1);

    const res = await request(app)
      .delete('/api/links/edge')
      .send({ source_id: SOURCE, target_id: TARGET, relation: 'references' })
      .expect(200);

    expect(res.body.data).toEqual({ deleted: true });
    expect(await linkCount()).toBe(0);
  });

  it('reports deleted: false when no link matches', async () => {
    const res = await request(app)
      .delete('/api/links/edge')
      .send({ source_id: SOURCE, target_id: TARGET, relation: 'references' })
      .expect(200);
    expect(res.body.data).toEqual({ deleted: false });
  });

  it('requires source_id, target_id, and relation', async () => {
    const res = await request(app)
      .delete('/api/links/edge')
      .send({ source_id: SOURCE })
      .expect(400);
    expect(res.body.error.message).toMatch(/source_id, target_id, and relation are required/);
  });

  it('still deletes a link by id', async () => {
    const link = await Links.upsert({ sourceId: SOURCE, targetId: TARGET, relation: 'references' });
    await request(app).delete(`/api/links/${link.id}`).expect(200);
    expect(await linkCount()).toBe(0);
  });
});
