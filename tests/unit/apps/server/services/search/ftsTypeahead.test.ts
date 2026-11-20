/**
 * Type-ahead title matching in the keyword lane (`@` search, Cmd+K): a doc,
 * thread or folder whose title has every typed word as a word start matches
 * while the last word is still half typed. Off for committed searches.
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

const dbQuery = jest.fn(async () => ({ rows: [] as unknown[] }));
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => dbQuery(sql, params) }),
}));

import { ftsSearchNodes } from '@server/services/search/ftsSearchNodes';
import { typeaheadWords } from '@server/services/search/lexicalQuery';
import type { ResolvedScope } from '@server/services/search/searchPolicy';

const ROOT: ResolvedScope = { mode: 'root', source: 'explicit_container' };

function lastCall(): [string, unknown[]] {
  return dbQuery.mock.calls.at(-1) as unknown as [string, unknown[]];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('typeaheadWords', () => {
  it('splits on spaces and punctuation, lowercases, and keeps letters and digits', () => {
    expect(typeaheadWords('Automations rech')).toEqual(['automations', 'rech']);
    expect(typeaheadWords('  plan-B, v2 (draft) ')).toEqual(['plan', 'b', 'v2', 'draft']);
    expect(typeaheadWords('Résumé')).toEqual(['résumé']);
    expect(typeaheadWords('%_*?')).toEqual([]);
  });
});

describe('ftsSearchNodes type-ahead', () => {
  it('widens the thread title match with every word, the half-typed last one included', async () => {
    await ftsSearchNodes({
      query: 'Automations rech',
      kind: 'thread',
      scope: ROOT,
      limit: 24,
      typeahead: true,
    });
    const [sql, params] = lastCall();
    expect(sql).toContain("plainto_tsquery('english', $1)");
    expect(sql).toMatch(
      /WHERE \(to_tsvector\('english', COALESCE\(COALESCE\(t\.title, 'Untitled thread'\), ''\)\) @@ q\.tsq OR NOT EXISTS \(SELECT 1 FROM unnest\(\$5::text\[\]\)/
    );
    expect(sql).toContain("~* ('(^|[^[:alnum:]])' || typed.word)");
    expect(params).toEqual(['Automations rech', null, null, 24, ['automations', 'rech']]);
  });

  it('matches folder names and doc titles the same way', async () => {
    await ftsSearchNodes({
      query: 'ship stat',
      kind: 'container',
      scope: ROOT,
      limit: 8,
      typeahead: true,
    });
    const [containerSql, containerParams] = lastCall();
    expect(containerSql).toContain('NOT EXISTS (SELECT 1 FROM unnest($5::text[])');
    expect(containerSql).toContain('NOT (c.name ~*');
    expect(containerParams.at(-1)).toEqual(['ship', 'stat']);

    await ftsSearchNodes({
      query: 'design rev',
      kind: 'doc',
      scope: ROOT,
      limit: 8,
      typeahead: true,
    });
    const [docSql, docParams] = lastCall();
    expect(docSql).toContain(
      '(d.search_text @@ q.tsq OR NOT EXISTS (SELECT 1 FROM unnest($5::text[])'
    );
    expect(docSql).toContain("NOT (COALESCE(d.title, '') ~*");
    expect(docParams.at(-1)).toEqual(['design', 'rev']);
  });

  it('leaves committed searches, untitled kinds and wordless queries as they were', async () => {
    await ftsSearchNodes({ query: 'Automations rech', kind: 'thread', scope: ROOT, limit: 8 });
    let [sql, params] = lastCall();
    expect(sql).not.toContain('unnest(');
    expect(params).toHaveLength(4);

    await ftsSearchNodes({
      query: 'deploy notes',
      kind: 'message',
      scope: ROOT,
      limit: 8,
      typeahead: true,
    });
    [sql, params] = lastCall();
    expect(sql).not.toContain('unnest(');
    expect(params).toHaveLength(4);

    await ftsSearchNodes({ query: '%%', kind: 'thread', scope: ROOT, limit: 8, typeahead: true });
    [sql, params] = lastCall();
    expect(sql).not.toContain('unnest(');
    expect(params).toHaveLength(4);
  });
});
