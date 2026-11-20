/**
 * The ghost system actor runs on a fixed allow list, against the real
 * database, tool rows and tool registry. A hook whose event carries no agent
 * runs as ghost through a child-dispatch token bound to `ghost`, so ghost's
 * null access mode must not read as `all`. Refused calls here are harmless (an echo, a thread create that never
 * runs), so a broken gate could not change anything.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Agents, closeDatabase } from '@snaglet/db';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import { errorHandler } from '@server/middleware';
import { mintChildDispatchToken, toolDispatchAuthMiddleware } from '@server/middleware/panelAuth';
import executionRoutes from '@server/domains/tools/routes/execution.routes';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/tools', toolDispatchAuthMiddleware, executionRoutes);
  app.use(errorHandler);
  return app;
}

let app: express.Application;
let token: string;

const asGhost = (name: string, input: Record<string, unknown>) =>
  request(app)
    .post('/api/tools/execute')
    .set('X-Snaglet-Child-Dispatch-Token', token)
    .send({ name, input });

describe('ghost (agentless hooks) tool access', () => {
  beforeAll(async () => {
    await toolRegistry.load();
    const sync = await toolRegistry.syncToDatabase();
    expect(sync.errors).toEqual([]);
    // The seed writes ghost on a fresh install; a test clone may not have it.
    if (!(await Agents.findById(GHOST_AGENT_ID))) {
      await Agents.create({ id: GHOST_AGENT_ID, name: 'ghost', role: 'System' });
    }
    token = mintChildDispatchToken(GHOST_AGENT_ID, 'test-hook');
    app = makeApp();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('cannot call shell (no command runs)', async () => {
    const res = await asGhost('shell', { op: 'run', cmd: 'echo ghost-shell-probe' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/Blocked by tool-access policy/);
  });

  it.each([
    ['file', { op: 'read', path: '/etc/hosts' }],
    ['agent', { op: 'list' }],
    ['database_execute', { sql: 'SELECT 1' }],
    ['memory', { op: 'search', query: 'x' }],
  ])('cannot call %s', async (name, input) => {
    expect((await asGhost(name, input)).status).toBe(403);
  });

  it('cannot create, update or delete threads: only send and read are listed', async () => {
    const res = await asGhost('thread', { op: 'create', title: 'ghost probe' });
    expect(res.status).toBe(403);
  });

  it('can still use what the installed hooks use', async () => {
    // loop-dispatch's calls: table query/read/write, thread read/send.
    const read = await asGhost('table', { op: 'read' });
    expect(read.status).toBe(200);
    const tableQuery = await asGhost('table', { op: 'query', sql: 'SELECT 1 AS one' });
    expect(tableQuery.status).not.toBe(403);
    const write = await asGhost('table', {
      op: 'write',
      table: 'table-does-not-exist',
      update: [{ id: '00000000-0000-0000-0000-000000000000', values: {} }],
    });
    expect(write.status).not.toBe(403);
    const query = await asGhost('database_query', { sql: 'SELECT 1 AS one' });
    expect(query.status).toBe(200);
    // thread send/read pass the gate; an unknown thread is the handler's
    // answer (a tool error), not a policy 403.
    const send = await asGhost('thread', {
      op: 'send',
      id: 'thread-does-not-exist',
      content: 'x',
    });
    expect(send.status).not.toBe(403);
    const threadRead = await asGhost('thread', { op: 'read', id: 'thread-does-not-exist' });
    expect(threadRead.status).not.toBe(403);
  });
});
