/**
 * Limits a person sets are theirs: PATCH /api/models/:id and POST
 * /api/models stamp `metadata.limitsEditedBy = 'user'` on the row (keeping
 * the row's other metadata), so a later discovery pass never replaces those
 * limits with provider-reported ones. A rename alone stamps nothing.
 * Database access is real.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import modelsRouter from '@server/routes/models';

const MODEL_ID = 'test-model-limit-edits';

const app = express();
app.use(express.json());
app.use('/api/models', modelsRouter);
app.use(errorHandler);

let providerId = '';

async function cleanup(): Promise<void> {
  await getDb().query('DELETE FROM public.models WHERE model_id = $1', [MODEL_ID]);
}

async function readRow(): Promise<{
  id: string;
  metadata: Record<string, unknown>;
  max_output_tokens: number | null;
}> {
  const { rows } = await getDb().query<{
    id: string;
    metadata: Record<string, unknown>;
    max_output_tokens: number | null;
  }>('SELECT id, metadata, max_output_tokens FROM public.models WHERE model_id = $1', [MODEL_ID]);
  return rows[0]!;
}

describe('model limits a person edits', () => {
  beforeAll(async () => {
    await cleanup();
    const { rows } = await getDb().query<{ id: string }>(
      `SELECT id FROM public.providers WHERE type = 'llm' ORDER BY id LIMIT 1`
    );
    providerId = rows[0]!.id;
  });
  afterAll(cleanup);

  it('creates a model with no limits unstamped', async () => {
    await request(app).post('/api/models').send({ providerId, modelId: MODEL_ID }).expect(201);
    const row = await readRow();
    expect(row.metadata).not.toHaveProperty('limitsEditedBy');
  });

  it('does not stamp a rename', async () => {
    const { id } = await readRow();
    await request(app).patch(`/api/models/${id}`).send({ displayName: 'Renamed' }).expect(200);
    expect((await readRow()).metadata).not.toHaveProperty('limitsEditedBy');
  });

  it('stamps an edited limit and keeps the row’s other metadata', async () => {
    const { id } = await readRow();
    await getDb().query(
      `UPDATE public.models SET metadata = '{"lifecycle": "legacy"}'::jsonb WHERE id = $1`,
      [id]
    );
    await request(app).patch(`/api/models/${id}`).send({ maxOutputTokens: 64_000 }).expect(200);
    const row = await readRow();
    expect(row.max_output_tokens).toBe(64_000);
    expect(row.metadata).toEqual({ lifecycle: 'legacy', limitsEditedBy: 'user' });
  });

  it('stamps limits given when a model is added again, keeping its other metadata', async () => {
    await getDb().query(
      `UPDATE public.models SET metadata = '{"lifecycle": "legacy"}'::jsonb WHERE model_id = $1`,
      [MODEL_ID]
    );
    await request(app)
      .post('/api/models')
      .send({ providerId, modelId: MODEL_ID, contextWindowTokens: 500_000 })
      .expect(201);
    expect((await readRow()).metadata).toEqual({ lifecycle: 'legacy', limitsEditedBy: 'user' });
  });
});
