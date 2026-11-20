/**
 * A subagent helper's model is set from its thread's settings like any
 * agent's, against the real database (dispatch stubbed, no model calls): a
 * participant model override in the helper's thread is the model its next
 * turn resolves, the `subagents` row follows it (and its reset back to the
 * start model) so the header, the composer chip and op:list name the model
 * the helper runs on, and a helper's thread takes no other participants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@server/services/SocketService/dispatch/dispatchToThread'
  ),
  dispatchToThread: async () => ({ ok: true, reason: 'dispatched', wakeCount: 1, capHit: false }),
}));

import { Agents, Threads, ThreadParticipants, getDb } from '@snaglet/db';
import { Subagents, type SubagentRow } from '@snaglet/db/tables/subagents';
import { SUBAGENT_CHANGED_FRAME, type SubagentChangedPayload } from '@snaglet/shared/types';
import { errorHandler } from '@server/middleware';
import { registerParticipantRoutes } from '@server/domains/threads/handlers/participantHandlers';
import { subagentService } from '@server/services/subagents/SubagentService';
import { wsService } from '@server/services/WebSocketService';

const ORCH = 'test-agent-a';
const OTHER = 'test-agent-b';
const PARENT = 'thread-1111111111111-parentaaa';

let providerId = '';
let fastModel = '';
let strongModel = '';
let app: express.Application;
let helper: SubagentRow;

const broadcast = jest.spyOn(wsService, 'broadcastToChannel');

function makeApp(): express.Application {
  const instance = express();
  instance.use(express.json());
  const router = express.Router();
  registerParticipantRoutes(router);
  instance.use('/api/threads', router);
  instance.use(errorHandler);
  return instance;
}

/** The `subagent:changed` frames sent to the parent thread's channel. */
function changeFrames(): SubagentChangedPayload[] {
  return broadcast.mock.calls
    .filter(([channel, frame]) => channel === PARENT && frame.type === SUBAGENT_CHANGED_FRAME)
    .map(([, frame]) => frame.payload as SubagentChangedPayload);
}

function setModel(body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/threads/${helper.threadId}/participants/${helper.agentId}/model`)
    .send(body);
}

beforeAll(async () => {
  const { rows } = await getDb().query<{ provider_id: string; model_ids: string[] }>(
    `SELECT provider_id, array_agg(model_id ORDER BY sort_order, model_id) AS model_ids
       FROM public.models
      WHERE is_active AND supports_tools AND type = 'llm'
      GROUP BY provider_id HAVING count(*) >= 2
      ORDER BY provider_id`
  );
  if (rows.length < 1) throw new Error('seed needs a provider with two tool-capable models');
  providerId = rows[0]!.provider_id;
  [fastModel, strongModel] = rows[0]!.model_ids as [string, string];

  await Agents.create({ id: ORCH, name: 'Test Agent A', providerId, modelId: strongModel });
  await Agents.create({ id: OTHER, name: 'Test Agent B', providerId, modelId: strongModel });
  await Threads.create({ id: PARENT, title: 'Parent' });
  await ThreadParticipants.addParticipant({ threadId: PARENT, agentId: ORCH });
  subagentService.init({ recoverAfterRestart: false });

  helper = await subagentService.start({
    orchestratorAgentId: ORCH,
    parentThreadId: PARENT,
    name: 'Echo',
    model: fastModel,
    brief: 'Summarize the notes.',
  });
  app = makeApp();
});

afterAll(() => {
  subagentService.shutdown();
  broadcast.mockRestore();
});

beforeEach(() => {
  broadcast.mockClear();
});

describe("a subagent's model from its thread settings (real DB)", () => {
  it('starts on the model its orchestrator picked', async () => {
    expect(helper).toMatchObject({ providerId, modelId: fastModel });
    expect(await Threads.getEffectiveModel(helper.threadId!, helper.agentId)).toMatchObject({
      providerId,
      modelId: fastModel,
      source: 'agent',
    });
  });

  it('an override is the model its next turn uses, and the subagents row follows it', async () => {
    const res = await setModel({ providerId, modelId: strongModel, credentialId: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ providerId, modelId: strongModel });

    expect(await Threads.getEffectiveModel(helper.threadId!, helper.agentId)).toMatchObject({
      providerId,
      modelId: strongModel,
      source: 'thread_participant',
    });
    expect(await Subagents.findById(helper.id)).toMatchObject({ providerId, modelId: strongModel });
    // op:list reads the same row.
    expect((await subagentService.list(PARENT)).map((s) => s.modelId)).toEqual([strongModel]);
    // The header and the parent's composer chip follow the frame.
    expect(changeFrames()).toEqual([
      expect.objectContaining({
        parentThreadId: PARENT,
        subagent: expect.objectContaining({
          id: helper.id,
          modelId: strongModel,
          orchestratorName: 'Test Agent A',
        }),
      }),
    ]);
    // The helper's own agent row (its default) is untouched.
    expect(await Agents.findById(helper.agentId)).toMatchObject({ modelId: fastModel });
  });

  it('saving the same model again sends no frame', async () => {
    const res = await setModel({ providerId, modelId: strongModel, credentialId: null });
    expect(res.status).toBe(200);
    expect(changeFrames()).toEqual([]);
  });

  it('a reset returns it to the start model', async () => {
    const res = await setModel({ providerId: null, modelId: null, credentialId: null });
    expect(res.status).toBe(200);

    expect(await Threads.getEffectiveModel(helper.threadId!, helper.agentId)).toMatchObject({
      providerId,
      modelId: fastModel,
      source: 'agent',
    });
    expect(await Subagents.findById(helper.id)).toMatchObject({ providerId, modelId: fastModel });
    expect(changeFrames()).toEqual([
      expect.objectContaining({ subagent: expect.objectContaining({ modelId: fastModel }) }),
    ]);
  });

  it('an override in a regular thread leaves the subagents rows alone', async () => {
    const res = await request(app)
      .patch(`/api/threads/${PARENT}/participants/${ORCH}/model`)
      .send({ providerId, modelId: fastModel, credentialId: null });
    expect(res.status).toBe(200);
    expect(await Subagents.findById(helper.id)).toMatchObject({ modelId: fastModel });
    expect(changeFrames()).toEqual([]);
  });

  it("a helper's thread takes no other participants; a regular thread still does", async () => {
    const refused = await request(app)
      .post(`/api/threads/${helper.threadId}/participants`)
      .send({ agentId: OTHER });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe("Participants can't be added to a subagent's thread.");
    const helperParticipants = await ThreadParticipants.listByThread(helper.threadId!);
    expect(helperParticipants.map((p) => p.agentId)).toEqual([helper.agentId]);

    const added = await request(app)
      .post(`/api/threads/${PARENT}/participants`)
      .send({ agentId: OTHER });
    expect(added.status).toBe(201);
  });
});
