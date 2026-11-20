/**
 * The flower routes: the person hides, parks or holds an agent's flower. Each choice lasts
 * the agent's cursor session (and only that session), is broadcast to every overlay, and
 * never stops the agent.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

const broadcast = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcast: (...args: unknown[]) => broadcast(...args) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({ Agents: { findById: async () => null } }));
jest.mock('@snaglet/db/tables/images', () => ({ Images: {} }));
jest.mock('@server/services/BrowserController', () => ({
  getBrowserController: () => ({ stopAll: async () => 0 }),
}));

import computerRoutes from '@server/routes/computer';
import { agentCursorSessions } from '@server/services/agentCursorSessions';
import { cursorClaimService } from '@server/services/CursorClaimService';
import { resetSystemOverlay, systemOverlayScreen } from '@server/services/systemCursorOverlay';
import { emitCursor } from '@server/services/ToolService/tools/system/computer/tool';

const agent = { id: 'test-agent-a', name: 'Test User' };

describe('computer flower routes', () => {
  let app: Express;

  beforeEach(() => {
    agentCursorSessions.reset();
    cursorClaimService.revoke();
    resetSystemOverlay();
    broadcast.mockClear();
    app = express();
    app.use(express.json());
    app.use('/api/computer', computerRoutes);
  });

  const broadcasts = () =>
    broadcast.mock.calls.map(([m]) => m as { type: string; payload: Record<string, unknown> });
  const lastFlowerUpdate = () =>
    broadcasts()
      .filter((m) => m.type === 'agent:cursor-flower')
      .at(-1)?.payload;
  /** Put the agent's flower up and return its session id. */
  const flowerUp = (state: 'move' | 'idle' = 'idle') => {
    emitCursor(agent, state, { x: 10, y: 10 });
    return String(broadcasts().at(-1)?.payload.session);
  };

  it('hides a flower that is up, broadcasts it, and keeps the agent working', async () => {
    cursorClaimService.claim(agent.id, agent.name);
    const session = flowerUp('move');
    const res = await request(app)
      .post('/api/computer/cursor/dismiss')
      .send({ agentId: agent.id, session, pointer: { x: 5, y: 6 } });
    expect(res.status).toBe(200);
    expect(lastFlowerUpdate()).toMatchObject({ agentId: agent.id, session, dismissed: true });
    expect(cursorClaimService.holderAgentId()).toBe(agent.id);
  });

  it('parks a flower at a screen point', async () => {
    const session = flowerUp();
    const res = await request(app)
      .post('/api/computer/cursor/park')
      .send({ agentId: agent.id, session, x: 640, y: 360 });
    expect(res.status).toBe(200);
    expect(lastFlowerUpdate()).toMatchObject({ dismissed: false, parkedAt: { x: 640, y: 360 } });
  });

  it('holds and releases a flower', async () => {
    const session = flowerUp();
    const held = await request(app)
      .post('/api/computer/cursor/grab')
      .send({ agentId: agent.id, session, held: true });
    expect(held.status).toBe(200);
    expect(agentCursorSessions.anyGrabbed()).toBe(true);
    await request(app)
      .post('/api/computer/cursor/grab')
      .send({ agentId: agent.id, session, held: false });
    expect(agentCursorSessions.anyGrabbed()).toBe(false);
  });

  it('answers 404 for an agent with no flower up, or for a session that is over', async () => {
    const session = flowerUp();
    for (const [path, body] of [
      ['dismiss', { agentId: 'test-agent-b', session }],
      ['park', { agentId: 'test-agent-b', session, x: 1, y: 1 }],
      ['grab', { agentId: 'test-agent-b', session, held: true }],
      ['dismiss', { agentId: agent.id, session: 'cursor-earlier' }],
      ['park', { agentId: agent.id, session: 'cursor-earlier', x: 1, y: 1 }],
      ['grab', { agentId: agent.id, session: 'cursor-earlier', held: true }],
    ] as const) {
      const res = await request(app).post(`/api/computer/cursor/${path}`).send(body);
      expect(res.status).toBe(404);
    }
    expect(lastFlowerUpdate()).toBeUndefined();
    expect(agentCursorSessions.anyGrabbed()).toBe(false);
  });

  it('rejects malformed bodies', async () => {
    const session = flowerUp();
    for (const [path, body] of [
      ['dismiss', {}],
      ['dismiss', { agentId: agent.id }],
      ['dismiss', { agentId: 42, session }],
      ['dismiss', { agentId: agent.id, session, pointer: { x: 'a', y: 1 } }],
      ['park', { agentId: agent.id, session, x: 'a', y: 1 }],
      ['park', { agentId: agent.id, session, x: 1, y: 1e9 }],
      ['grab', { agentId: agent.id, session }],
      ['grab', { agentId: agent.id, session, held: 'yes' }],
    ] as const) {
      const res = await request(app).post(`/api/computer/cursor/${path}`).send(body);
      expect(res.status).toBe(400);
    }
    expect(lastFlowerUpdate()).toBeUndefined();
  });

  it('a hidden flower shows again in the next session', async () => {
    const session = flowerUp('move');
    await request(app).post('/api/computer/cursor/dismiss').send({ agentId: agent.id, session });
    emitCursor(agent, 'hidden', { x: 0, y: 0 });
    emitCursor(agent, 'move', { x: 20, y: 20 });
    const last = broadcasts().at(-1);
    expect(last?.payload.dismissed).toBeUndefined();
    expect(last?.payload.session).not.toBe(session);
  });

  it('lists every live flower and its choice for an overlay that reconnects', async () => {
    const session = flowerUp();
    await request(app)
      .post('/api/computer/cursor/park')
      .send({ agentId: agent.id, session, x: 30, y: 40 });
    const res = await request(app).get('/api/computer/cursor/flowers');
    expect(res.body).toEqual({
      flowers: [
        {
          agentId: agent.id,
          session,
          dismissed: false,
          parkedAt: { x: 30, y: 40 },
          systemOverlay: false,
        },
      ],
    });
  });

  it('the overlay heartbeat records the display size, and ignores a bad one', async () => {
    await request(app).post('/api/computer/overlay-heartbeat').send({ width: 1440, height: 900 });
    expect(systemOverlayScreen()).toEqual({ width: 1440, height: 900 });
    await request(app).post('/api/computer/overlay-heartbeat').send({ width: -1, height: 900 });
    expect(systemOverlayScreen()).toBeNull();
    await request(app).post('/api/computer/overlay-heartbeat');
    expect(systemOverlayScreen()).toBeNull();
  });
});
