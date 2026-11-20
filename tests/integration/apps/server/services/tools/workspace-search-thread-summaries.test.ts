/**
 * Per-agent thread summaries are semantic nodes. Ordinary retrieval returns
 * only the current version; an explicit history request may inspect
 * superseded versions.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { closeDatabase, getDb } from '@snaglet/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Threads } from '@snaglet/db/tables/threads';
import {
  resetEmbeddingProvider,
  setEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { searchSemanticWorkspace } from '@server/services/ToolService/handlers/search/workspaceSearch/semantic';

const RUN = Date.now();
const PROVIDER_ID = `thread-summary-provider-${RUN}`;
const MODEL_KEY = `thread-summary-topic-${RUN}`;
const MODEL_ID = `model-thread-summary-${RUN}`;
const THREAD_ID = `thread-summary-search-${RUN}`;
const HISTORICAL_ID = `thread_summary-history-${RUN}`;
const CURRENT_ID = `thread_summary-current-${RUN}`;

function topicVector(): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[17] = 1;
  return vector;
}

const provider: EmbeddingProvider = {
  info: { provider: PROVIDER_ID, model: MODEL_KEY, dimensions: 768 },
  async embedDocument(): Promise<number[]> {
    return topicVector();
  },
  async embedQuery(): Promise<number[]> {
    return topicVector();
  },
};

async function search(includeSupersededThreadSummaries: boolean) {
  return searchSemanticWorkspace({
    query: 'ridge migration decision',
    kinds: ['thread_summary'],
    mode: 'semantic',
    limit: 10,
    allowedContainerIds: null,
    threadId: null,
    graphDepth: 0,
    timeRange: null,
    fileProjectId: null,
    filePathPrefix: null,
    includeSupersededThreadSummaries,
  });
}

describe('semantic retrieval preserves per-agent thread summaries', () => {
  beforeAll(async () => {
    setEmbeddingProvider(provider);
    const pool = getDb();
    await pool.query(
      `INSERT INTO public.providers (id, name, type)
       VALUES ($1, 'Thread Summary Search Test', 'runtime')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Thread Summary Topic', 'embedding', 768)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MODEL_ID, PROVIDER_ID, MODEL_KEY]
    );
    await Threads.create({ id: THREAD_ID, title: `Preserved summary thread ${RUN}` });
    await ThreadSummaries.insertNewVersion({
      id: HISTORICAL_ID,
      threadId: THREAD_ID,
      agentId: null,
      summaryText: 'Historical migration decision at the ridge.',
      messagesCovered: 2,
    });
    await Embeddings.create({
      nodeId: HISTORICAL_ID,
      modelId: MODEL_ID,
      vector: topicVector(),
      contentHash: `historical-${RUN}`,
    });
    await ThreadSummaries.insertNewVersion({
      id: CURRENT_ID,
      threadId: THREAD_ID,
      agentId: null,
      summaryText: 'Current migration decision at the ridge.',
      messagesCovered: 4,
    });
    await Embeddings.create({
      nodeId: CURRENT_ID,
      modelId: MODEL_ID,
      vector: topicVector(),
      contentHash: `current-${RUN}`,
    });
  });

  afterAll(async () => {
    resetEmbeddingProvider();
    const pool = getDb();
    await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
      [HISTORICAL_ID, CURRENT_ID, THREAD_ID],
    ]);
    await pool.query(`DELETE FROM public.models WHERE id = $1`, [MODEL_ID]);
    await pool.query(`DELETE FROM public.providers WHERE id = $1`, [PROVIDER_ID]);
    await closeDatabase();
  });

  it('ordinary retrieval keeps only the current summary version', async () => {
    const hits = await search(false);
    expect(hits.map((hit) => hit.id)).toContain(CURRENT_ID);
    expect(hits.map((hit) => hit.id)).not.toContain(HISTORICAL_ID);
  });

  it('explicit history retrieval may include superseded versions', async () => {
    const hits = await search(true);
    expect(hits.map((hit) => hit.id)).toEqual(expect.arrayContaining([HISTORICAL_ID, CURRENT_ID]));
  });
});
