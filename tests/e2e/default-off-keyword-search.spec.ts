import { expect, test } from '@playwright/test';
import { ScratchServer } from './helpers/scratchServer';

interface PaletteSearchResponse {
  success: true;
  data: {
    byKind: { doc?: Array<{ node_id: string }> };
    channelsUsed: string[];
    semanticStatus: string;
    coverage: { doc?: string };
  };
}

interface CreateDocResponse {
  success: true;
  data: { id: string };
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

test.describe('quiet-by-default local intelligence', () => {
  let server: ScratchServer;

  test.beforeAll(async () => {
    server = await ScratchServer.boot({
      captureLog: true,
      env: {
        // Explicitly override a developer's .env so this scratch process
        // stays deterministic even when local intelligence is turned on there.
        SNAGLET_LOCAL_INTELLIGENCE: 'false',
        RUN_BACKGROUND_WORKERS: 'false',
        LOG_LEVEL: 'info',
      },
    });
    await server.waitForLog(/\[local-intelligence\] disabled by default/);
  });

  test.afterAll(async () => {
    await server?.dispose();
  });

  test('boots without automatic inference and preserves real keyword retrieval', async () => {
    const uniqueKeyword = 'quietlookupzqx';
    const created = await postJson<CreateDocResponse>(`${server.api}/docs`, {
      title: `Quiet lookup ${uniqueKeyword}`,
      content: 'Exact keyword search remains available without automatic local inference.',
    });
    const docId = created.data.id;

    const search = await postJson<PaletteSearchResponse>(`${server.api}/search/palette`, {
      query: uniqueKeyword,
      kinds: ['doc'],
      mode: 'keyword',
      perKindLimit: 6,
    });

    expect(search.data.byKind.doc?.map((hit) => hit.node_id)).toContain(docId);
    expect(search.data.channelsUsed).toContain('fts');
    expect(search.data.channelsUsed).not.toContain('vector');
    expect(search.data.semanticStatus).toBe('disabled');
    expect(search.data.coverage.doc).toBe('lexical');

    for (const table of ['embeddings', 'thread_summaries'] as const) {
      const [count] = await server.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM public.${table}`
      );
      expect(count?.total, `${table} should remain empty`).toBe(0);
    }

    const logs = server.logTail();
    expect(logs).toContain('[local-intelligence] disabled by default');
    expect(logs).not.toContain('local model missing — downloading');
    expect(logs).not.toContain('[embedder:fetch]');
    expect(logs).not.toContain('startup backfill —');
    expect(logs).not.toContain('thread-summary backfill:');
  });
});
