/**
 * Search-quality evaluation harness — pipeline integration, not a semantic
 * benchmark.  The deterministic hash embedding provider proves the complete
 * ingest → retrieval → rendering path without downloading a model or calling
 * a paid endpoint.  Its scores must never be interpreted as semantic quality.
 */
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { harderFiles, harderQueries } from '../../../../support/searchEval/harderPaths';
import { scoreQuery, summarize } from '../../../../support/searchEval/metrics';
import { estimateTokens } from '@server/services/TokenEstimator';
import { getDbClient } from '@snaglet/db/db';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  MockEmbeddingProvider,
  resetEmbeddingProvider,
  setEmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { loadTestClusterHandoff } from '../../../../support/pgTestCluster';

// kind:"database" eval queries read a custom Database table as the read-only
// `snaglet_tables_reader` role. Set its connection URL before the first
// `getDbClient()` opens the app pool (same ordering as databaseSearch.test.ts),
// and provision the role in beforeAll. The password is derived from the test
// cluster's run token.
const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const readerPassword = createHash('sha256')
  .update(`${TABLES_READER_ROLE}:${handoff.runToken}`)
  .digest('base64url');
{
  const url = new URL('postgresql://localhost');
  url.username = TABLES_READER_ROLE;
  url.password = readerPassword;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_TABLES_READER_URL = url.toString();
}

// The evaluation measures the order displayed by the canonical tool.  Keep
// reranking out of that measurement: its ONNX model is external to this
// disposable-db harness and identity preserves the real lexical/vector order.
jest.mock('@server/services/reranking/reorderByRerank', () => ({
  RERANK_MAX_CANDIDATES: 50,
  reorderByRerank: async <T>(opts: { items: T[] }) => opts.items,
  reorderByRerankScored: async <T>(opts: { items: T[] }) => ({
    items: opts.items,
    scoreById: new Map<string, number>(),
  }),
}));

let runSearchEval: (options?: { realEmbeddings?: boolean }) => Promise<{
  mode: 'mocked-pipeline' | 'real-embeddings';
  queries: Array<{ id: string; intent: string; score: { hits: number } }>;
  summary: { queries: number };
}>;
let displayedIds: (output: string, kind: unknown, knownPaths: readonly string[]) => string[];

const execFileAsync = promisify(execFile);
const rgAvailable = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
if (!rgAvailable)
  console.warn(
    'SKIP rg-present evaluation: ripgrep is not on PATH; fallback evaluation still runs.'
  );
const backendCases = rgAvailable ? ['rg', 'fallback'] : ['fallback'];
const originalPath = process.env.PATH;
const REAL_EVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Save a report in SNAGLET_SEARCH_EVAL_ARTIFACT_DIR (created if missing) when it is set. */
async function saveArtifact(name: string, report: unknown): Promise<void> {
  const dir = process.env.SNAGLET_SEARCH_EVAL_ARTIFACT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), JSON.stringify(report, null, 2));
}

