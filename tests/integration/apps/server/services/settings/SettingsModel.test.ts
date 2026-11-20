/**
 * Integration tests for SettingsModel.
 *
 * Hits the real database. Verifies the JSONB round-trip, the (category, key)
 * composite primary key behavior, the CHECK constraints (category format,
 * key format, at-most-one-author), and the upsert semantics.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { Settings } from '@snaglet/db/tables/settings';
import { getDb } from '@snaglet/db';

const TEST_CATEGORY = 'test_settings_model';

let testUserId: string;
let testAgentId: string;

beforeAll(async () => {
  const pool = getDb();
  const userRes = await pool.query<{ id: string }>(`SELECT id FROM public.users LIMIT 1`);
  if (!userRes.rows[0]) throw new Error('no user row available for fixture');
  testUserId = userRes.rows[0].id;

  const agentRes = await pool.query<{ id: string }>(`SELECT id FROM public.agents LIMIT 1`);
  if (!agentRes.rows[0]) throw new Error('no agent row available for fixture');
  testAgentId = agentRes.rows[0].id;
});

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.settings WHERE category = $1`, [TEST_CATEGORY]);
}

describe('SettingsModel', () => {
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  describe('JSONB round-trip', () => {
    it('persists and reads back a number value', async () => {
      await Settings.write(TEST_CATEGORY, 'a_number', 42);
      const row = await Settings.read(TEST_CATEGORY, 'a_number');
      expect(row?.value).toBe(42);
    });

    it('persists and reads back a boolean value', async () => {
      await Settings.write(TEST_CATEGORY, 'a_bool', true);
      const row = await Settings.read(TEST_CATEGORY, 'a_bool');
      expect(row?.value).toBe(true);
    });

    it('persists and reads back a string value', async () => {
      await Settings.write(TEST_CATEGORY, 'a_string', 'hello');
      const row = await Settings.read(TEST_CATEGORY, 'a_string');
      expect(row?.value).toBe('hello');
    });

    it('persists and reads back a nested object value', async () => {
      const obj = { a: 1, b: { c: true, d: ['x', 'y'] } };
      await Settings.write(TEST_CATEGORY, 'an_object', obj);
      const row = await Settings.read(TEST_CATEGORY, 'an_object');
      expect(row?.value).toEqual(obj);
    });

    it('persists and reads back null inside a nested object', async () => {
      const obj = { provider: 'openai', credential: null };
      await Settings.write(TEST_CATEGORY, 'with_null', obj);
      const row = await Settings.read(TEST_CATEGORY, 'with_null');
      expect(row?.value).toEqual(obj);
    });
  });

  describe('read', () => {
    it('returns null for a non-existent override', async () => {
      const row = await Settings.read(TEST_CATEGORY, 'does_not_exist');
      expect(row).toBeNull();
    });

    it('sets updated_at on write', async () => {
      const before = Date.now();
      const row = await Settings.write(TEST_CATEGORY, 'has_time', 1);
      expect(new Date(row.updatedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    });
  });

  describe('write (upsert semantics)', () => {
    it('inserts a new row when none exists', async () => {
      const row = await Settings.write(TEST_CATEGORY, 'upserted', { v: 1 });
      expect(row.value).toEqual({ v: 1 });
    });

    it('overwrites an existing row on conflict', async () => {
      await Settings.write(TEST_CATEGORY, 'upserted', { v: 1 });
      await Settings.write(TEST_CATEGORY, 'upserted', { v: 2 });
      const row = await Settings.read(TEST_CATEGORY, 'upserted');
      expect(row?.value).toEqual({ v: 2 });
    });

    it('updates updated_at on overwrite', async () => {
      const first = await Settings.write(TEST_CATEGORY, 'time_test', 1);
      await new Promise((r) => setTimeout(r, 20));
      const second = await Settings.write(TEST_CATEGORY, 'time_test', 2);
      expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(
        new Date(first.updatedAt).getTime()
      );
    });

    it('records actor.userId in updated_by_user_id', async () => {
      const row = await Settings.write(TEST_CATEGORY, 'authored', 1, { userId: testUserId });
      expect(row.updatedByUserId).toBe(testUserId);
      expect(row.updatedByAgentId).toBeNull();
    });

    it('leaves both author columns null when no actor is passed', async () => {
      const row = await Settings.write(TEST_CATEGORY, 'unattributed', 1);
      expect(row.updatedByUserId).toBeNull();
      expect(row.updatedByAgentId).toBeNull();
    });
  });

  describe('remove', () => {
    it('removes an existing row', async () => {
      await Settings.write(TEST_CATEGORY, 'removable', 1);
      await Settings.remove(TEST_CATEGORY, 'removable');
      const row = await Settings.read(TEST_CATEGORY, 'removable');
      expect(row).toBeNull();
    });

    it('is idempotent on non-existent rows', async () => {
      await expect(Settings.remove(TEST_CATEGORY, 'never_existed')).resolves.toBeUndefined();
    });
  });

  describe('listByCategory', () => {
    it('returns all rows under the category, ordered by key', async () => {
      await Settings.write(TEST_CATEGORY, 'b_key', 2);
      await Settings.write(TEST_CATEGORY, 'a_key', 1);
      await Settings.write(TEST_CATEGORY, 'c_key', 3);
      const rows = await Settings.listByCategory(TEST_CATEGORY);
      const keys = rows.map((r) => r.key);
      expect(keys).toEqual(['a_key', 'b_key', 'c_key']);
    });

    it('returns an empty array when the category has no rows', async () => {
      const rows = await Settings.listByCategory('unused_category_xyz');
      expect(rows).toEqual([]);
    });
  });

  describe('CHECK constraints', () => {
    it('rejects an uppercase character in category', async () => {
      const pool = getDb();
      await expect(
        pool.query(
          `INSERT INTO public.settings (category, key, value) VALUES ($1, $2, '1'::jsonb)`,
          ['Bad_Category', 'k']
        )
      ).rejects.toThrow(/settings_category_format/);
    });

    it('rejects a dot in category', async () => {
      const pool = getDb();
      await expect(
        pool.query(
          `INSERT INTO public.settings (category, key, value) VALUES ($1, $2, '1'::jsonb)`,
          ['cat.sub', 'k']
        )
      ).rejects.toThrow(/settings_category_format/);
    });

    it('rejects an empty category', async () => {
      const pool = getDb();
      await expect(
        pool.query(
          `INSERT INTO public.settings (category, key, value) VALUES ($1, $2, '1'::jsonb)`,
          ['', 'k']
        )
      ).rejects.toThrow(/settings_category_format/);
    });

    it('rejects an uppercase character in key', async () => {
      const pool = getDb();
      await expect(
        pool.query(
          `INSERT INTO public.settings (category, key, value) VALUES ($1, $2, '1'::jsonb)`,
          [TEST_CATEGORY, 'BadKey']
        )
      ).rejects.toThrow(/settings_key_format/);
    });

    it('rejects whitespace in key', async () => {
      const pool = getDb();
      await expect(
        pool.query(
          `INSERT INTO public.settings (category, key, value) VALUES ($1, $2, '1'::jsonb)`,
          [TEST_CATEGORY, 'has space']
        )
      ).rejects.toThrow(/settings_key_format/);
    });

    it('rejects a trailing dot in key', async () => {
      const pool = getDb();
      await expect(
        pool.query(
          `INSERT INTO public.settings (category, key, value) VALUES ($1, $2, '1'::jsonb)`,
          [TEST_CATEGORY, 'trailing.']
        )
      ).rejects.toThrow(/settings_key_format/);
    });

    it('accepts a dotted-hierarchy key within a category', async () => {
      const pool = getDb();
      await expect(
        pool.query(
          `INSERT INTO public.settings (category, key, value) VALUES ($1, $2, '1'::jsonb)`,
          [TEST_CATEGORY, 'node.doc.settings']
        )
      ).resolves.toBeTruthy();
    });

    it('rejects setting both updated_by_user_id and updated_by_agent_id', async () => {
      const pool = getDb();
      await expect(
        pool.query(
          `INSERT INTO public.settings (category, key, value, updated_by_user_id, updated_by_agent_id)
           VALUES ($1, $2, '1'::jsonb, $3, $4)`,
          [TEST_CATEGORY, 'two_authors', testUserId, testAgentId]
        )
      ).rejects.toThrow(/settings_at_most_one_author/);
    });
  });
});
