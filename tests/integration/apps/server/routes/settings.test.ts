/**
 * /api/settings against the real DB, mounted with the production error
 * middleware so AppError → HTTP status conversion is covered: listing
 * overrides and the registry, PUT validation (400 bad value, 404 unknown
 * setting), GET of one setting (override or default), PATCH merging into an
 * object setting on the locked row (400 on scalars), and idempotent DELETE.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import settingsRouter from '@server/routes/settings';
import { defineCategory } from '@server/services/settings/defineSetting';
import { cache } from '@server/services/settings/cache';

const TEST_CATEGORY = 'test_settings_routes';

// Defined once at module level so the registry has these entries before
// the router resolves them. The registry is process-global; production
// category files declared via `import '@server/services/settings'` may
// also be in the registry, which is fine — our test endpoints only ever
// poke at TEST_CATEGORY keys.
const testDefs = defineCategory(TEST_CATEGORY, {
  toggle: {
    key: 'toggle',
    schema: z.boolean(),
    default: false,
    description: 'a test toggle',
  },
  size: {
    key: 'size',
    schema: z.number().int().nonnegative(),
    default: 10,
    description: 'a test size',
  },
  prefs: {
    key: 'prefs',
    schema: z.object({ a: z.boolean(), b: z.number() }),
    default: { a: true, b: 1 },
    description: 'a test object',
  },
  palette: {
    key: 'palette',
    schema: z.record(z.string(), z.string()),
    default: {} as Record<string, string>,
    description: 'a test map',
  },
});

async function cleanupDb() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.settings WHERE category = $1`, [TEST_CATEGORY]);
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Application;

beforeAll(() => {
  app = makeApp();
});

beforeEach(async () => {
  await cleanupDb();
  cache.__clearForTests();
});

describe('GET /api/settings', () => {
  // Inside the describe so it runs before the shared closeDatabase() teardown; getDbClient() throws after close.
  afterAll(async () => {
    await cleanupDb();
  });

  it('returns an empty list when no overrides exist for the test category', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Other tests / production rows may be present; filter for ours.
    const ours = (res.body.data as Array<{ category: string }>).filter(
      (r) => r.category === TEST_CATEGORY
    );
    expect(ours).toEqual([]);
  });

  it('returns override rows after a write', async () => {
    await request(app).put(`/api/settings/${TEST_CATEGORY}/toggle`).send({ value: true });
    const res = await request(app).get('/api/settings');
    const ours = (res.body.data as Array<{ category: string; key: string; value: unknown }>).filter(
      (r) => r.category === TEST_CATEGORY
    );
    expect(ours).toEqual([
      expect.objectContaining({ category: TEST_CATEGORY, key: 'toggle', value: true }),
    ]);
  });
});

describe('GET /api/settings/registry', () => {
  // Nested for the same reason as the describe above.
  afterAll(async () => {
    await cleanupDb();
  });

  it('includes every registered test setting with the default as current', async () => {
    const res = await request(app).get('/api/settings/registry');
    expect(res.status).toBe(200);
    const ours = (res.body.data as Array<{ category: string; key: string }>).filter(
      (r) => r.category === TEST_CATEGORY
    );
    expect(ours).toHaveLength(Object.keys(testDefs).length);
    const toggle = ours.find((r) => r.key === 'toggle')!;
    expect(toggle).toMatchObject({
      default: false,
      current: false,
      isOverridden: false,
      valueType: 'boolean',
    });
  });

  it('shows the override as current and isOverridden:true after a write', async () => {
    await request(app).put(`/api/settings/${TEST_CATEGORY}/toggle`).send({ value: true });
    const res = await request(app).get('/api/settings/registry');
    const toggle = (res.body.data as Array<{ category: string; key: string }>).find(
      (r) => r.category === TEST_CATEGORY && r.key === 'toggle'
    )!;
    expect(toggle).toMatchObject({
      default: false,
      current: true,
      isOverridden: true,
    });
  });

  it('infers valueType correctly for object settings', async () => {
    const res = await request(app).get('/api/settings/registry');
    const prefs = (res.body.data as Array<{ category: string; key: string }>).find(
      (r) => r.category === TEST_CATEGORY && r.key === 'prefs'
    )!;
    expect((prefs as { valueType: string }).valueType).toBe('object');
  });
});

describe('PUT /api/settings/:category/:key', () => {
  // Nested for the same reason as the describes above.
  afterAll(async () => {
    await cleanupDb();
  });

  it('persists a valid scalar value', async () => {
    const res = await request(app).put(`/api/settings/${TEST_CATEGORY}/size`).send({ value: 42 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ category: TEST_CATEGORY, key: 'size', value: 42 });
  });

  it('persists an object value without double-stringify', async () => {
    const res = await request(app)
      .put(`/api/settings/${TEST_CATEGORY}/prefs`)
      .send({ value: { a: false, b: 99 } });
    expect(res.status).toBe(200);
    expect(res.body.data.value).toEqual({ a: false, b: 99 });
  });

  it('returns 400 for a value that fails the schema', async () => {
    const res = await request(app).put(`/api/settings/${TEST_CATEGORY}/size`).send({ value: -5 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // errorHandler envelope: { error: { code, message, stack } }
    const errMsg = typeof res.body.error === 'string' ? res.body.error : res.body.error?.message;
    expect(errMsg).toMatch(/does not match the setting schema/);
  });

  it('returns 400 when body has no value field', async () => {
    const res = await request(app).put(`/api/settings/${TEST_CATEGORY}/size`).send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown setting', async () => {
    const res = await request(app)
      .put(`/api/settings/${TEST_CATEGORY}/does_not_exist`)
      .send({ value: 1 });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown category', async () => {
    const res = await request(app)
      .put('/api/settings/no_such_category/whatever')
      .send({ value: 1 });
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid category format', async () => {
    const res = await request(app).put('/api/settings/Bad-Cat/whatever').send({ value: 1 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/settings/:category/:key', () => {
  // Nested for the same reason as the describes above.
  afterAll(async () => {
    await cleanupDb();
  });

  it('returns the default and isOverridden:false when nothing is saved', async () => {
    const res = await request(app).get(`/api/settings/${TEST_CATEGORY}/prefs`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      category: TEST_CATEGORY,
      key: 'prefs',
      value: { a: true, b: 1 },
      isOverridden: false,
    });
  });

  it('returns the saved override', async () => {
    await request(app).put(`/api/settings/${TEST_CATEGORY}/size`).send({ value: 42 });
    const res = await request(app).get(`/api/settings/${TEST_CATEGORY}/size`);
    expect(res.body.data).toMatchObject({ value: 42, isOverridden: true });
  });

  it('returns 404 for an unknown setting', async () => {
    const res = await request(app).get(`/api/settings/${TEST_CATEGORY}/nope`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/settings/:category/:key', () => {
  // Nested for the same reason as the describes above.
  afterAll(async () => {
    await cleanupDb();
  });

  it('merges partial fields into an object value', async () => {
    await request(app)
      .put(`/api/settings/${TEST_CATEGORY}/prefs`)
      .send({ value: { a: true, b: 1 } });
    const res = await request(app)
      .patch(`/api/settings/${TEST_CATEGORY}/prefs`)
      .send({ value: { b: 99 } });
    expect(res.status).toBe(200);
    expect(res.body.data.value).toEqual({ a: true, b: 99 });
  });

  it('keeps every field when saves land at the same time', async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
    const responses = await Promise.all(
      keys.map((key) =>
        request(app)
          .patch(`/api/settings/${TEST_CATEGORY}/palette`)
          .send({ value: { [key]: key } })
      )
    );
    expect(responses.map((res) => res.status)).toEqual(keys.map(() => 200));
    const res = await request(app).get(`/api/settings/${TEST_CATEGORY}/palette`);
    expect(Object.keys(res.body.data.value).sort()).toEqual(keys);
  });

  it('returns 400 when patching a scalar setting', async () => {
    const res = await request(app)
      .patch(`/api/settings/${TEST_CATEGORY}/size`)
      .send({ value: { extra: 1 } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body.value is not an object', async () => {
    const res = await request(app)
      .patch(`/api/settings/${TEST_CATEGORY}/prefs`)
      .send({ value: 42 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the merged value fails the schema', async () => {
    await request(app)
      .put(`/api/settings/${TEST_CATEGORY}/prefs`)
      .send({ value: { a: true, b: 1 } });
    const res = await request(app)
      .patch(`/api/settings/${TEST_CATEGORY}/prefs`)
      .send({ value: { a: 'not a bool' as unknown as boolean } });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/settings/:category/:key', () => {
  // Nested for the same reason as the describes above.
  afterAll(async () => {
    await cleanupDb();
  });

  it('removes the override and returns success', async () => {
    await request(app).put(`/api/settings/${TEST_CATEGORY}/toggle`).send({ value: true });
    const res = await request(app).delete(`/api/settings/${TEST_CATEGORY}/toggle`);
    expect(res.status).toBe(200);

    const after = await request(app).get('/api/settings');
    const ours = (after.body.data as Array<{ category: string; key: string }>).filter(
      (r) => r.category === TEST_CATEGORY && r.key === 'toggle'
    );
    expect(ours).toEqual([]);
  });

  it('is idempotent on a non-existent override', async () => {
    const res = await request(app).delete(`/api/settings/${TEST_CATEGORY}/toggle`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for an unknown setting', async () => {
    const res = await request(app).delete(`/api/settings/${TEST_CATEGORY}/does_not_exist`);
    expect(res.status).toBe(404);
  });
});
