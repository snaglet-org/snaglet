/**
 * Skill assignments against the real database and REST
 * routes: general defaults, per-thread mode + picks, thread isolation (a
 * pick in one thread never leaks into another), skills working in any project, unknown
 * ids refused without partial writes, cascade on skill delete (including a
 * vanished skill folder deleting its row, after a grace period that lets an
 * editor's remove-then-write save keep the id and assignments).
 */

import { readFileSync } from 'fs';
import { mkdtemp, rm, unlink, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, getDb, SkillAssignments, SkillRegistry, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { errorHandler } from '@server/middleware';
import agentsRouter from '@server/domains/agents/agents.routes';
import { registerParticipantRoutes } from '@server/domains/threads/handlers/participantHandlers';
import {
  deleteSkillFolderRow,
  SkillRegistryService,
} from '@server/services/skills/SkillRegistryService';

const PREFIX = 'skill-asg-it';
const AGENT = `agent-${PREFIX}`;
const OTHER_AGENT = `agent-${PREFIX}-other`;
const T1 = `thread-${PREFIX}-1`;
const T2 = `thread-${PREFIX}-2`;
const TP = `thread-${PREFIX}-proj`;
const PROJECT = `container-${PREFIX}-proj`;

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentsRouter);
  const threads = express.Router();
  registerParticipantRoutes(threads);
  app.use('/api/threads', threads);
  app.use(errorHandler);
  return app;
}

async function addSkill(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const row = { scope: 'personal', project_id: null, status: 'valid', ...extra };
  await getDb().query(
    `INSERT INTO public.skill_registry (id, scope, project_id, slug, source_path, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, row.scope, row.project_id, id.replace(/^skill-/, ''), `/x/${id}`, row.status]
  );
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM public.skill_registry WHERE id LIKE 'skill-${PREFIX}%'`);
  await db.query(`DELETE FROM public.threads WHERE id LIKE $1`, [`thread-${PREFIX}%`]);
  await db.query(`DELETE FROM public.agents WHERE id LIKE $1`, [`agent-${PREFIX}%`]);
}

const S = (n: string) => `skill-${PREFIX}-${n}`;
let app: express.Application;

beforeAll(async () => {
  await cleanup();
  await Users.getOrCreateLocalUser();
  await Agents.create({ id: AGENT, name: `${PREFIX}-agent` });
  await Agents.create({ id: OTHER_AGENT, name: `${PREFIX}-other` });
  await Containers.create({ id: PROJECT, name: `${PREFIX} project`, category: 'project' });
  await Threads.create({ id: T1, title: `${PREFIX} 1` });
  await Threads.create({ id: T2, title: `${PREFIX} 2` });
  await Threads.create({ id: TP, title: `${PREFIX} proj`, projectId: PROJECT });
  for (const t of [T1, T2, TP]) {
    await ThreadParticipants.addParticipant({ threadId: t, agentId: AGENT });
  }
  await ThreadParticipants.addParticipant({ threadId: T1, agentId: OTHER_AGENT });
  app = makeApp();
});

beforeEach(async () => {
  await getDb().query(`DELETE FROM public.skill_registry WHERE id LIKE 'skill-${PREFIX}%'`);
  await getDb().query(
    `UPDATE public.thread_participants SET skill_mode = 'inherit' WHERE thread_id LIKE $1`,
    [`thread-${PREFIX}%`]
  );
  for (const n of ['a', 'b', 'c']) await addSkill(S(n));
  await addSkill(S('bad'), { status: 'invalid' });
});

