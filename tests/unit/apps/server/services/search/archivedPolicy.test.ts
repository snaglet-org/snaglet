/**
 * Archived search policy — archived nodes never surface by default, from any
 * channel; include_archived flips the filters off. Pins the SQL contract for
 * the lexical branches and the semantic candidate queries (the graph channel
 * excludes archived unconditionally — link digs must not resurrect them).
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

const dbQuery = jest.fn(async () => ({ rows: [] as unknown[] }));
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => dbQuery(sql, params) }),
}));
jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: { listAllOrdered: jest.fn(async () => []) },
}));
jest.mock('@server/config/logger.js', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { searchLexicalWorkspace } from '@server/services/ToolService/handlers/search/workspaceSearch/lexical';
import type { SearchableKind } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

const KINDS = new Set<SearchableKind>([
  'doc',
  'thread',
  'message',
  'memory',
  'thread_summary',
  'container',
  'image',
  'file',
]);

async function runLexical(includeArchived: boolean | undefined) {
  await searchLexicalWorkspace({
    query: 'anything',
    kinds: KINDS,
    limit: 10,
    allowedContainerIds: null,
    containerRowsCache: null,
    timeRange: null,
    includeArchived,
  });
  return dbQuery.mock.calls.map((call) => call[0] as unknown as string);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('archived search policy (lexical)', () => {
  it('every kind branch excludes archived nodes by default', async () => {
    const sqls = await runLexical(undefined);
    const branchSqls = sqls.filter((sql) => sql.includes('SELECT'));
    // 8 kind branches (there is no task branch; the project channel is
    // folded into containers).
    expect(branchSqls.length).toBeGreaterThanOrEqual(8);
    for (const sql of branchSqls) {
      // tools have no archived state; every other branch must filter.
      if (sql.includes('FROM public.tools')) continue;
      expect(sql).toContain('archived = false');
    }
    // Messages and summaries also exclude items under archived threads.
    const messageSql = branchSqls.find((sql) => sql.includes('FROM public.messages'));
    expect(messageSql).toContain('tn.archived = false');
    const summarySql = branchSqls.find((sql) => sql.includes('FROM public.thread_summaries'));
    expect(summarySql).toContain('tn.archived = false');
  });

  it('include_archived removes the filters from every branch', async () => {
    const sqls = await runLexical(true);
    for (const sql of sqls) {
      expect(sql).not.toContain('archived = false');
    }
  });
});
