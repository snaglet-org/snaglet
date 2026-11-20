/**
 * `doc.saved` names the save's editor (`lastEditedBy`, a members.id) so open
 * doc headers can refresh "Edited by" without a refetch — the same id the
 * save stamped as the doc's `last_edited_by`. Checked on the wire payload for
 * a REST body save (user actor), an agent `doc` tool update (agent actor),
 * and an unattributed save, which leaves the field off. Database access and
 * actor resolution are real; only the WebSocket broadcast is captured.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Agents, Docs, Members, Users, getDb, setActorMemberResolver } from '@snaglet/db';
import type { Actor, DocSavedEvent } from '@snaglet/shared/types/workspace-events';
import { invokeTool } from '../../../../../support/toolHarness';

const mockBroadcast = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: mockBroadcast, sendToClient: jest.fn() },
}));
jest.mock('@server/services/HookService', () => ({ hooks: { emit: jest.fn() } }));
jest.mock('@server/services/embedding/docSettleReembed', () => ({
  stampDocEdit: jest.fn(async () => undefined),
}));
jest.mock('@server/services/embedding/embedDoc', () => ({ embedDocNow: jest.fn() }));

import { errorHandler } from '@server/middleware';
import { runWithActor } from '@server/realtime/actorContext';
import { registerActorMemberResolver } from '@server/realtime/actorMember';
import docsRouter from '@server/domains/docs/docs.routes';
import docTool from '@server/services/ToolService/tools/docs/doc/tool';

const DOC = 'doc-1111111111111-aaaaaaaaa';
const AGENT = 'test-agent-a';
const USER_AUTH_ID = 'test-user-doc-saved';

// The actor the test app binds for the next request (undefined = unattributed).
let requestActor: Actor | undefined;
const app = express();
app.use(express.json());
app.use((_req, _res, next) => (requestActor ? runWithActor(requestActor, next) : next()));
app.use('/api/docs', docsRouter);
app.use(errorHandler);

let userId = '';
let userMember = '';
let agentMember = '';

/** Every `doc.saved` payload broadcast since the last reset. */
function docSavedPayloads(): DocSavedEvent[] {
  return mockBroadcast.mock.calls
    .map((call) => (call[1] as { payload: { type: string } }).payload)
    .filter((payload): payload is DocSavedEvent => payload.type === 'doc.saved');
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.query('DELETE FROM public.nodes WHERE id = $1', [DOC]);
  await db.query('DELETE FROM public.members WHERE agent_id = $1', [AGENT]);
  await db.query('DELETE FROM public.agents WHERE id = $1', [AGENT]);
  await db.query(
    'DELETE FROM public.members WHERE user_id IN (SELECT id FROM public.users WHERE auth_provider_id = $1)',
    [USER_AUTH_ID]
  );
  await db.query('DELETE FROM public.users WHERE auth_provider_id = $1', [USER_AUTH_ID]);
}

describe('doc.saved carries the editor', () => {
  beforeAll(async () => {
    await cleanup();
    const user = await Users.upsertUser({
      authProvider: 'test',
      authProviderId: USER_AUTH_ID,
      email: 'user@example.com',
      name: 'Test User',
    });
    userId = user.id;
    userMember = (await Members.ensureForUser(userId)).id;
    await Agents.create({ id: AGENT, name: 'Test Agent A' });
    agentMember = (await Members.ensureForAgent(AGENT)).id;
    registerActorMemberResolver();
  });

  beforeEach(async () => {
    requestActor = undefined;
    mockBroadcast.mockClear();
    await getDb().query('DELETE FROM public.nodes WHERE id = $1', [DOC]);
    await Docs.create({ id: DOC, title: 'Doc saved test doc', content: 'First body.' });
  });

  afterEach(() => {
    requestActor = undefined;
  });

  afterAll(async () => {
    setActorMemberResolver(null);
    await cleanup();
  });

  it('a REST body save names the saving user', async () => {
    requestActor = { actorKind: 'user', actorId: userId, actorName: 'Test User' };
    const res = await request(app)
      .patch(`/api/docs/${DOC}`)
      .send({ content: 'Saved by a person.' })
      .expect(200);

    expect(res.body.data.lastEditedBy).toBe(userMember);
    const [event] = docSavedPayloads();
    expect(docSavedPayloads()).toHaveLength(1);
    expect(event).toMatchObject({
      id: DOC,
      body: 'Saved by a person.',
      lastEditedBy: userMember,
    });
  });

  it('an agent doc tool update names the agent', async () => {
    await runWithActor({ actorKind: 'agent', actorId: AGENT, actorName: 'Test Agent A' }, () =>
      invokeTool(docTool, {
        op: 'update',
        id: DOC,
        edits: [{ old_text: 'First body.', new_text: 'Saved by an agent.' }],
        create_backup: false,
      })
    );

    expect((await Docs.findById(DOC))?.lastEditedBy).toBe(agentMember);
    const events = docSavedPayloads();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: DOC,
      body: 'Saved by an agent.',
      lastEditedBy: agentMember,
    });
  });

  it('an unattributed save leaves the editor off the event', async () => {
    await request(app).patch(`/api/docs/${DOC}`).send({ content: 'Saved by nobody.' }).expect(200);

    const events = docSavedPayloads();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: DOC, body: 'Saved by nobody.' });
    expect(events[0]).not.toHaveProperty('lastEditedBy');
  });
});
