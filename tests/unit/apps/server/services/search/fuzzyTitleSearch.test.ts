/**
 * fuzzyTitleSearch — the fuzzy title booster. Pins the channel contract: serves
 * only the name-bearing kinds (doc/memory), gates with the index-served
 * trigram operators, scopes by container, and stays a single batched query.
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

const dbQuery = jest.fn(async () => ({ rows: [] as unknown[] }));
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => dbQuery(sql, params) }),
}));

import { fuzzyTitleCandidates } from '@server/services/search/ftsSearchNodes';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('fuzzyTitleCandidates', () => {
  it('returns [] without querying when no fuzzy-capable kind is requested', async () => {
    const out = await fuzzyTitleCandidates({
      query: 'implementation plan',
      kinds: ['message', 'thread_summary', 'file'],
      limit: 40,
      allowedContainerIds: null,
    });
    expect(out).toEqual([]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('returns [] without querying for a blank query', async () => {
    const out = await fuzzyTitleCandidates({
      query: '   ',
      kinds: ['doc'],
      limit: 40,
      allowedContainerIds: null,
    });
    expect(out).toEqual([]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('builds one UNION query with a branch per requested kind', async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', kind: 'doc', title: '16-implementation-plan' }],
    });
    const out = await fuzzyTitleCandidates({
      query: 'implmentation plan',
      kinds: ['doc', 'memory', 'message'],
      limit: 40,
      allowedContainerIds: ['cont-1'],
    });

    expect(out).toEqual([{ id: 'doc-1', kind: 'doc', title: '16-implementation-plan' }]);
    expect(dbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = dbQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("'doc'::text");
    expect(sql).toContain("'memory'::text");
    expect(sql).not.toContain("'message'::text");
    // Index-served trigram operators, not bare similarity() scans.
    expect(sql).toContain('% $1');
    expect(sql).toContain('$1 <%');
    // Archived exclusion + container scoping on every branch.
    expect(sql).toContain('n.archived = false');
    expect(params).toEqual(['implmentation plan', ['cont-1'], 40]);
  });

  it('omits branches for kinds that were not requested', async () => {
    await fuzzyTitleCandidates({
      query: 'reranker swap',
      kinds: ['doc'],
      limit: 10,
      allowedContainerIds: null,
    });
    const [sql] = dbQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("'doc'::text");
    expect(sql).not.toContain("'memory'::text");
  });
});
