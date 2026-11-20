import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import {
  createFreshSearchCaseDatabase,
  type FreshSearchCaseDatabase,
} from './support/freshSearchCaseDatabase';

const SENTINEL_ID = 'search-case-isolation-sentinel';
const seenDatabaseNames = new Set<string>();

interface SearchCorpusCounts {
  nodes: number;
  containers: number;
  docs: number;
  files: number;
  images: number;
  memories: number;
  messages: number;
  threadSummaries: number;
  threads: number;
  migrations: number;
  users: number;
}

let searchCase: FreshSearchCaseDatabase | undefined;

async function readCounts(): Promise<SearchCorpusCounts> {
  const result = await getDb().query<SearchCorpusCounts>(
    `SELECT
       (SELECT COUNT(*) FROM public.nodes) AS nodes,
       (SELECT COUNT(*) FROM public.containers) AS containers,
       (SELECT COUNT(*) FROM public.docs) AS docs,
       (SELECT COUNT(*) FROM public.files) AS files,
       (SELECT COUNT(*) FROM public.images) AS images,
       (SELECT COUNT(*) FROM public.memories) AS memories,
       (SELECT COUNT(*) FROM public.messages) AS messages,
       (SELECT COUNT(*) FROM public.thread_summaries) AS "threadSummaries",
       (SELECT COUNT(*) FROM public.threads) AS threads,
       (SELECT COUNT(*) FROM public._migrations) AS migrations,
       (SELECT COUNT(*) FROM public.users) AS users`
  );
  const counts = result.rows[0];
  if (!counts) throw new Error('Clean search-case count query returned no row');
  return counts;
}

async function expectCleanMigratedCase(): Promise<void> {
  if (!searchCase) throw new Error('Search-case database was not created');
  const db = getDb();
  const identity = await db.query<{ databaseName: string }>(
    `SELECT current_database() AS "databaseName"`
  );
  expect(identity.rows[0]?.databaseName).toBe(searchCase.databaseName);
  expect(searchCase.databaseName).toMatch(/^test_search_case_/);
  expect(seenDatabaseNames.has(searchCase.databaseName)).toBe(false);
  seenDatabaseNames.add(searchCase.databaseName);

  const counts = await readCounts();
  expect(counts).toMatchObject({
    nodes: 0,
    containers: 0,
    docs: 0,
    files: 0,
    images: 0,
    memories: 0,
    messages: 0,
    threadSummaries: 0,
    threads: 0,
    users: 1,
  });
  expect(counts.migrations).toBeGreaterThan(0);
}

beforeEach(async () => {
  searchCase = await createFreshSearchCaseDatabase();
});

afterEach(async () => {
  await searchCase?.dispose();
  searchCase = undefined;
});

describe('fresh search-case PostgreSQL isolation', () => {
  it('starts a migrated empty workspace and accepts source-level writes', async () => {
    await expectCleanMigratedCase();
    await getDb().query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'doc')`, [SENTINEL_ID]);
    const written = await getDb().query<{ id: string }>(
      `SELECT id FROM public.nodes WHERE id = $1`,
      [SENTINEL_ID]
    );
    expect(written.rows).toEqual([{ id: SENTINEL_ID }]);
  });

  it('starts the next case in a different database without the prior sentinel', async () => {
    await expectCleanMigratedCase();
    const leaked = await getDb().query<{ id: string }>(
      `SELECT id FROM public.nodes WHERE id = $1`,
      [SENTINEL_ID]
    );
    expect(leaked.rows).toEqual([]);
  });
});
