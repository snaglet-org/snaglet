/**
 * Semantic search over custom tables, on a fresh database:
 *
 * - off by default: no table has the setting and no row has a vector;
 * - one 768-dimension vector per (table, entry), replaced rather than doubled;
 * - a setting needs a real table, and a table's setting and vectors cascade
 *   when its catalog row is deleted.
 */
import { describe, expect, it } from '@jest/globals';
import { createFreshDatabase } from '../../../support/freshDatabase';

const TABLE = 'table-1111111111111-semaaaaaa';
const ENTRY = '11111111-1111-4111-8111-111111111111';

const vector = (value: number) => `[${new Array(768).fill(value).join(',')}]`;

describe('table semantic search schema', () => {
  it('starts empty, keeps one vector per row, and cascades with the table', async () => {
    const { db, close } = await createFreshDatabase('table_semantic');
    try {
      expect((await db.query('SELECT 1 FROM public.table_semantic_search')).rows).toEqual([]);
      expect((await db.query('SELECT 1 FROM public.table_entry_embeddings')).rows).toEqual([]);

      await db.query(
        `INSERT INTO public.table_catalog (id, name, table_name, origin) VALUES ($1, 'sema_notes', 'sema_notes', 'custom')`,
        [TABLE]
      );
      await db.query('INSERT INTO public.table_semantic_search (table_id) VALUES ($1)', [TABLE]);
      const insert = (hash: string, v: number) =>
        db.query(
          `INSERT INTO public.table_entry_embeddings (table_id, entry_id, model_id, card_hash, vector)
           VALUES ($1, $2, 'test-model', $3, $4::vector)
           ON CONFLICT (table_id, entry_id) DO UPDATE SET card_hash = EXCLUDED.card_hash, vector = EXCLUDED.vector`,
          [TABLE, ENTRY, hash, vector(v)]
        );
      await insert('h1', 0.1);
      await insert('h2', 0.2);
      const { rows } = await db.query<{ card_hash: string }>(
        'SELECT card_hash FROM public.table_entry_embeddings'
      );
      expect(rows).toEqual([{ card_hash: 'h2' }]);

      // The vector is 768 dimensions, not another size.
      await expect(
        db.query(
          `INSERT INTO public.table_entry_embeddings (table_id, entry_id, model_id, card_hash, vector)
           VALUES ($1, gen_random_uuid(), 'test-model', 'h', '[1,2,3]'::vector)`,
          [TABLE]
        )
      ).rejects.toThrow();
      // A setting needs a real table.
      await expect(
        db.query(
          "INSERT INTO public.table_semantic_search (table_id) VALUES ('table-1111111111111-nosuchtab')"
        )
      ).rejects.toMatchObject({ code: '23503' });

      await db.query('DELETE FROM public.table_catalog WHERE id = $1', [TABLE]);
      expect((await db.query('SELECT 1 FROM public.table_semantic_search')).rows).toEqual([]);
      expect((await db.query('SELECT 1 FROM public.table_entry_embeddings')).rows).toEqual([]);
    } finally {
      await close();
    }
  }, 120_000);
});
