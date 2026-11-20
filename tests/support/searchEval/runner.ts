import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Containers, Docs, getDb } from '@snaglet/db';
import { getTablesReaderClient } from '@snaglet/db/db';
import { getErrorMessage } from '@snaglet/shared/utils';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { applyAgentSchema, writeAgentEntries } from '@server/domains/tables/tableAgent';
import { Files } from '@snaglet/db/tables/files';
import { Projects } from '@snaglet/db/tables/projects';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { embedNode } from '@server/services/embedding/EmbeddingOrchestrator';
import { embedFileContent } from '@server/services/embedding/fileContentEmbedding';
import { reconcileProject } from '@server/services/fileIndexing';
import { estimateTokens } from '@server/services/TokenEstimator';
import {
  documents,
  files,
  decisions,
  queries,
  tableRowQueries,
  TABLE_ROW_TABLE_NAME,
} from './fixtures';
import { scoreQuery, summarize, type QueryScore } from './metrics';

export interface SearchEvalReport {
  mode: 'mocked-pipeline' | 'real-embeddings';
  note: string;
  queries: Array<{
    id: string;
    intent: string;
    expected: string[];
    output: string;
    hits: string[];
    score: QueryScore;
  }>;
  summary: ReturnType<typeof summarize>;
  perIntent: Record<string, ReturnType<typeof summarize>>;
}

/** Extract identities in their displayed order; never sort candidates. */
function normalizeNodeId(id: string): string {
  return id.replace(/^[a-z_]+:/, '').replace(/^doc-/, '');
}

type DisplayedPathLookup = readonly string[] | ReadonlyMap<string, string>;

/** Extract identities in their displayed order; never sort or de-duplicate hits. */
export function displayedIds(
  output: string,
  kind: unknown,
  knownPaths: DisplayedPathLookup
): string[] {
  const fixturePaths = Array.isArray(knownPaths)
    ? knownPaths
    : [...(knownPaths as ReadonlyMap<string, string>).values()];
  const pathIdentity = (value: string, basePath?: string): string => {
    const resolved = basePath && !path.isAbsolute(value) ? path.resolve(basePath, value) : value;
    const normalized = resolved.replace(/\\/g, '/');
    // Normalize only known fixture paths; unknown/distractor paths stay in the
    // sequence so they still affect rank and token-cost accounting.
    return (
      fixturePaths.find(
        (candidate) => normalized === candidate || normalized.endsWith(`/${candidate}`)
      ) ?? normalized
    );
  };
  if (kind === 'code') {
    try {
      const parsed = JSON.parse(output) as
        | Array<{ path?: string }>
        | { basePath?: string; files: Array<{ path?: string }> };
      return (Array.isArray(parsed) ? parsed : parsed.files).flatMap((row) =>
        row.path
          ? [pathIdentity(row.path, Array.isArray(parsed) ? undefined : parsed.basePath)]
          : []
      );
    } catch {
      return [];
    }
  }
  if (kind === 'files') {
    try {
      const parsed = JSON.parse(output) as { basePath?: string; files?: Array<{ path?: string }> };
      return (parsed.files ?? []).flatMap((row) =>
        row.path ? [pathIdentity(row.path, parsed.basePath)] : []
      );
    } catch {
      return [];
    }
  }
  if (kind === 'database') {
    // formatQueryRows is pipe-separated. Also accept tab text in the parser
    // contract without splitting a title/snippet on ordinary spaces.
    return output
      .split('\n')
      .slice(2)
      .map((line) => line.split(/\t| \| /)[0])
      .filter(Boolean)
      .map(normalizeNodeId);
  }
  if (kind === 'conversations') {
    try {
      return (
        (
          JSON.parse(output) as { conversations?: Array<{ thread_id?: string }> }
        ).conversations?.flatMap((x) => (x.thread_id ? [x.thread_id] : [])) ?? []
      );
    } catch {
      return [];
    }
  }
  // Workspace file fallback uses filesystem lines rather than node cards.
  if (output.startsWith('Files (')) {
    return [...output.matchAll(/^- (.+?):\d+ · /gm)].map((match) => pathIdentity(match[1]));
  }
  // Workspace cards always begin with the renderer's kind glyph. Restricting
  // parsing to that header avoids counting markdown links inside snippets.
  // A file card has an opaque file-node id, so map it to its seeded relative
  // path when the caller supplied the fixture id -> path lookup.
  const header =
    /^(?:📄|💬|📂|🧠|🧾|🔧|🖼️|✏️|📌|📎)\s+(?:Reply in )?\[[^\]]+\]\((?:doc:)?([^()\s]+)\)/gm;
  return [...output.matchAll(header)].map((match) => {
    const id = match[1];
    return knownPaths instanceof Map
      ? (knownPaths.get(id) ?? normalizeNodeId(id))
      : normalizeNodeId(id);
  });
}

