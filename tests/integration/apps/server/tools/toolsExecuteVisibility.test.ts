/**
 * POST /api/tools/execute applies the tool-visibility gate chat runs apply,
 * against the real database, tool rows and tool registry: an
 * allow-list agent can run only the tools its list names, deny-list agents
 * keep their denies, agents in `all` mode are unchanged, and rule entries
 * naming a tool's display name read as every other path reads them. The
 * refused calls are read-only or a harmless echo, so a broken
 * gate could not change anything here.
 */

import os from 'os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Agents, closeDatabase } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import {
  getPanelToken,
  mintChildDispatchToken,
  toolDispatchAuthMiddleware,
} from '@server/middleware/panelAuth';
import executionRoutes from '@server/domains/tools/routes/execution.routes';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';

const AGENT_ID = 'test-agent-a';

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/tools', toolDispatchAuthMiddleware, executionRoutes);
  app.use(errorHandler);
  return app;
}

let app: express.Application;

async function setAccess(
  mode: 'all' | 'allow_list' | 'deny_list',
  list: string[] = []
): Promise<void> {
  await Agents.update(AGENT_ID, {
    toolAccessMode: mode,
    toolAccessAllowList: mode === 'allow_list' ? list : [],
    toolAccessDenyList: mode === 'deny_list' ? list : [],
  });
}

const asAgent = (name: string, input: Record<string, unknown>) =>
  request(app)
    .post('/api/tools/execute')
    .set('X-Snaglet-Panel-Token', getPanelToken())
    .send({ name, input, agent_id: AGENT_ID });

const resolveTmp = () => asAgent('resolve_path', { domain: 'filesystem', path: os.tmpdir() });

describe('POST /api/tools/execute — tool visibility (real catalog)', () => {
  beforeAll(async () => {
    await toolRegistry.load();
    // This file's database clone starts with no tool rows; write the real
    // catalog the way boot does.
    const sync = await toolRegistry.syncToDatabase();
    expect(sync.errors).toEqual([]);
    await Agents.create({ id: AGENT_ID, name: 'Test Agent A', role: 'test' });
    app = makeApp();
  });

  beforeEach(async () => {
    await setAccess('all');
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('allow-list agent', () => {
    beforeEach(async () => {
      await setAccess('allow_list', ['resolve_path']);
    });

    it('is refused an unguarded tool its list does not name', async () => {
      const res = await asAgent('orient', {});
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe(
        "Blocked by tool-access policy: `orient` is not in this agent's tool list."
      );
    });

    it('is refused it through a hook child bound to the agent too', async () => {
      const res = await request(app)
        .post('/api/tools/execute')
        .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken(AGENT_ID, 'test-hook'))
        .send({ name: 'orient', input: {} });
      expect(res.status).toBe(403);
    });

    it('runs the tool its list names', async () => {
      const res = await resolveTmp();
      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);
    });

    it('runs the tool its list names by exact display name, not another case', async () => {
      await setAccess('allow_list', ['Resolve Path']);
      expect((await resolveTmp()).status).toBe(200);
      await setAccess('allow_list', ['resolve path']);
      expect((await resolveTmp()).status).toBe(403);
    });

    it('reaches no unlisted target through action either (the executor gateway)', async () => {
      const hidden = await asAgent('action', { tool: 'orient', params: {} });
      expect(hidden.status).toBe(200);
      expect(hidden.body.data.success).toBe(false);
      expect(hidden.body.data.error).toMatch(/unavailable or not permitted/i);

      const listed = await asAgent('action', {
        tool: 'resolve_path',
        params: { domain: 'filesystem', path: os.tmpdir() },
      });
      expect(listed.body.data.success).toBe(true);
    });
  });

  describe('deny-list agent', () => {
    it('keeps its denies and runs everything else', async () => {
      await setAccess('deny_list', ['orient']);
      expect((await asAgent('orient', {})).status).toBe(403);
      expect((await resolveTmp()).status).toBe(200);
    });

    it.each(['Orient', 'ORIENT'])(
      'a deny naming the display name (%s) blocks it',
      async (entry) => {
        await setAccess('deny_list', [entry]);
        expect((await asAgent('orient', {})).status).toBe(403);
      }
    );

    it('a deny naming Shell blocks shell (no command runs)', async () => {
      await setAccess('deny_list', ['Shell']);
      const res = await asAgent('shell', { op: 'run', cmd: 'echo snaglet-visibility-probe' });
      expect(res.status).toBe(403);
    });
  });

  // An agent id with no agent row behind it is refused, never run
  // ungated. orient is read-only, so a broken gate could not change anything.
  describe('agent id that resolves to no agent', () => {
    it('refuses a body agent_id naming no agent', async () => {
      const res = await request(app)
        .post('/api/tools/execute')
        .set('X-Snaglet-Panel-Token', getPanelToken())
        .send({ name: 'orient', input: {}, agent_id: 'test-agent-missing' });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe(
        'Blocked by tool-access policy: no agent `test-agent-missing` exists (deleted, or never created), so `orient` cannot run as it.'
      );
    });

    it('refuses a child-dispatch token bound to an agent deleted after it was issued', async () => {
      const doomed = 'test-agent-b';
      await Agents.create({ id: doomed, name: 'Test Agent B', role: 'test' });
      const token = mintChildDispatchToken(doomed, 'test-hook');
      const before = await request(app)
        .post('/api/tools/execute')
        .set('X-Snaglet-Child-Dispatch-Token', token)
        .send({ name: 'orient', input: {} });
      expect(before.status).toBe(200);

      expect(await Agents.delete(doomed)).toBe(true);
      const after = await request(app)
        .post('/api/tools/execute')
        .set('X-Snaglet-Child-Dispatch-Token', token)
        .send({ name: 'orient', input: {} });
      expect(after.status).toBe(403);
      expect(after.body.error.message).toContain(`no agent \`${doomed}\` exists`);
    });

    it('still runs a call with no agent id (a person or a local script)', async () => {
      const res = await request(app)
        .post('/api/tools/execute')
        .set('X-Snaglet-Panel-Token', getPanelToken())
        .send({ name: 'orient', input: {} });
      expect(res.status).toBe(200);
    });
  });

  describe('agent in all mode', () => {
    it('still honors a bare deny left on its row, as chat does', async () => {
      await Agents.update(AGENT_ID, { toolAccessMode: 'all', toolAccessDenyList: ['Orient'] });
      expect((await asAgent('orient', {})).status).toBe(403);
      expect((await resolveTmp()).status).toBe(200);
    });

    it('is unchanged: tools no list names still run', async () => {
      expect((await resolveTmp()).status).toBe(200);
      const schema = await asAgent('get_tool_schema', { tool: 'resolve_path' });
      expect(schema.status).toBe(200);
      expect(schema.body.data.success).toBe(true);
    });
  });
});
