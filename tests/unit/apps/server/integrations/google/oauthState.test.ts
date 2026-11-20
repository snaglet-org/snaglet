/**
 * Google OAuth `state` ledger — the CSRF gate.
 *
 * Before this existed the callback read only `code` and `error`: any page that
 * could make the browser load the callback URL could plant an authorization
 * code, and Snaglet would exchange it and wire every Google tool in the workspace
 * to an account the user never chose. These tests pin the four rejections that
 * close that hole (unknown, replayed, expired, empty) and the redirect-URI
 * pinning that keeps the auth request and the token exchange in agreement.
 */

import {
  GOOGLE_OAUTH_STATE_TTL_MS,
  consumeGoogleOAuthState,
  issueGoogleOAuthState,
  pendingGoogleOAuthStateCount,
  resetGoogleOAuthStates,
} from '@server/integrations/google/oauthState';

const REDIRECT = 'http://127.0.0.1:4700/api/providers/google-workspace/oauth/callback';

beforeEach(() => {
  resetGoogleOAuthStates();
  jest.useRealTimers();
});

afterEach(() => {
  jest.useRealTimers();
  resetGoogleOAuthStates();
});

test('an issued state redeems once and returns the redirect URI it was issued for', () => {
  const state = issueGoogleOAuthState(REDIRECT);
  expect(state).toMatch(/^[0-9a-f-]{36}$/);
  expect(consumeGoogleOAuthState(state)).toEqual({ redirectUri: REDIRECT });
});

test('a replayed state is rejected — redemption is single-use', () => {
  const state = issueGoogleOAuthState(REDIRECT);
  expect(consumeGoogleOAuthState(state)).not.toBeNull();
  expect(consumeGoogleOAuthState(state)).toBeNull();
});

test('a state this server never issued is rejected', () => {
  issueGoogleOAuthState(REDIRECT);
  expect(consumeGoogleOAuthState('11111111-2222-3333-4444-555555555555')).toBeNull();
});

test('an empty state is rejected rather than matching an empty-key entry', () => {
  issueGoogleOAuthState(REDIRECT);
  expect(consumeGoogleOAuthState('')).toBeNull();
});

test('a state past its TTL is rejected and dropped', () => {
  const state = issueGoogleOAuthState(REDIRECT);
  const issuedAt = Date.now();
  const spy = jest.spyOn(Date, 'now').mockReturnValue(issuedAt + GOOGLE_OAUTH_STATE_TTL_MS + 1_000);
  try {
    expect(consumeGoogleOAuthState(state)).toBeNull();
    expect(pendingGoogleOAuthStateCount()).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

test('each issue mints a distinct state and states carry their own redirect URI', () => {
  const a = issueGoogleOAuthState('http://127.0.0.1:1111/cb');
  const b = issueGoogleOAuthState('http://127.0.0.1:2222/cb');
  expect(a).not.toBe(b);
  expect(consumeGoogleOAuthState(b)).toEqual({ redirectUri: 'http://127.0.0.1:2222/cb' });
  expect(consumeGoogleOAuthState(a)).toEqual({ redirectUri: 'http://127.0.0.1:1111/cb' });
});

test('the pending map is capped so repeated /oauth/start calls cannot grow it forever', () => {
  const first = issueGoogleOAuthState(REDIRECT);
  for (let i = 0; i < 200; i += 1) issueGoogleOAuthState(REDIRECT);
  expect(pendingGoogleOAuthStateCount()).toBeLessThanOrEqual(32);
  // Oldest entries are the ones evicted.
  expect(consumeGoogleOAuthState(first)).toBeNull();
});
