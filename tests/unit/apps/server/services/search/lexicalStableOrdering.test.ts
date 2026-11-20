import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const dbQuery = jest.fn(async () => ({ rows: [] as unknown[] }));
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => dbQuery(sql, params) }),
}));
jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: { listAllOrdered: jest.fn(async () => []) },
}));

import { searchLexicalWorkspace } from '@server/services/ToolService/handlers/search/workspaceSearch/lexical';
import type { SearchableKind } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

const KINDS = new Set<SearchableKind>([
  'doc',
  'thread',
  'container',
  'message',
  'memory',
  'thread_summary',
  'tool',
  'image',
  'file',
]);

const EXPECTED_FINAL_TIE_BREAK = new Map<string, string>([
  ['FROM public.docs', 'd.id ASC'],
  ['FROM public.threads', 't.id ASC'],
  ['FROM public.containers', 'c.id ASC'],
  ['FROM public.messages', 'm.id ASC'],
  ['FROM public.memories', 'm.id ASC'],
  ['FROM public.thread_summaries', 'ts.id ASC'],
  ['FROM public.tools', 't.id ASC'],
  ['FROM public.images', 'i.id ASC'],
  ['FROM public.files', 'f.id ASC'],
]);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('workspace lexical SQL stable ordering contract', () => {
  it('ends every node-kind ORDER BY with a unique ascending id tie-break', async () => {
    await searchLexicalWorkspace({
      query: 'stable',
      kinds: KINDS,
      limit: 10,
      allowedContainerIds: null,
      containerRowsCache: null,
      timeRange: null,
    });

    const sqls = dbQuery.mock.calls.map((call) => call[0] as string);
    expect(sqls).toHaveLength(EXPECTED_FINAL_TIE_BREAK.size);
    for (const [fromClause, tieBreak] of EXPECTED_FINAL_TIE_BREAK) {
      const sql = sqls.find((candidate) => candidate.includes(fromClause));
      expect(sql).toBeDefined();
      const orderBy = sql?.match(/ORDER BY[\s\S]*?LIMIT/)?.[0] ?? '';
      expect(orderBy.trim()).toMatch(new RegExp(`, ${tieBreak}\\s+LIMIT$`));
    }
  });
});
