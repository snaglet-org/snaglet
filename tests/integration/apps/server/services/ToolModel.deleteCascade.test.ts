/**
 * ToolModel delete/upsert keep the node spine consistent (real DB).
 * `tools.id` has no FK to `nodes.id`, so ToolModel does two things by hand:
 *
 *  1. Tools.delete() removes the `nodes` row (type='tool') with the `tools`
 *     row; otherwise the node, and its `embeddings` row (embeddings.node_id
 *     cascades from nodes.id), would be orphaned.
 *  2. Tools.upsertTool() on conflict (an edit) bumps `nodes.updated_at`;
 *     otherwise EmbeddingWorker's staleness gate (`e.updated_at >=
 *     n.updated_at`) never re-flags a tool whose name or description changed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, closeDatabase } from '@snaglet/db';
import { Tools } from '@snaglet/db/tables/tools';
import { Nodes } from '@snaglet/db/tables/nodes';
import { vectorLiteral } from '@snaglet/shared/utils';

const RUN = Date.now();
const TEST_ID = `integration_test_delete_cascade_tool_${RUN}`;
const PROVIDER_ID = `mocktoolcascade-${RUN}`;
const MODEL_KEY = `emb-${RUN}`;
const MODEL_ID = `model-tool-cascade-it-${RUN}`;

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.embeddings WHERE node_id = $1`, [TEST_ID]);
  await pool.query(`DELETE FROM public.tools WHERE id = $1`, [TEST_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1`, [TEST_ID]);
}

/** Insert a minimal embeddings row directly — this test is about the FK
 * cascade + staleness gate, not the embedding pipeline itself. */
async function insertFakeEmbedding(nodeId: string): Promise<void> {
  const pool = getDb();
  await pool.query(
    `INSERT INTO public.embeddings (id, node_id, model_id, vector, content_hash)
     VALUES ($1, $2, $3, $4::vector, 'fake-hash')`,
    [`${nodeId}-emb`, nodeId, MODEL_ID, vectorLiteral(new Array(768).fill(0.1))]
  );
}

describe('Tools.delete / Tools.upsertTool — node-spine cascade', () => {
  beforeEach(async () => {
    await cleanup();
    const pool = getDb();
    await pool.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Mock Tool Cascade', 'runtime')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Mock Tool Cascade Embedding', 'embedding', 768)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MODEL_ID, PROVIDER_ID, MODEL_KEY]
    );
  });
  afterEach(cleanup);
  afterAll(async () => {
    await closeDatabase();
  });

  it('removes both the tools row and its nodes row', async () => {
    await Tools.upsertTool({ id: TEST_ID, name: 'test-tool', type: 'external' });
    expect(await Tools.findById(TEST_ID)).not.toBeNull();
    expect(await Nodes.getType(TEST_ID)).toBe('tool');

    await Tools.delete(TEST_ID);

    expect(await Tools.findById(TEST_ID)).toBeNull();
    expect(await Nodes.getType(TEST_ID)).toBeNull();
  });

  it('cascade-deletes the embeddings row via the node delete — no orphan', async () => {
    await Tools.upsertTool({ id: TEST_ID, name: 'test-tool', type: 'external' });
    await insertFakeEmbedding(TEST_ID);

    const pool = getDb();
    const before = await pool.query(`SELECT 1 FROM public.embeddings WHERE node_id = $1`, [
      TEST_ID,
    ]);
    expect(before.rowCount).toBe(1);

    await Tools.delete(TEST_ID);

    const after = await pool.query(`SELECT 1 FROM public.embeddings WHERE node_id = $1`, [TEST_ID]);
    expect(after.rowCount).toBe(0);
  });

  it('upsertTool on conflict bumps nodes.updated_at so a changed tool re-flags as stale', async () => {
    await Tools.upsertTool({
      id: TEST_ID,
      name: 'test-tool',
      description: 'old',
      type: 'external',
    });
    await insertFakeEmbedding(TEST_ID);

    const pool = getDb();
    // Mirror EmbeddingWorker.processStaleTool's exact staleness predicate:
    // "not stale" iff an embedding exists with e.updated_at >= n.updated_at.
    const staleQuery = `
      SELECT t.id FROM tools t
      JOIN public.nodes n ON n.id = t.id
      WHERE t.id = $1
        AND NOT EXISTS (
          SELECT 1 FROM public.embeddings e
          WHERE e.node_id = t.id AND e.updated_at >= n.updated_at
        )
    `;
    // Freshly embedded content is not stale.
    expect((await pool.query(staleQuery, [TEST_ID])).rowCount).toBe(0);

    // Force a strictly-later clock tick so the upsert's NOW() is
    // unambiguously after the embedding's `updated_at` even on fast
    // hardware/PostgreSQL's timer resolution.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Edit the tool (the GUI builder's save/deploy path) — description changes.
    await Tools.upsertTool({
      id: TEST_ID,
      name: 'test-tool',
      description: 'new',
      type: 'external',
    });

    // The embedding is now behind the node's updated_at — re-flagged as stale.
    expect((await pool.query(staleQuery, [TEST_ID])).rowCount).toBe(1);
  });
});
