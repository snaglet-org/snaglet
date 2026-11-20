/**
 * Memories.hybridSearch keyword arm on the measured memory-recall fixture.
 *
 * An all-terms plainto_tsquery keyword arm would match no memory for a natural
 * query, leaving keywordScore 0 on every candidate. With the any-term query
 * (anyTermQueryText → websearch_to_tsquery, rank normalization 32) these must
 * hold on the same vectors:
 *   - every relevant memory gets keyword evidence on its natural query,
 *   - each relevant memory keeps rank 1..n (keyword evidence never pushes an
 *     off-topic memory above a relevant one),
 *   - keyword scores stay in [0, 1),
 *   - deleteByQuery stays all-terms: a one-word overlap deletes nothing.
 * Auto-recall admissions are covered by memoryRecallFloor.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Agents, Memories, getDb } from '@snaglet/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { anyTermQueryText } from '@snaglet/db/tables/memories/anyTermQuery';

interface Fixture {
  memories: Array<{ key: string; content: string; relevantTo: string[]; vector: number[] }>;
  queries: Array<{ id: string; text: string; vector: number[] }>;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/memoryRecallFloor.json'), 'utf8')
) as Fixture;

const RUN = Date.now();
const AGENT_ID = `agent-hybridkw-${RUN}`;
const PROVIDER_ID = `hybridkw-provider-${RUN}`;
const MODEL_ID = `model-hybridkw-${RUN}`;
const memId = (key: string) => `memory-hybridkw-${RUN}-${key}`;

const relevantKeys = (queryId: string) =>
  fixture.memories.filter((m) => m.relevantTo.includes(queryId)).map((m) => m.key);

describe('memory hybrid search keyword arm (any-term)', () => {
  beforeAll(async () => {
    const pool = getDb();
    await pool.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'hybrid kw', 'runtime')`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, 'nomic-hybridkw', 'hybrid kw', 'embedding', 768)`,
      [MODEL_ID, PROVIDER_ID]
    );
    await Agents.create({ id: AGENT_ID, name: 'hybrid keyword agent' });
    for (const m of fixture.memories) {
      await Memories.create({
        id: memId(m.key),
        agentId: AGENT_ID,
        key: m.key,
        content: m.content,
      });
      await Embeddings.create({ nodeId: memId(m.key), modelId: MODEL_ID, vector: m.vector });
    }
  });

  afterAll(async () => {
    const pool = getDb();
    await pool.query(`DELETE FROM public.embeddings WHERE model_id = $1`, [MODEL_ID]);
    await pool.query(`DELETE FROM public.memories WHERE agent_id = $1`, [AGENT_ID]);
    await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
    await pool.query(`DELETE FROM public.models WHERE id = $1`, [MODEL_ID]);
    await pool.query(`DELETE FROM public.providers WHERE id = $1`, [PROVIDER_ID]);
  });

  it.each(fixture.queries.map((q) => q.id))(
    '%s: relevant memories get keyword evidence and keep the top ranks',
    async (queryId) => {
      const q = fixture.queries.find((x) => x.id === queryId)!;
      const rows = await Memories.hybridSearch(
        q.vector,
        q.text,
        { agentId: AGENT_ID },
        { limit: 10 }
      );
      const relevant = relevantKeys(queryId);

      for (const key of relevant) {
        const row = rows.find((r) => r.key === key);
        expect(row?.keywordScore ?? 0).toBeGreaterThan(0);
      }
      expect(
        rows
          .slice(0, relevant.length)
          .map((r) => r.key)
          .sort()
      ).toEqual([...relevant].sort());
      for (const row of rows) {
        expect(row.keywordScore ?? 0).toBeGreaterThanOrEqual(0);
        expect(row.keywordScore ?? 0).toBeLessThan(1);
      }
    }
  );

  it('the any-term text parses to a plain OR of stemmed lexemes (no phrase/negation operators)', async () => {
    const { rows } = await getDb().query<{ q: string }>(
      `SELECT websearch_to_tsquery('english', $1)::text AS q`,
      [anyTermQueryText(`don't re-run the user's cache-breakpoint "test" -now`)]
    );
    expect(rows[0].q).toBe(`'re' | 'run' | 'user' | 'cach' | 'breakpoint' | 'test'`);
  });

  it('deleteByQuery stays all-terms: a single shared word deletes nothing', async () => {
    const deleted = await Memories.deleteByQuery(
      { agentId: AGENT_ID },
      { query: 'sourdough spaceship' }
    );
    expect(deleted).toBe(0);
    const { rows } = await getDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.memories WHERE agent_id = $1`,
      [AGENT_ID]
    );
    expect(Number(rows[0].n)).toBe(fixture.memories.length);
  });
});
