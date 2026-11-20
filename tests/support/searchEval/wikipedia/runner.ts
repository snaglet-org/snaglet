import { createHash, randomUUID } from 'node:crypto';
import { Containers, Docs, getDb } from '@snaglet/db';
import { embedNode } from '@server/services/embedding/EmbeddingOrchestrator';
import { estimateTokens } from '@server/services/TokenEstimator';
import { assertSafeRealEmbeddingChildEnv } from '../safety';
import { scoreQuery, summarize } from '../metrics';
import {
  loadWikipediaFixtures,
  effectiveWikipediaInput,
  wikipediaDocumentBody,
  parseWikipediaOutput,
  assertWikipediaScope,
  type WikipediaMode,
} from './contract';

export async function runWikipediaEval(
  options: { mode?: WikipediaMode; onCreated?: (id: string) => void } = {}
) {
  const mode = options.mode ?? 'keyword-baseline';
  if (mode === 'real-embeddings-hybrid') assertSafeRealEmbeddingChildEnv(process.env);
  const { corpus, queries } = loadWikipediaFixtures();
  const created: string[] = [];
  const modelId = `wikipedia-model-${randomUUID()}`;
  let ownedModel = false;
  let ownedProvider = false;
  const track = (id: string) => {
    created.push(id);
    options.onCreated?.(id);
  };
  try {
    if (mode === 'mocked-hybrid-pipeline') {
      ownedProvider =
        (
          await getDb().query(
            "INSERT INTO public.providers (id, name, type) VALUES ('mock', 'Wikipedia eval mock', 'runtime') ON CONFLICT (id) DO NOTHING RETURNING id"
          )
        ).rows.length > 0;
      ownedModel =
        (
          await getDb().query(
            "INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions) VALUES ($1, 'mock', 'mock-embedding', 'Wikipedia eval mock', 'embedding', 768) ON CONFLICT (provider_id, model_id) DO NOTHING RETURNING id",
            [modelId]
          )
        ).rows.length > 0;
    }
    const parent = await Containers.create({
      name: corpus.containerPlan.title,
      fileIndexingEnabled: false,
    });
    track(parent.id);
    const projectIds = new Map<string, string>();
    for (const project of corpus.projects) {
      const row = await Containers.create({
        name: project.title,
        parentId: parent.id,
        category: 'project',
        fileIndexingEnabled: false,
      });
      track(row.id);
      projectIds.set(project.key, row.id);
    }
    const ids = new Map<string, string>();
    const projects = new Map<string, string>();
    for (const fixture of corpus.documents) {
      const content = wikipediaDocumentBody(fixture);
      const doc = await Docs.create({
        id: `doc-${randomUUID()}`,
        title: fixture.title,
        content,
        containerId: projectIds.get(fixture.projectKey)!,
      });
      track(doc.id);
      ids.set(doc.id.replace(/^doc-/, ''), fixture.key);
      projects.set(fixture.key, fixture.projectKey);
      if (mode !== 'keyword-baseline') {
        const result = await embedNode({ nodeId: doc.id, content: `${fixture.title}\n${content}` });
        if (!result.ok)
          throw new Error(`Embedding failed for ${fixture.key}: ${result.error ?? result.skipped}`);
      }
    }
    const tool = (await import('@server/services/ToolService/tools/workspace/search/tool')).default;
    const results = [];
    for (const query of queries) {
      const effectiveInput = effectiveWikipediaInput(query, mode, {
        parentId: parent.id,
        projectIds,
      });
      const output = await tool(effectiveInput, {}, {});
      const hits = parseWikipediaOutput(output, ids);
      assertWikipediaScope(hits, query.scope?.projectKey, projects);
      results.push({
        ...query,
        authoredInput: query.input,
        effectiveInput,
        output,
        hits,
        score: scoreQuery(hits, query.expected, estimateTokens(output, 'codex', 'gpt-6-astra')),
      });
    }
    const report = {
      mode,
      note:
        mode === 'mocked-hybrid-pipeline'
          ? 'Deterministic hash embeddings: pipeline coverage only, NOT semantic quality.'
          : mode === 'keyword-baseline'
            ? 'Lexical keyword baseline; no embeddings.'
            : 'Real embedding opt-in.',
      corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
      queriesSha256: createHash('sha256').update(JSON.stringify(queries)).digest('hex'),
      seededIds: [...created],
      queries: results,
      summary: summarize(results.map((q) => q.score)),
      perCategory: Object.fromEntries(
        [...new Set(results.map((q) => q.category))].map((category) => [
          category,
          summarize(results.filter((q) => q.category === category).map((q) => q.score)),
        ])
      ),
    };
    console.log(JSON.stringify({ wikipediaSearchEval: report }));
    return report;
  } finally {
    // Never swallow cleanup failures; only delete identities created by this run.
    if (created.length)
      await getDb().query('DELETE FROM public.nodes WHERE id = ANY($1::text[])', [created]);
    if (ownedModel) await getDb().query('DELETE FROM public.models WHERE id = $1', [modelId]);
    if (ownedProvider) await getDb().query("DELETE FROM public.providers WHERE id = 'mock'");
  }
}