/** Run real inference outside Jest so mocks and teardown cannot leak into ONNX. */
async function runRealEmbeddingChild(): Promise<void> {
  const child = path.resolve(process.cwd(), 'tests/support/searchEval/realEmbeddingChild.ts');
  try {
    const result = await execFileAsync(
      process.execPath,
      [path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), child],
      {
        cwd: process.cwd(),
        env: { ...process.env, SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS: '1' },
        timeout: REAL_EVAL_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    // Preserve the complete raw report for ranking/parser audit.
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
    const output = [failure.stdout, failure.stderr].filter(Boolean).join('\\n');
    throw new Error(
      `Real search-quality evaluation child failed${failure.code ? ` (${failure.code})` : ''}.\\n${output || failure.message}`,
      { cause: error }
    );
  }
}

beforeAll(async () => {
  // Provision the read-only tables reader so the kind:"database" eval queries
  // can read the runner's seeded custom table.
  await provisionTablesReaderRole(await getDbClient(), {
    password: readerPassword,
    database,
    revokePublic: true,
  });
  // Import only after the reranker mock is registered. The reusable runner has
  // no Jest dependency and dynamically imports the canonical tool itself.
  ({ runSearchEval, displayedIds } = await import('../../../../support/searchEval/runner'));
  setEmbeddingProvider(new MockEmbeddingProvider(768));
});

afterAll(() => {
  resetEmbeddingProvider();
});

describe('workspace search quality evaluation (mocked pipeline)', () => {
  it('parses each tool-specific displayed-result shape without reordering it', () => {
    expect(
      displayedIds(
        'Files (1) — matchedOn: grep · indexed: false\n- /tmp/src/fileIndexer.ts:1 · content · score 1.0000',
        'workspace',
        ['src/fileIndexer.ts']
      )
    ).toEqual(['src/fileIndexer.ts']);
    expect(
      displayedIds(
        JSON.stringify([
          { path: '/tmp/src/retryPolicy.ts' },
          { path: '/tmp/distractor.ts' },
          { path: '/tmp/src/calendar.ts' },
        ]),
        'code',
        ['src/retryPolicy.ts', 'src/calendar.ts']
      )
    ).toEqual(['src/retryPolicy.ts', '/tmp/distractor.ts', 'src/calendar.ts']);
    expect(
      displayedIds(
        JSON.stringify({
          basePath: '/tmp/project',
          files: [
            { path: 'src/calendar.ts' },
            { path: '/other/distractor.ts' },
            { path: 'src/retryPolicy.ts' },
          ],
        }),
        'code',
        ['src/retryPolicy.ts', 'src/calendar.ts']
      )
    ).toEqual(['src/calendar.ts', '/other/distractor.ts', 'src/retryPolicy.ts']);
    expect(
      displayedIds(
        JSON.stringify({
          conversations: [{ thread_id: 'retry-decision' }, { thread_id: 'release-decision' }],
        }),
        'conversations',
        []
      )
    ).toEqual(['retry-decision', 'release-decision']);
    expect(
      displayedIds(
        'id | title\n---+------\ndoc-retry | Retry policy\ndoc-deployment | Deployment checklist',
        'database',
        []
      )
    ).toEqual(['retry', 'deployment']);
    expect(
      displayedIds('📄 [Retry policy](doc:doc-retry)\n[src/retryPolicy.ts] snippet', 'workspace', [
        'src/retryPolicy.ts',
      ])
    ).toEqual(['retry']);
  });

  it('reconstructs rooted distractor identities without collapsing distinct projects', () => {
    for (const kind of ['code', 'files']) {
      for (const root of ['/tmp/project-a', '/tmp/project-b']) {
        expect(
          displayedIds(
            JSON.stringify({
              basePath: root,
              files: [{ path: 'src/unknown.ts' }, { path: '/outside/unknown.ts' }],
            }),
            kind,
            []
          )
        ).toEqual([`${root}/src/unknown.ts`, '/outside/unknown.ts']);
      }
      expect(
        displayedIds(
          JSON.stringify({ basePath: '/tmp/project-b', files: [{ path: 'src/shared.ts' }] }),
          kind,
          ['/tmp/project-a/src/shared.ts', '/tmp/project-b/src/shared.ts']
        )
      ).toEqual(['/tmp/project-b/src/shared.ts']);
    }
  });

  it.each(backendCases)('measures harder paths with %s backend', async (backend) => {
    if (backend === 'fallback') process.env.PATH = '/nonexistent-snaglet-eval-path';
    const root = await mkdtemp(path.join(tmpdir(), 'snaglet-hard-paths-'));
    try {
      for (const file of harderFiles) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), `// ${file}\n`);
      }
      const tool = (await import('@server/services/ToolService/tools/workspace/search/tool'))
        .default;
      const queries = [];
      for (const query of harderQueries) {
        const output = await tool(
          { kind: 'code', code_mode: 'name', query: query.query, path: root, limit: 10 },
          {},
          { cwd: root }
        );
        const hits = displayedIds(output, 'code', harderFiles);
        queries.push({
          ...query,
          output,
          hits,
          score: scoreQuery(
            hits,
            [...query.expected],
            estimateTokens(output, 'codex', 'gpt-6-astra')
          ),
        });
      }
      const report = {
        mode: backend,
        queries,
        summary: summarize(queries.map((q) => q.score)),
      };
      console.log(JSON.stringify({ harderPathEval: report }, null, 2));
      await saveArtifact(`harder-${backend}.json`, report);
      expect(queries).toHaveLength(8);
      expect(queries.find((q) => q.id === 'exact-path')?.hits[0]).toBe('src/auth/session.ts');
      expect(queries.find((q) => q.id === 'path-suffix')?.hits.slice(0, 2)).toEqual(
        expect.arrayContaining(['src/auth/session.ts', 'src/legacy/auth/session.ts'])
      );
      expect(queries.find((q) => q.id === 'camel-exact')?.hits[0]).toBe(
        'src/security/refreshToken.ts'
      );
      expect(queries.find((q) => q.id === 'snake-exact')?.hits[0]).toBe(
        'src/security/refresh_token.ts'
      );
      expect(queries.find((q) => q.id === 'stem-v-directory')?.hits.slice(0, 3)).toEqual(
        expect.arrayContaining([
          'src/auth/session.ts',
          'src/legacy/auth/session.ts',
          'src/billing/session.ts',
        ])
      );
      expect(queries.find((q) => q.id === 'prefix-v-substring')?.hits.slice(0, 4)).toEqual(
        expect.arrayContaining([
          'src/security/refreshToken.ts',
          'src/security/refresh_token.ts',
          'src/security/refreshTokenCache.ts',
          'src/security/refresh_token_cache.ts',
        ])
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(backendCases)('seeds original thirty with %s backend', async (backend) => {
    try {
      if (backend === 'fallback') process.env.PATH = '/nonexistent-snaglet-eval-path';
      const report = await runSearchEval();
      expect(report.summary.queries).toBe(30);
      expect(report.queries).toHaveLength(30);
      await saveArtifact(`original-${backend}.json`, report);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it(
    'runs the real local ONNX evaluation only when explicitly opted in',
    async () => {
      if (process.env.SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS !== '1') return;
      await runRealEmbeddingChild();
    },
    REAL_EVAL_TIMEOUT_MS + 30_000
  );
});
