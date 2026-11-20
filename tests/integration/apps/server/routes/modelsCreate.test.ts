/**
 * POST /api/models refuses bad input before the insert: an unknown provider
 * is a 404 (not a foreign-key 500) and a non-integer token count a 400 (not
 * a failed integer cast). Database access is real;
 * the provider is one the fresh install seeds.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import modelsRouter from '@server/routes/models';

const MODEL_ID = 'test-model-create-route';

const app = express();
app.use(express.json());
app.use('/api/models', modelsRouter);
app.use(errorHandler);

let providerId = '';

async function cleanup(): Promise<void> {
  await getDb().query('DELETE FROM public.models WHERE model_id = $1', [MODEL_ID]);
}

describe('POST /api/models input validation', () => {
  beforeAll(async () => {
    await cleanup();
    const { rows } = await getDb().query<{ id: string }>(
      'SELECT id FROM public.providers ORDER BY id LIMIT 1'
    );
    providerId = rows[0]!.id;
  });
  afterAll(cleanup);

  it('404s an unknown provider', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ providerId: 'provider-missing', modelId: MODEL_ID })
      .expect(404);
    expect(res.body.error.message).toMatch(/provider-missing/);
  });

  it.each([
    ['contextWindowTokens', 'lots'],
    ['maxOutputTokens', -1],
  ])('400s a bad %s', async (field, value) => {
    const res = await request(app)
      .post('/api/models')
      .send({ providerId, modelId: MODEL_ID, [field]: value })
      .expect(400);
    expect(res.body.error.message).toMatch(new RegExp(field));
  });

  it('creates a chat model even when an old client sends embedding fields', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ providerId, modelId: MODEL_ID, type: 'embedding', dimensions: 768 })
      .expect(201);
    expect(res.body.data).toMatchObject({ modelId: MODEL_ID, type: 'llm', dimensions: null });
    await cleanup();
  });

  it('leaves the built-in embedding row an active 768-dimension embedding model', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({
        providerId: 'local-onnx',
        modelId: 'nomic-embed-text-v1.5',
        type: 'llm',
        dimensions: 1,
      })
      .expect(201);
    expect(res.body.data).toMatchObject({ type: 'embedding', dimensions: 768, isActive: true });
    const { rows } = await getDb().query<{
      type: string;
      dimensions: number | null;
      is_active: boolean;
    }>(
      `SELECT type, dimensions, is_active FROM public.models
        WHERE provider_id = 'local-onnx' AND model_id = 'nomic-embed-text-v1.5'`
    );
    expect(rows).toEqual([{ type: 'embedding', dimensions: 768, is_active: true }]);
  });

  it('still creates a model with valid input', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ providerId, modelId: MODEL_ID, contextWindowTokens: 8000 })
      .expect(201);
    expect(res.body.data).toMatchObject({ providerId, modelId: MODEL_ID });
  });
});
