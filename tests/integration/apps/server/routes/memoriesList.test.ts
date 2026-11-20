/**
 * GET /api/memories clamps its page bounds, so a malformed or negative
 * limit/offset never reaches SQL as `LIMIT NaN` / `LIMIT -1`.
 * Database access is real; the placeholder agent id owns no memories.
 */

import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '@server/middleware';
import memoriesRouter from '@server/domains/memories/memories.routes';

const app = express();
app.use(express.json());
app.use('/api/memories', memoriesRouter);
app.use(errorHandler);

describe('GET /api/memories page bounds', () => {
  it.each(['limit=abc&offset=xyz', 'limit=-1&offset=-5', 'limit=1.5&offset=2.5'])(
    'answers 200 for %s',
    async (query) => {
      const res = await request(app).get(`/api/memories?agentId=test-agent-a&${query}`).expect(200);
      expect(res.body.data).toEqual([]);
    }
  );

  it('still requires agentId', async () => {
    await request(app).get('/api/memories?limit=10').expect(400);
  });
});
