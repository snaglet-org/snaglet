/** Real managed-PostgreSQL coverage: bulk version clearing is not limited to the UI page. */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Docs, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import docsRouter from '@server/domains/docs/docs.routes';

const DOC_A = 'doc-versions-integration-a';
const DOC_B = 'doc-versions-integration-b';
const LIVE_A = 'Current document A — preserve this content.';
const LIVE_B = 'Current document B — preserve this content too.';

async function cleanup() {
  await getDb().query('DELETE FROM public.doc_snapshots WHERE doc_id = ANY($1::text[])', [
    [DOC_A, DOC_B],
  ]);
  await getDb().query('DELETE FROM public.nodes WHERE id = ANY($1::text[])', [[DOC_A, DOC_B]]);
}

const app = express();
app.use(express.json());
app.use('/api/docs', docsRouter);
app.use(errorHandler);

describe('Doc Versions routes against PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await Docs.create({ id: DOC_A, title: 'Versions test A', content: LIVE_A });
    await Docs.create({ id: DOC_B, title: 'Versions test B', content: LIVE_B });
    for (const [id, count] of [
      [DOC_A, 207],
      [DOC_B, 2],
    ] as const) {
      await getDb().query(
        `INSERT INTO public.doc_snapshots (id, doc_id, content, content_bytes, label, reason)
         SELECT $1 || '-version-' || n, $1, 'Historical content', octet_length('Historical content'),
                'Version ' || n, 'manual'
         FROM generate_series(1, $2::int) AS n`,
        [id, count]
      );
    }
  });
  afterAll(cleanup);

  it('reports the total beyond 200, clears only that document, and preserves live content', async () => {
    const listed = await request(app).get(`/api/docs/${DOC_A}/snapshots`).expect(200);
    expect(listed.body.data.count).toBe(207);
    expect(listed.body.data.snapshots).toHaveLength(200);

    const cleared = await request(app).delete(`/api/docs/${DOC_A}/snapshots`).expect(200);
    expect(cleared.body.data).toEqual({ deleted: true, doc_id: DOC_A, deleted_count: 207 });
    const { rows } = await getDb().query<{ doc_id: string; count: number }>(
      `SELECT doc_id, COUNT(*)::int AS count FROM public.doc_snapshots
       WHERE doc_id = ANY($1::text[]) GROUP BY doc_id`,
      [[DOC_A, DOC_B]]
    );
    expect(rows).toEqual([{ doc_id: DOC_B, count: 2 }]);
    expect((await Docs.findById(DOC_A))?.content).toBe(LIVE_A);
    expect((await Docs.findById(DOC_B))?.content).toBe(LIVE_B);
    const empty = await request(app).get(`/api/docs/${DOC_A}/snapshots`).expect(200);
    expect(empty.body.data).toEqual({ doc_id: DOC_A, count: 0, snapshots: [] });
    const repeated = await request(app).delete(`/api/docs/${DOC_A}/snapshots`).expect(200);
    expect(repeated.body.data.deleted_count).toBe(0);
    const untouched = await request(app).get(`/api/docs/${DOC_B}/snapshots`).expect(200);
    expect(untouched.body.data.count).toBe(2);
    expect(untouched.body.data.snapshots).toHaveLength(2);
  });
});
