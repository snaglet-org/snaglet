/**
 * GET /api/members against the real DB, with the production error middleware:
 * the members↔agents/users join runs without SQL error and a seeded agent
 * member surfaces as { id, kind: 'agent', displayName }. The doc assignee
 * picker needs member ids with readable names, since `assigned_to` stores a
 * `members.id`.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, Agents, Members } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import membersRouter from '@server/domains/members/members.routes';

const AGENT_ID = 'agent-members-route-test';
const AGENT_NAME = 'Members Route Test Agent';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/members', membersRouter);
  app.use(errorHandler);
  return app;
}

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.members WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
}

let app: express.Application;
let memberId: string;

describe('GET /api/members', () => {
  beforeAll(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_ID, name: AGENT_NAME });
    const member = await Members.ensureForAgent(AGENT_ID);
    memberId = member.id;
    app = makeApp();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('returns an array of { id, kind, displayName }', async () => {
    const res = await request(app).get('/api/members');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const row of res.body.data as Array<Record<string, unknown>>) {
      expect(typeof row.id).toBe('string');
      expect(['agent', 'user']).toContain(row.kind);
      expect(typeof row.displayName).toBe('string');
    }
  });

  it('surfaces the seeded agent member with its resolved name', async () => {
    const res = await request(app).get('/api/members');
    const rows = res.body.data as Array<{ id: string; kind: string; displayName: string }>;
    const seeded = rows.find((r) => r.id === memberId);
    expect(seeded).toBeDefined();
    expect(seeded?.kind).toBe('agent');
    expect(seeded?.displayName).toBe(AGENT_NAME);
  });
});
