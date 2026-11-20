/**
 * PATCH /api/containers/:id fires the `container:update` hook only when the
 * body changes something: an empty body writes nothing, so a hook listening
 * for container updates must not run for it. Database access is real; the
 * hook bus is spied.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';

const mockHookEmit = jest.fn();
jest.mock('@server/services/HookService', () => ({
  hooks: { emit: (...args: unknown[]) => mockHookEmit(...args) },
}));

import containersRouter from '@server/domains/containers/containers.routes';

const CONTAINER = 'container-update-hook-test';

const app = express();
app.use(express.json());
app.use('/api/containers', containersRouter);
app.use(errorHandler);

async function cleanup(): Promise<void> {
  await getDb().query('DELETE FROM public.nodes WHERE id = $1', [CONTAINER]);
}

describe('PATCH /api/containers/:id container:update hook', () => {
  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: CONTAINER, name: 'Hook test folder' });
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(cleanup);

  it('stays quiet for a body that changes nothing', async () => {
    const res = await request(app).patch(`/api/containers/${CONTAINER}`).send({}).expect(200);
    expect(res.body.data.name).toBe('Hook test folder');
    expect(mockHookEmit).not.toHaveBeenCalled();
  });

  it('fires for a rename, naming the changed field', async () => {
    await request(app).patch(`/api/containers/${CONTAINER}`).send({ name: 'Renamed' }).expect(200);
    expect(mockHookEmit).toHaveBeenCalledWith('container:update', {
      id: CONTAINER,
      changed: ['name'],
    });
  });
});
