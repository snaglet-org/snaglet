/**
 * Palette `table` lane against the real database.
 *
 * Database tables are `public.table_catalog` rows, not nodes. The lane is a
 * keyword-only, case-insensitive name lookup (exact > prefix > substring, then
 * name and id), wildcards in the query are literal, an empty browse lists the
 * user's own tables first, a pasted catalog id resolves exactly, and a hit
 * carries only id, name and origin — never the physical table name or rows.
 * The builtin rows are seeded by migrations; custom rows are created here.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { closeDatabase, getDb } from '@snaglet/db';
import { paletteSearch } from '@server/services/search/paletteSearch';
import { hydratePaletteHits } from '@server/services/search/paletteSearchHydration';
import {
  browseKind,
  resolveExactId,
  searchPaletteOnlyKind,
} from '@server/services/search/paletteSearchQueries';
import verifyIds from '@server/services/ToolService/handlers/workspace/verifyIds';

// A custom table's name is its real physical table name.
const CUSTOM_ROWS: ReadonlyArray<[id: string, name: string]> = [
  ['table-1111111111111-aaaaaaaaa', 'test_table_a'],
  ['table-1111111111111-bbbbbbbbb', 'testxtable'],
  ['table-1111111111111-ccccccccc', 'credentials_archive'],
  ['table-1111111111111-ddddddddd', 'old_credentials'],
];
const CUSTOM_IDS = CUSTOM_ROWS.map(([id]) => id);
const MISSING_ID = 'table-1111111111111-zzzzzzzzz';

async function insertCustomRows(): Promise<void> {
  for (const [id, name] of CUSTOM_ROWS) {
    await getDb().query(
      `INSERT INTO public.table_catalog (id, name, table_name, origin)
       VALUES ($1, $2, $2, 'custom')`,
      [id, name]
    );
  }
}

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.table_catalog WHERE id = ANY($1::text[])`, [CUSTOM_IDS]);
}

describe('palette table lane — real catalog', () => {
  beforeEach(insertCustomRows);
  afterEach(cleanup);

  afterAll(async () => {
    await closeDatabase();
  });

  it('finds custom tables by name, prefix before substring; built-in tables never match', async () => {
    const hits = await searchPaletteOnlyKind({ query: 'cred', kind: 'table', limit: 10 });

    expect(hits.map((hit) => hit.node_id)).toEqual([
      'table-1111111111111-ccccccccc',
      'table-1111111111111-ddddddddd',
    ]);
    expect(hits.map((hit) => hit.score)).toEqual([0.9, 0.6]);
    expect(hits.every((hit) => hit.kind === 'table' && hit.channels[0] === 'fts')).toBe(true);
  });

  it('ranks an exact case-insensitive name match first', async () => {
    const hits = await searchPaletteOnlyKind({
      query: 'OLD_CREDENTIALS',
      kind: 'table',
      limit: 10,
    });

    expect(hits[0]).toMatchObject({ node_id: 'table-1111111111111-ddddddddd', score: 1 });
  });

  it('treats LIKE wildcards in the query literally', async () => {
    const underscore = await searchPaletteOnlyKind({ query: 'test_t', kind: 'table', limit: 10 });
    expect(underscore.map((hit) => hit.node_id)).toEqual(['table-1111111111111-aaaaaaaaa']);

    const percent = await searchPaletteOnlyKind({ query: '%', kind: 'table', limit: 10 });
    expect(percent).toEqual([]);
  });

  it('hydrates a hit with the display name and origin only', async () => {
    const hits = await hydratePaletteHits(
      'table',
      await searchPaletteOnlyKind({ query: 'credentials_archive', kind: 'table', limit: 1 })
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      node_id: 'table-1111111111111-ccccccccc',
      kind: 'table',
      payload: { name: 'credentials_archive', title: 'credentials_archive', origin: 'custom' },
    });
    expect(Object.keys(hits[0]!.payload).sort()).toEqual(['createdAt', 'name', 'origin', 'title']);
    expect(JSON.stringify(hits[0])).not.toContain('user_provider_credentials');
  });

  it('browses custom tables first, then builtins, each by name', async () => {
    const hits = await browseKind('table', 20);
    const ids = hits.map((hit) => hit.node_id);

    expect(ids.slice(0, 4)).toEqual([
      'table-1111111111111-ccccccccc',
      'table-1111111111111-ddddddddd',
      'table-1111111111111-aaaaaaaaa',
      'table-1111111111111-bbbbbbbbb',
    ]);
    expect(ids.slice(4)).toEqual(
      expect.arrayContaining(['table-builtin-docs', 'table-builtin-credentials'])
    );
    expect(ids.slice(4).every((id) => id.startsWith('table-builtin-'))).toBe(true);
    expect(hits.every((hit) => typeof hit.payload.title === 'string')).toBe(true);
  });

  it('resolves a pasted catalog id exactly and rejects an unknown one', async () => {
    await expect(resolveExactId('table-builtin-credentials')).resolves.toEqual({
      id: 'table-builtin-credentials',
      kind: 'table',
    });
    await expect(resolveExactId(MISSING_ID)).resolves.toBeNull();
  });

  it('serves a keyword table search end to end through paletteSearch', async () => {
    const result = await paletteSearch({ query: 'cred', kinds: ['table'], mode: 'keyword' });

    expect(result.coverage).toEqual({ table: 'lexical' });
    expect(result.byKind.table?.[0]).toMatchObject({
      node_id: 'table-1111111111111-ccccccccc',
      payload: { title: 'credentials_archive', origin: 'custom' },
    });
    expect(result.byKind.table?.some((hit) => hit.node_id.startsWith('table-builtin-'))).toBe(
      false
    );
  });

  it('verify_ids confirms catalog ids as tables', async () => {
    const result = await verifyIds({ ids: ['table-builtin-credentials', MISSING_ID] });

    expect(result.verified).toEqual([
      {
        id: 'table-builtin-credentials',
        exists: true,
        type: 'table',
        title: 'Credentials',
        archived: false,
      },
      { id: MISSING_ID, exists: false },
    ]);
  });
});
