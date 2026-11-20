/**
 * Integration tests for settingsService against the real DB: read (defaults,
 * overrides, corrupt rows, cache), readOptional, write, revert, readCategory,
 * and mergeEntries on the locked row (concurrent merges keep every key).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { getDb } from '@snaglet/db';
import { Settings } from '@snaglet/db/tables/settings';
import { settingsService } from '@server/services/settings/settingsService';
import { defineCategory } from '@server/services/settings/defineSetting';
import { registry } from '@server/services/settings/registry';
import { cache } from '@server/services/settings/cache';
import { appearanceSettings } from '@server/services/settings/categories/appearance';
import changeColorTheme from '@server/services/ToolService/tools/system/change-color-theme/tool';

const TEST_CATEGORY = 'test_settings_service';

let testUserId: string;

beforeAll(async () => {
  const pool = getDb();
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM public.users LIMIT 1`);
  if (!rows[0]) throw new Error('no user row available for actor fixture');
  testUserId = rows[0].id;
});

async function cleanupDb() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.settings WHERE category = $1`, [TEST_CATEGORY]);
}

// defineCategory below mutates the global registry. Leave it as-is — the
// registry isn't reset between suites; the production self-test in
// registry.test.ts uses jest.resetModules() to start fresh anyway.
const testDefs = defineCategory(TEST_CATEGORY, {
  flag: { key: 'flag', schema: z.boolean(), default: false, description: '' },
  size: { key: 'size', schema: z.number().int().nonnegative(), default: 10, description: '' },
  prefs: {
    key: 'prefs',
    schema: z.object({ a: z.boolean(), b: z.number() }),
    default: { a: true, b: 1 },
    description: '',
  },
  palette: {
    key: 'palette',
    schema: z.record(z.string(), z.string()),
    default: {} as Record<string, string>,
    description: '',
  },
  optionalCfg: {
    key: 'optional_cfg',
    // Sentinel-style default: empty host means "not configured". A caller
    // that cares about "configured" vs "default" reaches for readOptional.
    schema: z.object({ host: z.string() }),
    default: { host: '' },
    description: '',
  },
});

beforeEach(async () => {
  await cleanupDb();
  cache.__clearForTests();
});

afterEach(async () => {
  await cleanupDb();
});

describe('settingsService.read', () => {
  // Inside the describe so it runs before the shared closeDatabase() teardown; getDbClient() throws after close.
  afterAll(cleanupDb);

  it('returns the registry default when no override exists', async () => {
    const v = await settingsService.read(testDefs.flag);
    expect(v).toBe(false);
  });

  it('returns the persisted override when one exists', async () => {
    await Settings.write(TEST_CATEGORY, 'flag', true);
    cache.__clearForTests();
    const v = await settingsService.read(testDefs.flag);
    expect(v).toBe(true);
  });

  it('returns a complex object override correctly typed', async () => {
    await Settings.write(TEST_CATEGORY, 'prefs', { a: false, b: 99 });
    cache.__clearForTests();
    const v = await settingsService.read(testDefs.prefs);
    expect(v).toEqual({ a: false, b: 99 });
  });

  it('throws if the persisted row fails the schema', async () => {
    await Settings.write(TEST_CATEGORY, 'size', -5);
    cache.__clearForTests();
    await expect(settingsService.read(testDefs.size)).rejects.toThrow(/fails schema/);
  });

  it('caches the read result (second call does not hit DB)', async () => {
    await settingsService.read(testDefs.flag);
    const spy = jest.spyOn(Settings, 'read');
    await settingsService.read(testDefs.flag);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('settingsService.readOptional', () => {
  // Nested for the same reason as the describe above.
  afterAll(cleanupDb);

  it('returns null when no row exists', async () => {
    const v = await settingsService.readOptional(testDefs.optionalCfg);
    expect(v).toBeNull();
  });

  it('returns the parsed value when a row exists', async () => {
    await Settings.write(TEST_CATEGORY, 'optional_cfg', { host: 'example.com' });
    const v = await settingsService.readOptional(testDefs.optionalCfg);
    expect(v).toEqual({ host: 'example.com' });
  });
});

describe('settingsService.write', () => {
  // Nested for the same reason as the describes above.
  afterAll(cleanupDb);

  it('validates against the schema before persisting', async () => {
    await expect(settingsService.write(testDefs.size, -1 as unknown as number)).rejects.toThrow(
      /fails schema/
    );
    const row = await Settings.read(TEST_CATEGORY, 'size');
    expect(row).toBeNull();
  });

  it('persists a valid value', async () => {
    await settingsService.write(testDefs.size, 42);
    const row = await Settings.read(TEST_CATEGORY, 'size');
    expect(row?.value).toBe(42);
  });

  it('records the actor when provided', async () => {
    await settingsService.write(testDefs.size, 7, { userId: testUserId });
    const row = await Settings.read(TEST_CATEGORY, 'size');
    expect(row?.updatedByUserId).toBe(testUserId);
  });

  it('invalidates the cache so the next read sees the new value', async () => {
    await settingsService.read(testDefs.flag); // primes cache with default
    await settingsService.write(testDefs.flag, true);
    const v = await settingsService.read(testDefs.flag);
    expect(v).toBe(true);
  });

  it('emits a settings:changed event', async () => {
    const events: unknown[] = [];
    const off = settingsService.onChange((e) => events.push(e));
    await settingsService.write(testDefs.flag, true, { userId: testUserId });
    off();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: TEST_CATEGORY,
      key: 'flag',
      value: true,
      reverted: false,
    });
  });
});

describe('settingsService.mergeEntries', () => {
  // Nested for the same reason as the describes above.
  afterAll(async () => {
    await cleanupDb();
    await getDb().query(
      `DELETE FROM public.settings WHERE category = 'appearance' AND key = 'colors'`
    );
  });

  it('sets the given keys, keeps the rest, records the actor and emits once', async () => {
    await settingsService.write(testDefs.palette, { a: '1', b: '2' });
    const events: unknown[] = [];
    const off = settingsService.onChange((e) => events.push(e));
    const merged = await settingsService.mergeEntries(
      testDefs.palette,
      { b: '20', c: '3' },
      { userId: testUserId }
    );
    off();
    expect(merged).toEqual({ a: '1', b: '20', c: '3' });
    const row = await Settings.read(TEST_CATEGORY, 'palette');
    expect(row?.value).toEqual({ a: '1', b: '20', c: '3' });
    expect(row?.updatedByUserId).toBe(testUserId);
    expect(events).toHaveLength(1);
  });

  it('keeps every key when merges land at the same time', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    await Promise.all(
      keys.map((key) => settingsService.mergeEntries(testDefs.palette, { [key]: key }))
    );
    const row = await Settings.read(TEST_CATEGORY, 'palette');
    expect(Object.keys(row?.value as object).sort()).toEqual(expect.arrayContaining(keys));
  });

  it('refuses a scalar setting, a forbidden key and a value that fails the schema', async () => {
    await expect(settingsService.mergeEntries(testDefs.size as never, { a: 1 })).rejects.toThrow(
      /not a map-shaped setting/
    );
    await expect(
      settingsService.mergeEntries(testDefs.palette, JSON.parse('{"__proto__": "x"}'))
    ).rejects.toThrow(/Invalid entry key/);
    await expect(settingsService.mergeEntries(testDefs.palette, { a: 5 })).rejects.toThrow(
      /fails schema/
    );
  });

  it("keeps both tokens when an agent's change_color_theme and a Theme view save land together", async () => {
    await getDb().query(
      `DELETE FROM public.settings WHERE category = 'appearance' AND key = 'colors'`
    );
    cache.__clearForTests();
    await Promise.all([
      changeColorTheme({ op: 'set', colors: { text: '#112233' } }, {}),
      // What PATCH /api/settings/appearance/colors runs for a Theme view save.
      settingsService.mergeEntries(appearanceSettings.colors, { detail: '#00aa88' }),
    ]);
    const row = await Settings.read('appearance', 'colors');
    expect(row?.value).toMatchObject({ text: '#112233', detail: '#00aa88' });
  });
});

describe('settingsService.revert', () => {
  // Nested for the same reason as the describes above.
  afterAll(cleanupDb);

  it('removes the row and returns the default', async () => {
    await settingsService.write(testDefs.size, 99);
    const restored = await settingsService.revert(testDefs.size);
    expect(restored).toBe(10);
    const row = await Settings.read(TEST_CATEGORY, 'size');
    expect(row).toBeNull();
  });

  it('emits with reverted:true', async () => {
    await settingsService.write(testDefs.size, 99);
    const events: Array<{ reverted: boolean }> = [];
    const off = settingsService.onChange((e) => events.push(e));
    await settingsService.revert(testDefs.size);
    off();
    expect(events.some((e) => e.reverted === true)).toBe(true);
  });
});

describe('settingsService.readCategory', () => {
  // Nested for the same reason as the describes above.
  afterAll(cleanupDb);

  it('returns defaults for keys without overrides', async () => {
    const map = await settingsService.readCategory(TEST_CATEGORY);
    expect(map.flag).toBe(false);
    expect(map.size).toBe(10);
  });

  it('merges overrides on top of defaults', async () => {
    await Settings.write(TEST_CATEGORY, 'flag', true);
    cache.__clearForTests();
    const map = await settingsService.readCategory(TEST_CATEGORY);
    expect(map.flag).toBe(true);
    expect(map.size).toBe(10);
  });

  it('surfaces orphan rows that have no registry entry', async () => {
    // Insert directly via the model; orphan key not in testDefs
    await Settings.write(TEST_CATEGORY, 'orphan_key', { stale: true });
    cache.__clearForTests();
    const map = await settingsService.readCategory(TEST_CATEGORY);
    expect(map.orphan_key).toEqual({ stale: true });
  });
});