describe('skill assignments', () => {
  afterAll(cleanup);

  it('defaults to inherit with no skills', async () => {
    const res = await request(app).get(`/api/threads/${T1}/participants/${AGENT}/skills`);
    expect(res.status).toBe(200);
    expect(res.body.data ?? res.body).toMatchObject({
      mode: 'inherit',
      generalSkillIds: [],
      threadSkillIds: [],
      resolved: { effective: [], dropped: [] },
    });
  });

  it('PUT /agents/:id/skills replaces the general set; GET reads it back', async () => {
    let res = await request(app)
      .put(`/api/agents/${AGENT}/skills`)
      .send({ skillIds: [S('a'), S('b')] });
    expect(res.status).toBe(200);
    res = await request(app)
      .put(`/api/agents/${AGENT}/skills`)
      .send({ skillIds: [S('b'), S('c')] });
    expect((res.body.data ?? res.body).skillIds).toEqual([S('b'), S('c')]);
    res = await request(app).get(`/api/agents/${AGENT}/skills`);
    expect((res.body.data ?? res.body).skillIds).toEqual([S('b'), S('c')]);
    expect(await SkillAssignments.agentHasAny(AGENT)).toBe(true);
    expect(await SkillAssignments.agentHasAny(OTHER_AGENT)).toBe(false);
  });

  it('inherit / add / override resolve per thread, and picks never leak across threads', async () => {
    await request(app)
      .put(`/api/agents/${AGENT}/skills`)
      .send({ skillIds: [S('a')] });
    await request(app)
      .put(`/api/threads/${T1}/participants/${AGENT}/skills`)
      .send({ mode: 'add', skillIds: [S('b')] });
    await request(app)
      .put(`/api/threads/${T2}/participants/${AGENT}/skills`)
      .send({ mode: 'override', skillIds: [] });

    const eff = async (t: string, agent = AGENT) => {
      const r = await request(app).get(`/api/threads/${t}/participants/${agent}/skills`);
      return ((r.body.data ?? r.body).resolved.effective as { skill: { id: string } }[]).map(
        (e) => e.skill.id
      );
    };
    expect(await eff(T1)).toEqual([S('a'), S('b')]);
    expect(await eff(T2)).toEqual([]); // empty override = none
    expect(await eff(TP)).toEqual([S('a')]); // inherit, T1's pick absent
    expect(await eff(T1, OTHER_AGENT)).toEqual([]); // another agent in T1 is unaffected
  });

  it('drops invalid skills with reasons; skills are not per-project', async () => {
    await request(app)
      .put(`/api/agents/${AGENT}/skills`)
      .send({ skillIds: [S('a'), S('bad')] });
    const inFlat = await request(app).get(`/api/threads/${T1}/participants/${AGENT}/skills`);
    expect((inFlat.body.data ?? inFlat.body).resolved.dropped).toEqual([
      { skillId: S('bad'), origin: 'general', reason: 'invalid' },
    ]);
    // The same skill set in a project thread: every skill works in every project.
    const inProj = await request(app).get(`/api/threads/${TP}/participants/${AGENT}/skills`);
    const ids = (inProj.body.data ?? inProj.body).resolved.effective.map(
      (e: { skill: { id: string } }) => e.skill.id
    );
    expect(ids).toEqual([S('a')]);
  });

  it('unknown skill ids are refused and nothing is written (mode included)', async () => {
    const res = await request(app)
      .put(`/api/threads/${T1}/participants/${AGENT}/skills`)
      .send({ mode: 'override', skillIds: [S('a'), 'skill-does-not-exist'] });
    expect(res.status).toBe(400);
    expect(await SkillAssignments.getMode(T1, AGENT)).toBe('inherit');
    expect(await SkillAssignments.listForAgent(AGENT, T1)).toEqual([]);
    const general = await request(app)
      .put(`/api/agents/${AGENT}/skills`)
      .send({ skillIds: ['skill-does-not-exist'] });
    expect(general.status).toBe(400);
  });

  it('built-in skills cannot be assigned: their ids are ignored and never returned', async () => {
    await addSkill(S('builtin'), { scope: 'builtin' });
    // An agent with a built-in skill row already assigned.
    await SkillAssignments.replace(AGENT, null, [S('builtin'), S('a')]);
    await SkillAssignments.replace(AGENT, T1, [S('builtin')]);
    const body = (r: request.Response) => r.body.data ?? r.body;

    expect(body(await request(app).get(`/api/agents/${AGENT}/skills`)).skillIds).toEqual([S('a')]);
    const state = body(await request(app).get(`/api/threads/${T1}/participants/${AGENT}/skills`));
    expect(state.generalSkillIds).toEqual([S('a')]);
    expect(state.threadSkillIds).toEqual([]);

    // Saving the old list back (built-in included) succeeds; the built-in is dropped.
    const saved = await request(app)
      .put(`/api/agents/${AGENT}/skills`)
      .send({ skillIds: [S('builtin'), S('b')] });
    expect(saved.status).toBe(200);
    expect(body(saved).skillIds).toEqual([S('b')]);
    const thread = await request(app)
      .put(`/api/threads/${T1}/participants/${AGENT}/skills`)
      .send({ mode: 'add', skillIds: [S('builtin'), S('c')] });
    expect(thread.status).toBe(200);
    expect(body(thread)).toMatchObject({ mode: 'add', threadSkillIds: [S('c')] });
    const effective = (body(thread).resolved.effective as { skill: { id: string } }[]).map(
      (e) => e.skill.id
    );
    expect(effective).toEqual([S('b'), S('c')]);
    expect(body(thread).resolved.dropped).toEqual([]);
  });

  it('a non-participant gets 404 and nothing is written', async () => {
    const res = await request(app)
      .put(`/api/threads/${T2}/participants/${OTHER_AGENT}/skills`)
      .send({ mode: 'add', skillIds: [S('a')] });
    expect(res.status).toBe(404);
    expect(await SkillAssignments.listForAgent(OTHER_AGENT, T2)).toEqual([]);
  });

  it('rejects a bad mode and an empty body', async () => {
    const url = `/api/threads/${T1}/participants/${AGENT}/skills`;
    expect((await request(app).put(url).send({ mode: 'replace' })).status).toBe(400);
    expect((await request(app).put(url).send({})).status).toBe(400);
    expect(
      (
        await getDb()
          .query(
            `UPDATE public.thread_participants SET skill_mode = 'bogus' WHERE thread_id = $1`,
            [T1]
          )
          .catch((e: Error) => e)
      ).toString()
    ).toMatch(/check/);
  });

  it('kept skills keep their assignment row id across replace', async () => {
    const [first] = await SkillAssignments.replace(AGENT, T1, [S('a')]);
    const after = await SkillAssignments.replace(AGENT, T1, [S('a'), S('b')]);
    expect(after.find((r) => r.skillId === S('a'))?.id).toBe(first.id);
  });

  it('deleting a registry row cascades its assignments', async () => {
    await SkillAssignments.replace(AGENT, null, [S('c')]);
    await getDb().query('DELETE FROM public.skill_registry WHERE id = $1', [S('c')]);
    expect(await SkillAssignments.listForAgent(AGENT, null)).toEqual([]);
  });

  it('concurrent saves of the same set both succeed (no unique violation)', async () => {
    await SkillAssignments.replace(AGENT, T1, []);
    await SkillAssignments.replace(AGENT, null, []);
    const results = await Promise.all([
      SkillAssignments.replace(AGENT, T1, [S('a'), S('b')]),
      SkillAssignments.replace(AGENT, T1, [S('a'), S('b')]),
      SkillAssignments.replace(AGENT, null, [S('c')]),
      SkillAssignments.replace(AGENT, null, [S('c')]),
    ]);
    expect(results).toHaveLength(4);
    const thread = (await SkillAssignments.listForAgent(AGENT, T1)).map((r) => r.skillId);
    expect(thread.sort()).toEqual([S('a'), S('b')]);
    expect((await SkillAssignments.listForAgent(AGENT, null)).map((r) => r.skillId)).toEqual([
      S('c'),
    ]);
  });

  describe('leaving a thread drops that thread’s picks', () => {
    const T3 = `thread-${PREFIX}-rejoin`;

    beforeEach(async () => {
      await getDb().query('DELETE FROM public.threads WHERE id = $1', [T3]);
      await Threads.create({ id: T3, title: `${PREFIX} rejoin` });
      await ThreadParticipants.addParticipant({ threadId: T3, agentId: OTHER_AGENT });
      await SkillAssignments.replace(OTHER_AGENT, T3, [S('a')]);
      await SkillAssignments.replace(OTHER_AGENT, T1, [S('b')]); // another thread: untouched
    });

    afterEach(async () => {
      await SkillAssignments.replace(OTHER_AGENT, T1, []);
      await getDb().query('DELETE FROM public.threads WHERE id = $1', [T3]);
    });

    const rejoinAndAdd = async () => {
      await ThreadParticipants.addParticipant({ threadId: T3, agentId: OTHER_AGENT });
      const res = await request(app)
        .put(`/api/threads/${T3}/participants/${OTHER_AGENT}/skills`)
        .send({ mode: 'add' });
      expect(res.status).toBe(200);
      const body = res.body.data ?? res.body;
      expect(body.threadSkillIds).toEqual([]);
      expect(body.resolved.effective).toEqual([]);
    };

    it('removeParticipant: remove -> re-add -> set add -> no picks', async () => {
      expect(await ThreadParticipants.removeParticipant(T3, OTHER_AGENT)).toBe(true);
      expect(await SkillAssignments.listForAgent(OTHER_AGENT, T3)).toEqual([]);
      await rejoinAndAdd();
      expect((await SkillAssignments.listForAgent(OTHER_AGENT, T1)).map((r) => r.skillId)).toEqual([
        S('b'),
      ]);
    });

    it('removeById: remove -> re-add -> set add -> no picks', async () => {
      const row = (await ThreadParticipants.listByThread(T3)).find(
        (p) => p.agentId === OTHER_AGENT
      );
      expect(await ThreadParticipants.removeById(row!.id)).toBe(true);
      expect(await SkillAssignments.listForAgent(OTHER_AGENT, T3)).toEqual([]);
      await rejoinAndAdd();
      expect((await SkillAssignments.listForAgent(OTHER_AGENT, T1)).map((r) => r.skillId)).toEqual([
        S('b'),
      ]);
    });

    it('picks left without a participant row are cleared when the agent is added again', async () => {
      // The participant row goes, the picks stay.
      await getDb().query(
        `DELETE FROM public.thread_participants tp USING public.members m
          WHERE m.id = tp.member_id AND tp.thread_id = $1 AND m.agent_id = $2`,
        [T3, OTHER_AGENT]
      );
      expect(await SkillAssignments.listForAgent(OTHER_AGENT, T3)).toHaveLength(1);
      await rejoinAndAdd();
    });

    it('re-adding an existing participant (upsert) keeps its picks', async () => {
      await ThreadParticipants.addParticipant({ threadId: T3, agentId: OTHER_AGENT });
      expect((await SkillAssignments.listForAgent(OTHER_AGENT, T3)).map((r) => r.skillId)).toEqual([
        S('a'),
      ]);
    });
  });

  describe('watch-path vanish grace period', () => {
    const SLUG = `${PREFIX}-grace`;
    const GRACE_MS = 300;
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-skill-grace-'));
      await mkdir(path.join(dir, SLUG));
      await writeFile(
        path.join(dir, SLUG, 'SKILL.md'),
        '---\nname: Vanishing skill\ndescription: d\n---\nBody\n'
      );
    });

    afterEach(async () => {
      await getDb().query(`DELETE FROM public.skill_registry WHERE slug = $1`, [SLUG]);
      await rm(dir, { recursive: true, force: true });
    });

    async function assignedIds(): Promise<{ general: string[]; thread: string[] }> {
      return {
        general: (await SkillAssignments.listForAgent(AGENT, null)).map((r) => r.skillId),
        thread: (await SkillAssignments.listForAgent(AGENT, T1)).map((r) => r.skillId),
      };
    }

    it('SKILL.md removed and restored within the grace period keeps the id and assignments', async () => {
      const service = new SkillRegistryService(dir, GRACE_MS, null);
      try {
        await service.syncRoots();
        const row = await SkillRegistry.findBySlug('personal', null, SLUG);
        expect(row).toMatchObject({ status: 'valid' });
        await SkillAssignments.replace(AGENT, null, [row!.id]);
        await SkillAssignments.replace(AGENT, T1, [row!.id]);

        // Remove-then-write save: one scan sees it gone, the next sees it back.
        const file = path.join(dir, SLUG, 'SKILL.md');
        const body = readFileSync(file, 'utf8');
        await unlink(file);
        await service.scanAll();
        await writeFile(file, body);
        await service.scanAll();
        await service.idle();

        expect((await SkillRegistry.findBySlug('personal', null, SLUG))?.id).toBe(row!.id);
        expect(await assignedIds()).toEqual({ general: [row!.id], thread: [row!.id] });
      } finally {
        service.stop();
      }
    });

    it('SKILL.md still absent after the grace period deletes the row and its assignments', async () => {
      const service = new SkillRegistryService(dir, GRACE_MS, null);
      try {
        await service.syncRoots();
        const row = await SkillRegistry.findBySlug('personal', null, SLUG);
        await SkillAssignments.replace(AGENT, null, [row!.id]);
        await SkillAssignments.replace(AGENT, T1, [row!.id]);

        await unlink(path.join(dir, SLUG, 'SKILL.md'));
        await service.scanAll();
        // Not yet: still inside the grace period.
        expect(await SkillRegistry.findById(row!.id)).not.toBeNull();
        await service.idle();

        expect(await SkillRegistry.findById(row!.id)).toBeNull();
        expect(await assignedIds()).toEqual({ general: [], thread: [] });
      } finally {
        service.stop();
      }
    });
  });

  it('a vanished skill folder deletes its row, and its assignments go with it', async () => {
    await SkillAssignments.replace(AGENT, null, [S('a'), S('b')]);
    await SkillAssignments.replace(AGENT, T1, [S('b')]);
    // What the scanner's onRemove (and the start-up reconcile) call for a gone folder.
    await deleteSkillFolderRow({ scope: 'personal', projectId: null, dir: '/x' }, `${PREFIX}-b`);
    expect(await SkillRegistry.findById(S('b'))).toBeNull();
    expect((await SkillAssignments.listForAgent(AGENT, null)).map((r) => r.skillId)).toEqual([
      S('a'),
    ]);
    expect(await SkillAssignments.listForAgent(AGENT, T1)).toEqual([]);
  });
});
