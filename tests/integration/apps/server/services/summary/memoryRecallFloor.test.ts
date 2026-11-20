/**
 * Memory-recall floor, end to end on real embeddings.
 *
 * The fixture holds 16 synthetic memories and 6 probe queries embedded with
 * the bundled local embedder (nomic-embed-text-v1.5). onnxruntime cannot run
 * inside jest, so the measured vectors are replayed through the real
 * Memories.hybridSearch on this file's throwaway database, and the real
 * admission rule (selectRecalledMemories) decides what would be injected.
 *
 * Guarantees under test:
 *   - each topical query admits exactly the memories labeled relevant to it,
 *     except the one on-topic memory precision deliberately gives up (+0.083
 *     margin),
 *   - agent prose (the agent's own reply, an inbound status message) admits no
 *     off-topic memory,
 *   - a flat 0.60 vector floor would admit every candidate on the generic turn,
 *     so the fixture keeps discriminating.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Agents, Memories, getDb } from '@snaglet/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import type { MemorySearchResult } from '@snaglet/db/tables/memories';
import { selectRecalledMemories } from '@server/services/summary/memoryRecallFloor';

interface Fixture {
  memories: Array<{ key: string; content: string; relevantTo: string[]; vector: number[] }>;
  queries: Array<{ id: string; text: string; vector: number[] }>;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/memoryRecallFloor.json'), 'utf8')
) as Fixture;

const RUN = Date.now();
const AGENT_ID = `agent-recallfloor-${RUN}`;
const PROVIDER_ID = `recallfloor-provider-${RUN}`;
const MODEL_ID = `model-recallfloor-${RUN}`;
/** Same fetch width as memoryRecallSegment (the floor was calibrated at 10). */
const FETCH_LIMIT = 10;

const memId = (key: string) => `memory-recallfloor-${RUN}-${key}`;

async function candidates(queryId: string): Promise<MemorySearchResult[]> {
  const q = fixture.queries.find((x) => x.id === queryId)!;
  return Memories.hybridSearch(q.vector, q.text, { agentId: AGENT_ID }, { limit: FETCH_LIMIT });
}

const relevantKeys = (queryId: string) =>
  fixture.memories.filter((m) => m.relevantTo.includes(queryId)).map((m) => m.key);

const keys = (rows: MemorySearchResult[]) => rows.map((r) => r.key).sort();

describe('memory-recall floor on measured embeddings', () => {
  beforeAll(async () => {
    const pool = getDb();
    await pool.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'recall floor', 'runtime')`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, 'nomic-recallfloor', 'recall floor', 'embedding', 768)`,
      [MODEL_ID, PROVIDER_ID]
    );
    await Agents.create({ id: AGENT_ID, name: 'recall floor agent' });
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

  it.each(['sourdough', 'tax', 'tomatoes'])(
    '%s: admits exactly its one relevant memory',
    async (queryId) => {
      const admitted = selectRecalledMemories(await candidates(queryId));
      expect(keys(admitted)).toEqual(relevantKeys(queryId).sort());
    }
  );

  it('on-topic: admits only relevant memories, the two strongest of three', async () => {
    const admitted = selectRecalledMemories(await candidates('ontopic'));
    const relevant = relevantKeys('ontopic');
    expect(admitted.length).toBe(2);
    for (const row of admitted) expect(relevant).toContain(row.key);
  });

  it.each(['generic', 'inbound'])('%s turn: admits no off-topic memory', async (queryId) => {
    const admitted = selectRecalledMemories(await candidates(queryId));
    const relevant = relevantKeys(queryId);
    for (const row of admitted) expect(relevant).toContain(row.key);
  });

  it('generic turn (agent-own reply): a flat 0.60 floor would admit every candidate', async () => {
    const rows = await candidates('generic');
    const oldRule = rows.filter((r) => (r.keywordScore ?? 0) > 0 || (r.vectorScore ?? 0) >= 0.6);
    expect(rows.length).toBe(FETCH_LIMIT);
    expect(oldRule.length).toBe(FETCH_LIMIT);
    expect(selectRecalledMemories(rows).length).toBeLessThanOrEqual(1);
  });
});
