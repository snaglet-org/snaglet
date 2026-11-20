import {
  runOptionalWikipediaRealChild,
  WIKIPEDIA_REAL_TIMEOUT_MS,
} from '../../../../support/searchEval/wikipedia/launchRealChild';
import { afterAll, expect, it, jest } from '@jest/globals';
import { Containers, Docs, getDb } from '@snaglet/db';
import {
  MockEmbeddingProvider,
  resetEmbeddingProvider,
  setEmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { runWikipediaEval } from '../../../../support/searchEval/wikipedia/runner';
jest.mock('@server/services/reranking/reorderByRerank', () => ({
  RERANK_MAX_CANDIDATES: 50,
  reorderByRerank: async <T>(opts: { items: T[] }) => opts.items,
  reorderByRerankScored: async <T>(opts: { items: T[] }) => ({
    items: opts.items,
    scoreById: new Map(),
  }),
}));
afterAll(() => resetEmbeddingProvider());
it('measures keyword36 and mock hybrid36 separately, with attribution, fresh IDs, strict scopes and cleanup', async () => {
  const outside = await Docs.create({
    title: 'Mercury',
    content: 'Mercury planet element bridges pollination sonata',
  });
  try {
    const keywordProvider = new MockEmbeddingProvider(768);
    const embed = jest.spyOn(keywordProvider, 'embed');
    setEmbeddingProvider(keywordProvider);
    const keyword = await runWikipediaEval({ mode: 'keyword-baseline' });
    expect(embed).not.toHaveBeenCalled();
    setEmbeddingProvider(new MockEmbeddingProvider(768));
    const hybrid = await runWikipediaEval({ mode: 'mocked-hybrid-pipeline' });
    for (const report of [keyword, hybrid]) {
      expect(report.queries).toHaveLength(36);
      expect(report.summary.queries).toBe(36);
      expect(Object.keys(report.perCategory)).toHaveLength(6);
      expect(report.seededIds).toHaveLength(12);
      expect(report.queries.every((q) => q.effectiveInput.container_id && q.authoredInput)).toBe(
        true
      );
      expect(
        (
          await getDb().query('SELECT id FROM public.nodes WHERE id = ANY($1::text[])', [
            report.seededIds,
          ])
        ).rows
      ).toEqual([]);
    }
    expect(keyword.seededIds.some((id) => hybrid.seededIds.includes(id))).toBe(false);
    expect(await Docs.findById(outside.id)).toBeTruthy();
  } finally {
    await getDb().query('DELETE FROM public.nodes WHERE id = $1', [outside.id]);
  }
}, 120000);
it('cleans partially seeded hierarchy after injected failure and preserves unrelated sentinel', async () => {
  const sentinel = await Containers.create({ name: 'Wikipedia cleanup sentinel' });
  const owned: string[] = [];
  try {
    await expect(
      runWikipediaEval({
        mode: 'keyword-baseline',
        onCreated: (id) => {
          owned.push(id);
          if (owned.length === 6) throw new Error('injected partial seed failure');
        },
      })
    ).rejects.toThrow('injected partial seed failure');
    expect(owned).toHaveLength(6);
    expect(
      (await getDb().query('SELECT id FROM public.nodes WHERE id = ANY($1::text[])', [owned])).rows
    ).toEqual([]);
    expect(await Containers.findById(sentinel.id)).toBeTruthy();
  } finally {
    await getDb().query('DELETE FROM public.nodes WHERE id = $1', [sentinel.id]);
  }
});
it('surfaces cleanup failures instead of returning a successful report', async () => {
  const db = getDb();
  const original = db.query.bind(db);
  const deletion = jest
    .spyOn(db, 'query')
    .mockImplementation(async (...args: Parameters<typeof db.query>) => {
      const result = await original(...args);
      if (String(args[0]).startsWith('DELETE FROM public.nodes WHERE id = ANY'))
        throw new Error('injected cleanup failure');
      return result;
    });
  try {
    await expect(
      runWikipediaEval({
        onCreated: () => {
          throw new Error('injected seed failure');
        },
      })
    ).rejects.toThrow('injected cleanup failure');
  } finally {
    deletion.mockRestore();
  }
});

it('rejects direct real mode before seeding when opt-in is absent', async () => {
  const previous = process.env.SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS;
  delete process.env.SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS;
  const created: string[] = [];
  try {
    await expect(
      runWikipediaEval({
        mode: 'real-embeddings-hybrid',
        onCreated: (id) => {
          created.push(id);
          throw new Error('unexpected seed');
        },
      })
    ).rejects.toThrow('Unsafe real embedding eval child environment');
    expect(created).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS;
    else process.env.SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS = previous;
  }
});

it(
  'runs a real Wikipedia child only with explicit safe non-CI opt-in',
  async () => {
    const result = await runOptionalWikipediaRealChild();
    if (result) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
  },
  WIKIPEDIA_REAL_TIMEOUT_MS + 30000
);
