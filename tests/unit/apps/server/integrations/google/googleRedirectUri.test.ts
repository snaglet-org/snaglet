/**
 * The Google OAuth redirect URI is resolved at call time. In the packaged app
 * the sidecar binds an OS-assigned port, so a value captured at import can be
 * wrong (or the literal "undefined/api/...") for the whole process lifetime.
 *
 * These tests pin: the value tracks the environment on every call, it never
 * degrades to a placeholder, a wildcard bind host is rewritten to loopback,
 * and an unresolvable origin throws.
 */

jest.mock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, oauth2: jest.fn() } }));
jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: { findByProviderId: jest.fn(), create: jest.fn(), delete: jest.fn() },
}));
jest.mock('@server/utils/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

import {
  GOOGLE_OAUTH_CALLBACK_PATH,
  resolveGoogleRedirectUri,
} from '@server/integrations/google/googleWorkspace';

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['API_BASE_URL', 'PORT']) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ['API_BASE_URL', 'PORT']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test('uses API_BASE_URL as read on this call, not one captured at import', () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:4700';
  expect(resolveGoogleRedirectUri()).toBe(`http://127.0.0.1:4700${GOOGLE_OAUTH_CALLBACK_PATH}`);

  // The packaged sidecar binds an ephemeral port: a later call must follow it.
  process.env.API_BASE_URL = 'http://127.0.0.1:52341';
  expect(resolveGoogleRedirectUri()).toBe(`http://127.0.0.1:52341${GOOGLE_OAUTH_CALLBACK_PATH}`);
});

test('never emits the literal "undefined" when API_BASE_URL is unset', () => {
  delete process.env.API_BASE_URL;
  process.env.PORT = '4700';
  const uri = resolveGoogleRedirectUri();
  expect(uri).not.toContain('undefined');
  expect(uri).toBe(`http://127.0.0.1:4700${GOOGLE_OAUTH_CALLBACK_PATH}`);
});

test('falls back to loopback + PORT when API_BASE_URL is set to garbage', () => {
  process.env.API_BASE_URL = 'not-a-url';
  process.env.PORT = '4321';
  expect(resolveGoogleRedirectUri()).toBe(`http://127.0.0.1:4321${GOOGLE_OAUTH_CALLBACK_PATH}`);
});

test('a wildcard bind host is rewritten to loopback — 0.0.0.0 is not redirectable', () => {
  process.env.API_BASE_URL = 'http://0.0.0.0:4700';
  expect(resolveGoogleRedirectUri()).toBe(`http://127.0.0.1:4700${GOOGLE_OAUTH_CALLBACK_PATH}`);
});

test('a trailing path on API_BASE_URL is dropped so the callback path is not doubled', () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:4700/api/';
  expect(resolveGoogleRedirectUri()).toBe(`http://127.0.0.1:4700${GOOGLE_OAUTH_CALLBACK_PATH}`);
});

test('throws loudly when neither API_BASE_URL nor PORT resolves an origin', () => {
  delete process.env.API_BASE_URL;
  delete process.env.PORT;
  expect(() => resolveGoogleRedirectUri()).toThrow(/Cannot determine the OAuth redirect URI/);
});

test('the callback path matches the route Google is told to redirect to', () => {
  expect(GOOGLE_OAUTH_CALLBACK_PATH).toBe('/api/providers/google-workspace/oauth/callback');
});