function assertSearchOutput(kind: unknown, output: string, queryId: string): void {
  if (!output.trim())
    throw new Error(`search eval ${queryId} returned an empty ${String(kind)} output`);
  if (
    /^(?:Error|Invalid|Unknown|Access denied|content_range is supported|File search unavailable)/im.test(
      output
    )
  ) {
    throw new Error(`search eval ${queryId} returned a tool error: ${output}`);
  }
  if (kind === 'code') {
    try {
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed) && !Array.isArray(parsed.files))
        throw new Error('missing result array');
    } catch {
      throw new Error(`search eval ${queryId} returned a non-result code response: ${output}`);
    }
  }
  if (kind === 'files' || kind === 'conversations') {
    try {
      const value = JSON.parse(output) as {
        files?: unknown;
        conversations?: unknown;
        error?: unknown;
      };
      const rows = kind === 'files' ? value.files : value.conversations;
      if (value.error || !Array.isArray(rows))
        throw new Error('error response or missing result array');
    } catch {
      throw new Error(
        `search eval ${queryId} returned a non-result ${String(kind)} response: ${output}`
      );
    }
  }
  if (kind === 'database' && /^(?:Error|Invalid|Unknown|Access denied):/im.test(output)) {
    throw new Error(`search eval ${queryId} returned a database error: ${output}`);
  }
}

