/**
 * GET /api/mcp-keys/connect-info behind the real app-session
 * middleware: the session token is required, an MCP key never authenticates
 * it, cross-site callers are refused (a sensitive path), and the payload is
 * exactly the connect info with no secret in it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@server/config', () => ({ serverConfig: { port: 51234 } }));

import { sidecarAuthMiddleware } from '@server/middleware/sidecarAuth';
import mcpApiKeysRoutes from '@server/domains/mcp/mcpApiKeys.routes';

const SESSION_TOKEN = 'test-session-token-aaaaaaaa';
const MCP_KEY = `snaglet_mcp_0a1b2c3d_${'ab'.repeat(24)}`;
const savedToken = process.env.SNAGLET_AUTH_TOKEN;

function app() {
  const server = express();
  server.use(express.json());
  server.use(sidecarAuthMiddleware);
  server.use('/api/mcp-keys', mcpApiKeysRoutes);
  return server;
}

beforeEach(() => {
  process.env.SNAGLET_AUTH_TOKEN = SESSION_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.SNAGLET_AUTH_TOKEN;
  else process.env.SNAGLET_AUTH_TOKEN = savedToken;
});

describe('GET /api/mcp-keys/connect-info', () => {
  it('needs the app session token', async () => {
    const res = await request(app()).get('/api/mcp-keys/connect-info');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/snagletHome|mcpUrl/);
  });

  it('an MCP key never authenticates it, as a Bearer or as the session header', async () => {
    for (const set of [
      (req: request.Test) => req.set('Authorization', `Bearer ${MCP_KEY}`),
      (req: request.Test) => req.set('x-snaglet-token', MCP_KEY),
    ]) {
      const res = await set(request(app()).get('/api/mcp-keys/connect-info'));
      expect(res.status).toBe(401);
    }
  });

  it('refuses a cross-site caller even with the session token', async () => {
    const res = await request(app())
      .get('/api/mcp-keys/connect-info')
      .set('x-snaglet-token', SESSION_TOKEN)
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('with the session: exactly the connect info, and no secret', async () => {
    const res = await request(app())
      .get('/api/mcp-keys/connect-info')
      .set('x-snaglet-token', SESSION_TOKEN);
    expect(res.status).toBe(200);
    const info = res.body.data as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual([
      'cliOnPath',
      'cliPath',
      'isDefaultHome',
      'mcpUrl',
      'port',
      'profile',
      'snagletHome',
    ]);
    expect(info).toMatchObject({
      port: 51234,
      mcpUrl: 'http://127.0.0.1:51234/mcp',
      profile: expect.stringMatching(/^(production|dev)$/),
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SESSION_TOKEN);
    expect(text).not.toMatch(/snaglet_mcp_|token|keyHash|key_hash/i);
  });
});
