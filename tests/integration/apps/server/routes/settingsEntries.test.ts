/**
 * Per-entry writes to map-valued settings (real DB):
 *
 *   PUT    /api/settings/:category/:key/entries/:entry[/:subEntry]
 *   DELETE /api/settings/:category/:key/entries/:entry[/:subEntry]
 *
 * Each window writes only its own entry, so two saves of different entries,
 * even concurrent ones, both survive. Also covers pruning thread-summary-model
 * overrides for threads that no longer exist.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { getDb, Threads } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import settingsRouter from '@server/routes/settings';
import { settingsService } from '@server/services/settings';
import { cache } from '@server/services/settings/cache';
import { agentSettings } from '@server/services/settings/categories/agent';
import { defineCategory } from '@server/services/settings/defineSetting';
import {
  pruneOrphanedThreadSummaryModelOverrides,
  pruneThreadSummaryModelOverrides,
} from '@server/services/settings/threadSummaryOverridePrune';

const TEST_CATEGORY = 'test_settings_entries';
const RefSchema = z.object({ modelId: z.string().min(1) });

const testDefs = defineCategory(TEST_CATEGORY, {
  byAgent: {
    key: 'by_agent',
    schema: z.record(z.string(), RefSchema),
    default: {},
    description: 'a test map keyed by agent',
  },
  byThread: {
    key: 'by_thread',
    schema: z.record(z.string(), z.record(z.string(), RefSchema)),
    default: {},
    description: 'a test map keyed by thread then agent',
  },
  flag: {
    key: 'flag',
    schema: z.boolean(),
    default: false,
    description: 'a test scalar',
  },
});

const THREAD_LIVE = 'thread-test-settings-entries-live';
const THREAD_GONE = 'thread-test-settings-entries-gone';

async function cleanupDb(): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM public.settings WHERE category = $1`, [TEST_CATEGORY]);
  await db.query(
    `DELETE FROM public.settings WHERE category = 'agent' AND key = 'thread_summary_model_overrides'`
  );
  await db.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_LIVE]);
  await db.query(`DELETE FROM public.nodes WHERE id = $1`, [THREAD_LIVE]);
  cache.__clearForTests();
}

let app: express.Application;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  app.use(errorHandler);
});

const entryUrl = (key: string, ...path: string[]) =>
  `/api/settings/${TEST_CATEGORY}/${key}/entries/${path.map(encodeURIComponent).join('/')}`;

describe('map entry writes', () => {
  beforeEach(cleanupDb);
  afterAll(cleanupDb);

  it('sets one entry and returns the whole resulting map', async () => {
    const res = await request(app)
      .put(entryUrl('by_agent', 'test-agent-a'))
      .send({ value: { modelId: 'model-a' } });
    expect(res.status).toBe(200);
    expect(res.body.data.value).toEqual({ 'test-agent-a': { modelId: 'model-a' } });
  });

  it('keeps entries written by another window', async () => {
    await request(app)
      .put(entryUrl('by_agent', 'test-agent-a'))
      .send({ value: { modelId: 'model-a' } });
    const res = await request(app)
      .put(entryUrl('by_agent', 'test-agent-b'))
      .send({ value: { modelId: 'model-b' } });
    expect(res.body.data.value).toEqual({
      'test-agent-a': { modelId: 'model-a' },
      'test-agent-b': { modelId: 'model-b' },
    });
  });

  it('concurrent writes of different entries both survive', async () => {
    const writes = Array.from({ length: 6 }, (_, i) =>
      request(app)
        .put(entryUrl('by_thread', 'thread-1', `test-agent-${i}`))
        .send({ value: { modelId: `model-${i}` } })
    );
    const results = await Promise.all(writes);
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));

    cache.__clearForTests();
    const stored = await settingsService.read(testDefs.byThread);
    expect(Object.keys(stored['thread-1'] ?? {}).sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `test-agent-${i}`)
    );
  });

  it('removes one nested entry and drops the parent map it leaves empty', async () => {
    await request(app)
      .put(entryUrl('by_thread', 'thread-1', 'test-agent-a'))
      .send({ value: { modelId: 'model-a' } });
    await request(app)
      .put(entryUrl('by_thread', 'thread-2', 'test-agent-a'))
      .send({ value: { modelId: 'model-a' } });

    const res = await request(app).delete(entryUrl('by_thread', 'thread-1', 'test-agent-a'));
    expect(res.status).toBe(200);
    expect(res.body.data.value).toEqual({ 'thread-2': { 'test-agent-a': { modelId: 'model-a' } } });
  });

  it('removing a missing entry is a no-op, not an error', async () => {
    const res = await request(app).delete(entryUrl('by_agent', 'test-agent-missing'));
    expect(res.status).toBe(200);
    expect(res.body.data.value).toEqual({});
  });

  it('rejects an entry that fails the schema and leaves the map unchanged', async () => {
    await request(app)
      .put(entryUrl('by_agent', 'test-agent-a'))
      .send({ value: { modelId: 'model-a' } });
    const res = await request(app)
      .put(entryUrl('by_agent', 'test-agent-b'))
      .send({ value: { modelId: '' } });
    expect(res.status).toBe(400);

    cache.__clearForTests();
    const rows = await getDb().query<{ value: unknown }>(
      `SELECT value FROM public.settings WHERE category = $1 AND key = 'by_agent'`,
      [TEST_CATEGORY]
    );
    expect(rows.rows[0]?.value).toEqual({ 'test-agent-a': { modelId: 'model-a' } });
  });

  it('rejects prototype keys and scalar settings', async () => {
    const proto = await request(app)
      .put(entryUrl('by_agent', '__proto__'))
      .send({ value: { modelId: 'model-a' } });
    expect(proto.status).toBe(400);

    const scalar = await request(app)
      .put(entryUrl('flag', 'test-agent-a'))
      .send({ value: { modelId: 'model-a' } });
    expect(scalar.status).toBe(400);

    const missingValue = await request(app).put(entryUrl('by_agent', 'test-agent-a')).send({});
    expect(missingValue.status).toBe(400);
  });

  it('is 404 for an unknown setting', async () => {
    const res = await request(app)
      .put(entryUrl('does_not_exist', 'test-agent-a'))
      .send({ value: { modelId: 'model-a' } });
    expect(res.status).toBe(404);
  });
});

describe('thread summary-model override pruning', () => {
  beforeEach(cleanupDb);
  afterAll(cleanupDb);

  const ref = { providerId: 'ollama', modelId: 'test-model' };

  it('drops the entries of given thread ids and nothing else', async () => {
    await settingsService.write(agentSettings.threadSummaryModelOverrides, {
      'thread-a': { 'test-agent-a': ref },
      'thread-b': { 'test-agent-a': ref },
    });
    await expect(pruneThreadSummaryModelOverrides(['thread-a', 'thread-x'])).resolves.toBe(true);
    await expect(pruneThreadSummaryModelOverrides(['thread-x'])).resolves.toBe(false);
    await expect(settingsService.read(agentSettings.threadSummaryModelOverrides)).resolves.toEqual({
      'thread-b': { 'test-agent-a': ref },
    });
  });

  it('drops entries for threads that no longer exist', async () => {
    await Threads.create({ id: THREAD_LIVE, title: 'settings entries live thread' });
    await settingsService.write(agentSettings.threadSummaryModelOverrides, {
      [THREAD_LIVE]: { 'test-agent-a': ref },
      [THREAD_GONE]: { 'test-agent-a': ref },
    });
    await expect(pruneOrphanedThreadSummaryModelOverrides()).resolves.toEqual([THREAD_GONE]);
    await expect(settingsService.read(agentSettings.threadSummaryModelOverrides)).resolves.toEqual({
      [THREAD_LIVE]: { 'test-agent-a': ref },
    });
  });

  it('an entry write to the thread map prunes deleted threads on the way', async () => {
    await Threads.create({ id: THREAD_LIVE, title: 'settings entries live thread' });
    await settingsService.write(agentSettings.threadSummaryModelOverrides, {
      [THREAD_GONE]: { 'test-agent-a': ref },
    });
    const res = await request(app)
      .put(`/api/settings/agent/thread_summary_model_overrides/entries/${THREAD_LIVE}/test-agent-a`)
      .send({ value: ref });
    expect(res.status).toBe(200);
    cache.__clearForTests();
    await expect(settingsService.read(agentSettings.threadSummaryModelOverrides)).resolves.toEqual({
      [THREAD_LIVE]: { 'test-agent-a': ref },
    });
  });
});