export async function runSearchEval(
  options: { realEmbeddings?: boolean } = {}
): Promise<SearchEvalReport> {
  const root = await mkdtemp(path.join(tmpdir(), 'snaglet-search-eval-'));
  const created: string[] = [];
  const mockModelId = 'model-search-eval-mock';
  // The custom Database table kind:"database" reads from. Seeded only when a
  // read-only tables-reader connection exists (the jest harness provisions
  // one); dropped in cleanup. Its physical name drives the six `row-*`
  // queries.
  let databaseTable: string | null = null;
  try {
    // The provider override is installed by the Jest entrypoint. Its catalog
    // identity must exist before either ingest or retrieval resolves it.
    if (!options.realEmbeddings) {
      await getDb().query(
        `INSERT INTO public.providers (id, name, type) VALUES ('mock', 'Search eval mock', 'runtime') ON CONFLICT (id) DO NOTHING`
      );
      await getDb().query(
        `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
         VALUES ($1, 'mock', 'mock-embedding', 'Search eval mock', 'embedding', 768)
         ON CONFLICT (provider_id, model_id) DO NOTHING`,
        [mockModelId]
      );
    }
    const container = await Containers.create({ name: `Search eval ${Date.now()}` });
    created.push(container.id);
    for (const [id, title, content] of documents) {
      const doc = await Docs.create({ id: `doc-${id}`, title, content, containerId: container.id });
      created.push(doc.id);
      const result = await embedNode({ nodeId: doc.id, content: `${title}\n${content}` });
      if (!result.ok) throw new Error(`failed to embed ${id}: ${result.error ?? result.skipped}`);
    }
    // kind:"database" reads custom Database tables only (the `user_tables`
    // schema, through the read-only `snaglet_tables_reader` role). Seed the eval
    // docs into a custom table so the six `row-*` queries have a real target:
    // a `doc_id` column holding `doc-<id>` (first in the displayed columns, so
    // displayedIds parses it) and the title as the Name (`name`) column. When
    // no reader connection is configured (e.g. the standalone real-embedding
    // child), skip the database queries with a clear note rather than failing.
    const tablesReader = await getTablesReaderClient();
    if (tablesReader) {
      await applyAgentSchema(TABLE_ROW_TABLE_NAME, {
        fields: [{ name: 'doc_id', type: 'text' }],
      });
      const custom = await TableCatalog.listTables({ origin: 'custom' });
      const seeded = custom.find((row) => row.name === TABLE_ROW_TABLE_NAME);
      if (!seeded) throw new Error('search eval custom table was not registered');
      databaseTable = seeded.tableName;
      await writeAgentEntries(TABLE_ROW_TABLE_NAME, {
        insert: documents.map(([id, title]) => ({
          values: { name: title, doc_id: `doc-${id}` },
        })),
      });
    } else {
      console.warn(
        'Search eval: no snaglet_tables_reader connection; skipping the six kind:"database" queries.'
      );
    }
    const projectContainer = await Containers.create({
      name: `Search eval files ${Date.now()}`,
      category: 'project',
      fileIndexingEnabled: true,
    });
    created.push(projectContainer.id);
    const project = await Projects.create({
      name: `search-eval-${Date.now()}`,
      containerId: projectContainer.id,
      folderPath: root,
    });
    for (const [relativePath, body] of files) {
      const absolute = path.join(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, body);
    }
    await reconcileProject(project);
    for (const file of await Files.listByProject(project.id)) {
      const body = files.find(([relative]) => relative === file.relativePath)?.[1];
      const result = await embedFileContent({ contentHash: file.contentHash, content: body });
      if (!result.ok)
        throw new Error(
          `failed to embed file ${file.relativePath}: ${result.error ?? result.skipped}`
        );
    }
    for (const [id, title, summary] of decisions) {
      const thread = await Threads.create({ id, title });
      created.push(thread.id);
      const summaryId = `summary-${id}`;
      await ThreadSummaries.insertNewVersion({
        id: summaryId,
        threadId: thread.id,
        summaryText: summary,
        messagesCovered: 0,
      });
      created.push(summaryId);
      const result = await embedNode({ nodeId: summaryId, content: `${title}\n${summary}` });
      if (!result.ok) throw new Error(`failed to embed ${id}: ${result.error ?? result.skipped}`);
    }
    const tool = (await import('@server/services/ToolService/tools/workspace/search/tool'))
      .default as (
      input: Record<string, unknown>,
      settings: Record<string, unknown>,
      context: Record<string, unknown>
    ) => Promise<string>;
    const reportQueries: SearchEvalReport['queries'] = [];
    const filePathByNodeId = new Map(
      (await Files.listByProject(project.id)).map((file) => [file.id, file.relativePath])
    );
    // The six kind:"database" queries target the seeded custom table by its
    // physical name; omitted when no tables-reader connection exists.
    const allQueries = databaseTable ? [...queries, ...tableRowQueries(databaseTable)] : queries;
    for (const query of allQueries) {
      const input = { ...query.input, limit: 10 };
      if (input.kind === 'code') Object.assign(input, { path: root });
      if (input.kind === 'files' || (Array.isArray(input.kinds) && input.kinds.includes('file')))
        Object.assign(input, { project_id: project.id, scope_files: 'project' });
      const output = await tool(input, {}, { cwd: root, projectId: project.id });
      assertSearchOutput(input.kind, output, query.id);
      const knownPaths = input.kind === 'workspace' ? filePathByNodeId : files.map(([p]) => p);
      const hits = displayedIds(output, input.kind, knownPaths);
      const score = scoreQuery(
        hits,
        query.expected,
        estimateTokens(output, 'codex', 'gpt-6-astra')
      );
      reportQueries.push({
        id: query.id,
        intent: query.intent,
        expected: [...query.expected],
        output,
        hits,
        score,
      });
    }
    const perIntent = Object.fromEntries(
      [...new Set(reportQueries.map((query) => query.intent))].map((intent) => [
        intent,
        summarize(
          reportQueries.filter((query) => query.intent === intent).map((query) => query.score)
        ),
      ])
    );
    const report: SearchEvalReport = {
      mode: options.realEmbeddings ? 'real-embeddings' : 'mocked-pipeline',
      note: options.realEmbeddings
        ? 'Real embedding opt-in requested.'
        : 'Deterministic hash embeddings: pipeline coverage only, not semantic quality. File queries intentionally exercise grep fallback because production rejects mock providers for vector file retrieval.',
      queries: reportQueries,
      summary: summarize(reportQueries.map((q) => q.score)),
      perIntent,
    };
    // Include raw output for ranking/parser audit; callers may persist this
    // JSON report without reconstructing a result order from database rows.
    console.log(JSON.stringify({ searchQualityEval: report }, null, 2));
    return report;
  } finally {
    if (databaseTable)
      await applyAgentSchema(TABLE_ROW_TABLE_NAME, { ops: [{ op: 'delete_table' }] }).catch(
        (err: unknown) => {
          console.warn('Search eval cleanup failed for database table:', getErrorMessage(err));
        }
      );
    if (created.length)
      await getDb()
        .query('DELETE FROM public.nodes WHERE id = ANY($1::text[])', [created])
        .catch((err: unknown) => {
          console.warn('Search eval cleanup failed for nodes:', getErrorMessage(err));
        });
    if (!options.realEmbeddings) {
      // File embeddings are content-addressed rather than node-owned, so they
      // must be removed before deleting this fixture's model catalog row.
      await getDb()
        .query('DELETE FROM public.file_embeddings WHERE model_id = $1', [mockModelId])
        .catch((err: unknown) => {
          console.warn('Search eval cleanup failed for file embeddings:', getErrorMessage(err));
        });
      await getDb()
        .query('DELETE FROM public.models WHERE id = $1', [mockModelId])
        .catch((err: unknown) => {
          console.warn('Search eval cleanup failed for model:', getErrorMessage(err));
        });
      // `mock` can be a shared test catalog provider. Do not delete it here;
      // only this harness's model row is owned by the disposable fixture.
    }
    await rm(root, { recursive: true, force: true });
  }
}
