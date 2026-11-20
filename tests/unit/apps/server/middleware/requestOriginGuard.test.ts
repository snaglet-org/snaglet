/**
 * Browser-boundary guards in sidecarAuthMiddleware: the Host allowlist
 * (DNS-rebinding defense, 421) and the cross-site refusal on sensitive
 * routes (403). Both must hold in the tokenless dev/self-host mode, where
 * the session token offers no protection.
 */

import express from 'express';
import request from 'supertest';
import { sidecarAuthMiddleware } from '@server/middleware/sidecarAuth';
import {
  buildAllowedHostnames,
  hostnameFromHostHeader,
  isAllowedHostHeader,
  isCrossSiteRequest,
  isSensitiveApiPath,
} from '@server/middleware/requestOriginGuard';

const ENV_KEYS = [
  'SNAGLET_AUTH_TOKEN',
  'SNAGLET_ALLOWED_HOSTS',
  'SNAGLET_ALLOWED_ORIGINS',
  'SNAGLET_BIND_HOST',
  'API_BASE_URL',
  'CLIENT_PORT',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function buildApp() {
  const app = express();
  app.use(sidecarAuthMiddleware);
  app.get('/api/providers/credentials/:id/export', (_req, res) => {
    res.json({ apiKey: 'sk-test-placeholder' });
  });
  app.get('/api/threads', (_req, res) => res.json({ ok: true }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('Host allowlist', () => {
  test.each([
    'attacker.example',
    'attacker.example:4001',
    'localhost.attacker.example:4001',
    '127.0.0.1.nip.io:4001',
    'localhost.:4001',
  ])('answers 421 for the foreign Host %s, even without a session token', async (host) => {
    const app = buildApp();
    const exported = await request(app)
      .get('/api/providers/credentials/cred-1/export')
      .set('Host', host);
    expect(exported.status).toBe(421);
    expect(JSON.stringify(exported.body)).not.toContain('sk-test-placeholder');
    expect((await request(app).get('/health').set('Host', host)).status).toBe(421);
  });

  test.each([
    'localhost:4001',
    '127.0.0.1:4001',
    '[::1]:4001',
    'tauri.localhost',
    'LOCALHOST:3001',
    '192.168.1.20:4001',
  ])('serves the local Host %s', async (host) => {
    const res = await request(buildApp()).get('/api/threads').set('Host', host);
    expect(res.status).toBe(200);
  });

  test('ignores X-Forwarded-Host, which a rebinding page can set', async () => {
    const app = buildApp();
    app.set('trust proxy', 1);
    const res = await request(app)
      .get('/api/threads')
      .set('Host', 'attacker.example:4001')
      .set('X-Forwarded-Host', 'localhost');
    expect(res.status).toBe(421);
  });

  test('SNAGLET_ALLOWED_HOSTS and SNAGLET_BIND_HOST extend the allowlist', async () => {
    process.env.SNAGLET_ALLOWED_HOSTS = 'snaglet.internal.example, proxy.example:8443';
    process.env.SNAGLET_BIND_HOST = 'workstation.local';
    const app = buildApp();
    for (const host of [
      'snaglet.internal.example',
      'proxy.example:8443',
      'workstation.local:4001',
    ]) {
      expect((await request(app).get('/api/threads').set('Host', host)).status).toBe(200);
    }
  });

  test('the token check still runs after the Host check', async () => {
    process.env.SNAGLET_AUTH_TOKEN = 'test-session-token';
    const app = buildApp();
    expect((await request(app).get('/api/threads').set('Host', 'localhost:4001')).status).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/threads')
          .set('Host', 'attacker.example')
          .set('x-snaglet-token', 'test-session-token')
      ).status
    ).toBe(421);
  });

  test('parses Host header forms', () => {
    expect(hostnameFromHostHeader('LocalHost:4001')).toBe('localhost');
    expect(hostnameFromHostHeader('[::1]:4001')).toBe('::1');
    expect(hostnameFromHostHeader('[::1]')).toBe('::1');
    expect(hostnameFromHostHeader('::1')).toBeNull();
    expect(hostnameFromHostHeader('[not-an-ip]:1')).toBeNull();
    expect(hostnameFromHostHeader('host name')).toBeNull();
    expect(hostnameFromHostHeader('')).toBeNull();
  });

  test('a request with no Host header (non-browser) is allowed', () => {
    expect(isAllowedHostHeader(undefined, {})).toBe(true);
  });

  test('configured origins and API_BASE_URL contribute their hosts', () => {
    const hosts = buildAllowedHostnames({
      SNAGLET_ALLOWED_ORIGINS: 'https://ui.example.test',
      API_BASE_URL: 'http://api.example.test:4001',
    });
    expect(hosts.has('ui.example.test')).toBe(true);
    expect(hosts.has('api.example.test')).toBe(true);
    expect(hosts.has('tauri.localhost')).toBe(true);
  });
});

describe('cross-site refusal on sensitive routes', () => {
  const exportPath = '/api/providers/credentials/cred-1/export';

  test('refuses a cross-site no-Origin request (navigation / <img>)', async () => {
    const res = await request(buildApp())
      .get(exportPath)
      .set('Host', '127.0.0.1:4001')
      .set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('sk-test-placeholder');
  });

  test('refuses a foreign Origin', async () => {
    const res = await request(buildApp())
      .get(exportPath)
      .set('Host', '127.0.0.1:4001')
      .set('Origin', 'https://attacker.example');
    expect(res.status).toBe(403);
  });

  test.each([
    ['the Vite dev UI origin', { Origin: 'http://localhost:3001', 'Sec-Fetch-Site': 'same-site' }],
    ['the Tauri webview origin', { Origin: 'tauri://localhost', 'Sec-Fetch-Site': 'cross-site' }],
    ['a same-host origin', { Origin: 'http://127.0.0.1:4001' }],
    ['a same-origin fetch without Origin', { 'Sec-Fetch-Site': 'same-origin' }],
    ['a non-browser client', {}],
  ])('allows %s', async (_label, headers: Record<string, string>) => {
    const res = await request(buildApp())
      .get(exportPath)
      .set('Host', '127.0.0.1:4001')
      .set(headers);
    expect(res.status).toBe(200);
  });

  test('non-sensitive routes are not subject to the cross-site check', async () => {
    const res = await request(buildApp())
      .get('/api/threads')
      .set('Host', '127.0.0.1:4001')
      .set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(200);
  });

  test('sensitive path matching', () => {
    expect(isSensitiveApiPath('/api/providers/credentials/abc/export')).toBe(true);
    expect(isSensitiveApiPath('/api/mcp-keys')).toBe(true);
    expect(isSensitiveApiPath('/api/mcp-keys/key-1/revoke')).toBe(true);
    expect(isSensitiveApiPath('/api/db/stats')).toBe(true);
    expect(isSensitiveApiPath('/api/admin/db/snapshots')).toBe(true);
    expect(isSensitiveApiPath('/api/providers/credentials')).toBe(false);
    expect(isSensitiveApiPath('/api/dbx')).toBe(false);
  });

  test('machine-control routes are sensitive; lookalikes are not', () => {
    expect(isSensitiveApiPath('/api/computer/stop')).toBe(true);
    expect(isSensitiveApiPath('/api/computer/demo')).toBe(true);
    expect(isSensitiveApiPath('/api/browser/open')).toBe(true);
    expect(isSensitiveApiPath('/api/computers')).toBe(false);
  });

  test('computer routes: foreign page refused; same-origin dev tool and Origin-less overlay allowed', () => {
    const env = {};
    const host = '127.0.0.1:4001';
    expect(isCrossSiteRequest({ headers: { origin: 'https://attacker.example', host } }, env)).toBe(
      true
    );
    expect(isCrossSiteRequest({ headers: { 'sec-fetch-site': 'cross-site', host } }, env)).toBe(
      true
    );
    expect(isCrossSiteRequest({ headers: { origin: `http://${host}`, host } }, env)).toBe(false);
    expect(isCrossSiteRequest({ headers: { host } }, env)).toBe(false);
  });

  test('isCrossSiteRequest treats an Origin of "null" as cross-site', () => {
    expect(isCrossSiteRequest({ headers: { origin: 'null', host: 'localhost:4001' } }, {})).toBe(
      true
    );
  });
});
