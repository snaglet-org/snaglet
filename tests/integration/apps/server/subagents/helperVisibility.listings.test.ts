/**
 * Subagent helpers never appear in listings or pickers, against the
 * real database: the archive drawer and its counts, the archived-node tool,
 * the Database relation pickers (thread, agent, member),
 * the workspace content gauge, and agent_recent_activity's name lookup.
 * A helper thread carries its parent's project, so archiving the project
 * archives it too — and it still is not listed.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Agents, Members, Nodes, Threads, closeDatabase, getDb, transaction } from '@snaglet/db';
import { TableReferences } from '@snaglet/db/tables/table_references';
import type { TableReferenceKind } from '@snaglet/shared/types';
import { errorHandler } from '@server/middleware';
import archiveRouter from '@server/routes/archive';
import membersRouter from '@server/domains/members/members.routes';
import listArchived from '@server/services/ToolService/handlers/search/listArchived';
import agentRecentActivity from '@server/services/ToolService/handlers/agents/agentRecentActivity';
import {
  AGENT_ID,
  AGENT_NAME,
  HELPER_AGENT_ID,
  HELPER_THREAD_ID,
  PROJECT_ID,
  THREAD_ID,
  WORD,
  seedHelperWorkspace,
} from './helperFixture';

const SECOND_HELPER_AGENT_ID = 'subagent-22222222-2222-4222-8222-222222222222';
const SECOND_HELPER_NAME = 'Test Helper B';
const SECOND_HELPER_THREAD_ID = 'thread-3333333333333-ccccccccc';
const LATER_THREAD_ID = 'thread-4444444444444-ddddddddd';

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/archive', archiveRouter);
  app.use('/api/members', membersRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Application;

describe('subagent helpers stay out of listings and pickers', () => {
  beforeAll(async () => {
    await seedHelperWorkspace();
    await Agents.create({
      id: SECOND_HELPER_AGENT_ID,
      name: SECOND_HELPER_NAME,
      role: 'subagent',
      parentAgentId: AGENT_ID,
    });
    app = makeApp();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('GET /api/members still resolves a helper, for the createdBy name on a doc it wrote', async () => {
    const [agentMember, helperMember] = await Promise.all([
      Members.ensureForAgent(AGENT_ID),
      Members.ensureForAgent(HELPER_AGENT_ID),
    ]);
    const res = await request(app).get('/api/members');
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toContain(agentMember.id);
    expect(ids).toContain(helperMember.id);
  });

  describe('Database relation pickers', () => {
    it('search offers the visible thread, the real agent and its member only', async () => {
      const threads = await TableReferences.search({ kind: 'thread', q: WORD });
      expect(threads.results.map((row) => row.id)).toEqual([THREAD_ID]);

      const agents = await TableReferences.search({ kind: 'agent', q: AGENT_NAME });
      expect(agents.results.map((row) => row.id)).toEqual([AGENT_ID]);

      const agentMember = await Members.ensureForAgent(AGENT_ID);
      const members = await TableReferences.search({ kind: 'member', q: AGENT_NAME });
      expect(members.results.map((row) => row.id)).toEqual([agentMember.id]);
      const helperMembers = await TableReferences.search({
        kind: 'member',
        q: SECOND_HELPER_NAME,
      });
      expect(helperMembers.results).toEqual([]);
    });

    it('a name never resolves to a helper', async () => {
      expect(await TableReferences.findByTitle('agent', AGENT_NAME, 5)).toEqual([
        { id: AGENT_ID, title: AGENT_NAME },
      ]);
      expect(await TableReferences.findByTitle('agent', SECOND_HELPER_NAME, 5)).toEqual([]);
    });

    it('a stored helper link reads as unavailable and a new one is refused as missing', async () => {
      const related = await TableReferences.readItems(
        new Map<TableReferenceKind, string[]>([
          ['thread', [THREAD_ID, HELPER_THREAD_ID]],
          ['agent', [AGENT_ID, HELPER_AGENT_ID]],
        ])
      );
      expect(Object.keys(related.thread ?? {})).toEqual([THREAD_ID]);
      expect(Object.keys(related.agent ?? {})).toEqual([AGENT_ID]);

      await expect(
        transaction((tx) =>
          TableReferences.assertLinkable('thread', [HELPER_THREAD_ID], 'Related', tx)
        )
      ).rejects.toThrow(`Related: there is no thread ${HELPER_THREAD_ID}.`);
      await expect(
        transaction((tx) => TableReferences.assertLinkable('agent', [HELPER_AGENT_ID], 'Owner', tx))
      ).rejects.toThrow(`Owner: there is no agent ${HELPER_AGENT_ID}.`);
    });
  });

  it('the workspace content gauge counts visible threads only', async () => {
    const before = await Nodes.countWorkspaceContent();
    await Threads.create({
      id: SECOND_HELPER_THREAD_ID,
      title: 'Second helper thread',
      parentThreadId: THREAD_ID,
    });
    expect((await Nodes.countWorkspaceContent()).threads).toBe(before.threads);
    await Threads.create({ id: LATER_THREAD_ID, title: 'Later visible thread' });
    expect((await Nodes.countWorkspaceContent()).threads).toBe(before.threads + 1);
  });

  it('agent_recent_activity never resolves a helper by name', async () => {
    const raw = await agentRecentActivity({ agent_name: SECOND_HELPER_NAME }, {});
    expect(JSON.parse(String(raw))).toMatchObject({
      error: `No agent matched '${SECOND_HELPER_NAME}'.`,
    });
  });

  describe('archive', () => {
    it('the archive preview counts the visible thread and its message only', async () => {
      const res = await request(app).get(`/api/archive/counts/${PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.data.counts).toMatchObject({ threads: 1, messages: 1 });
    });

    it('archiving the project archives the helper thread, which is still never listed', async () => {
      await getDb().query(
        `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
        [PROJECT_ID]
      );
      const { rows } = await getDb().query<{ archived: boolean }>(
        `SELECT archived FROM public.nodes WHERE id = $1`,
        [HELPER_THREAD_ID]
      );
      expect(rows[0]?.archived).toBe(true);

      const res = await request(app).get('/api/archive');
      expect(res.status).toBe(200);
      const listed = [
        ...(res.body.data.roots as Array<{ id: string }>),
        ...(res.body.data.children as Array<{ id: string }>),
      ].map((row) => row.id);
      expect(listed).toEqual(expect.arrayContaining([PROJECT_ID, THREAD_ID]));
      expect(listed).not.toContain(HELPER_THREAD_ID);

      const tool = await listArchived({});
      const toolIds = tool.items.map((item) => item.id);
      expect(toolIds).toEqual(expect.arrayContaining([PROJECT_ID, THREAD_ID]));
      expect(toolIds).not.toContain(HELPER_THREAD_ID);
    });
  });
});
