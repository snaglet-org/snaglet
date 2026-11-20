import { describe, expect, it } from '@jest/globals';

const poolQuery = jest.fn();
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (...args: unknown[]) => poolQuery(...args) }),
}));
jest.mock('@server/services/search/paletteSearchHydration', () => ({
  paletteHit: (kind: string, id: string) => ({ kind, id }),
  hydratePaletteHits: jest.fn(),
}));

import { searchPaletteOnlyKind } from '@server/services/search/paletteSearchQueries';

describe('table palette SQL boundary', () => {
  it('excludes builtins before LIMIT so matching builtins cannot crowd out custom tables', async () => {
    const candidates = [
      { id: 'builtin-a', origin: 'builtin', name: 'Tasks' },
      { id: 'builtin-b', origin: 'builtin', name: 'Tasks archive' },
      { id: 'custom-c', origin: 'custom', name: 'Tasks project' },
      { id: 'custom-d', origin: 'custom', name: 'Tasks work' },
    ];
    const limit = 2;
    // Without the SQL origin predicate, builtins fill the whole result window.
    expect(candidates.slice(0, limit).every((row) => row.origin === 'builtin')).toBe(true);
    poolQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(params).toEqual(['Tasks', limit, 'Tasks']);
      expect(sql).toMatch(/WHERE[\s\S]*AND t\.origin = 'custom'[\s\S]*ORDER BY[\s\S]*LIMIT \$2/);
      // Model only filtering/limiting at the query boundary; no database is opened.
      const filtered = sql.includes("t.origin = 'custom'")
        ? candidates.filter((row) => row.origin === 'custom')
        : candidates;
      return { rows: filtered.slice(0, Number(params[1])).map((row) => ({ ...row, score: 0.9 })) };
    });
    expect(await searchPaletteOnlyKind({ query: 'Tasks', kind: 'table', limit })).toEqual([
      { kind: 'table', id: 'custom-c' },
      { kind: 'table', id: 'custom-d' },
    ]);
  });
});
