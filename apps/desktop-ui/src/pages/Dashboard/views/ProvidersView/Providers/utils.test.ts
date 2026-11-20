import { describe, expect, it } from 'vitest';
import type { Provider, ProviderAuthType } from '@desktop/utils/api';
import type { CredentialDraft } from './types';
import {
  getDeviceFlowAuthType,
  getKeyAuthTypes,
  isJwtShaped,
  isKeylessProvider,
  parseJsonPaste,
  validateCredentialFormat,
} from './utils';

const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const JWT = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'test-user' })}.signature-part`;

const subscriptionAuth: ProviderAuthType = {
  id: 'codex:codex-subscription',
  name: 'Codex Subscription',
  type: 'oauth',
  description: '',
  sortOrder: 0,
  metadataFields: [
    { key: 'access_token', label: 'Access Token', inputType: 'password' },
    { key: 'refresh_token', label: 'Refresh Token', inputType: 'password' },
    { key: 'account_id', label: 'Account ID', inputType: 'text' },
  ],
};
const apiKeyAuth: ProviderAuthType = {
  id: 'codex:api-key',
  name: 'API Key',
  type: 'api_key',
  description: '',
  sortOrder: 1,
};
const codex = { id: 'codex', name: 'Codex', authTypes: [subscriptionAuth, apiKeyAuth] } as Provider;
const openai = {
  id: 'openai',
  name: 'OpenAI',
  authTypes: [{ ...apiKeyAuth, id: 'openai:api-key' }],
} as Provider;

const draft = (patch: Partial<CredentialDraft>): CredentialDraft => ({
  authTypeId: subscriptionAuth.id,
  label: '',
  secret: '',
  metadata: {},
  pasteMode: false,
  jsonPaste: '',
  jsonError: null,
  ...patch,
});

describe('isJwtShaped', () => {
  it('accepts three base64url segments with JSON object header and payload', () => {
    expect(isJwtShaped(JWT)).toBe(true);
  });

  it('rejects wrong segment counts, non-base64url characters, and non-object segments', () => {
    expect(isJwtShaped('a.b')).toBe(false);
    expect(isJwtShaped('a.b.c.d')).toBe(false);
    expect(isJwtShaped(`${b64url({})}.${b64url({})}.sig+nature`)).toBe(false);
    expect(isJwtShaped(`${b64url('str')}.${b64url({})}.sig`)).toBe(false);
    expect(isJwtShaped(`${b64url({})}.${b64url([1])}.sig`)).toBe(false);
    expect(isJwtShaped('not-json.also-not.sig')).toBe(false);
  });

  it('does not care about expiry or signature validity', () => {
    const expired = `${b64url({ alg: 'RS256' })}.${b64url({ exp: 0 })}.bogus`;
    expect(isJwtShaped(expired)).toBe(true);
  });
});

describe('validateCredentialFormat', () => {
  it('passes a well-formed Codex subscription draft', () => {
    expect(
      validateCredentialFormat(
        codex,
        subscriptionAuth,
        draft({ metadata: { access_token: JWT, refresh_token: 'rt_1', account_id: 'acct_1' } })
      )
    ).toBeNull();
  });

  it('reports missing multi-field values by label before shape checks', () => {
    expect(
      validateCredentialFormat(codex, subscriptionAuth, draft({ metadata: { access_token: JWT } }))
    ).toBe('Missing required fields: Refresh Token, Account ID');
  });

  it('rejects a non-JWT access token and whitespace in refresh_token / account_id', () => {
    expect(
      validateCredentialFormat(
        codex,
        subscriptionAuth,
        draft({ metadata: { access_token: 'ghu_abc', refresh_token: 'rt', account_id: 'acct' } })
      )
    ).toMatch(/Access Token must be a JWT/);
    expect(
      validateCredentialFormat(
        codex,
        subscriptionAuth,
        draft({ metadata: { access_token: JWT, refresh_token: 'rt 1', account_id: 'acct' } })
      )
    ).toBe('Refresh Token must not contain whitespace.');
    expect(
      validateCredentialFormat(
        codex,
        subscriptionAuth,
        draft({ metadata: { access_token: JWT, refresh_token: 'rt', account_id: 'ac ct' } })
      )
    ).toBe('Account ID must not contain whitespace.');
  });

  it('requires the sk- prefix for Codex API keys only', () => {
    expect(
      validateCredentialFormat(
        codex,
        apiKeyAuth,
        draft({ authTypeId: apiKeyAuth.id, secret: 'abc' })
      )
    ).toBe('Codex API keys start with "sk-".');
    expect(
      validateCredentialFormat(
        codex,
        apiKeyAuth,
        draft({ authTypeId: apiKeyAuth.id, secret: ' sk-live-123 ' })
      )
    ).toBeNull();
    expect(
      validateCredentialFormat(
        openai,
        openai.authTypes[0],
        draft({ authTypeId: 'openai:api-key', secret: 'anything-opaque' })
      )
    ).toBeNull();
  });

  it('requires a value for single-secret auth types', () => {
    expect(
      validateCredentialFormat(openai, openai.authTypes[0], draft({ authTypeId: 'openai:api-key' }))
    ).toBe('Enter a credential value before connecting.');
  });
});

describe('parseJsonPaste', () => {
  const fields = subscriptionAuth.metadataFields ?? [];
  const tokens = { access_token: JWT, refresh_token: 'rt_1', account_id: 'acct_1' };

  it('reads the flat shape', () => {
    expect(parseJsonPaste(JSON.stringify(tokens), fields)).toEqual({
      metadata: tokens,
      error: null,
    });
  });

  it('reads the Codex CLI auth.json shape, with the keys nested under `tokens`', () => {
    const authJson = {
      OPENAI_API_KEY: null,
      tokens: { id_token: JWT, ...tokens },
      last_refresh: '2026-01-01T00:00:00.000Z',
    };
    expect(parseJsonPaste(JSON.stringify(authJson), fields)).toEqual({
      metadata: tokens,
      error: null,
    });
  });

  it('prefers a top-level value over the nested one', () => {
    const json = JSON.stringify({ account_id: 'acct_top', tokens });
    expect(parseJsonPaste(json, fields).metadata.account_id).toBe('acct_top');
  });

  it('names keys missing from both shapes', () => {
    expect(parseJsonPaste(JSON.stringify({ tokens: { access_token: JWT } }), fields)).toEqual({
      metadata: { access_token: JWT },
      error: 'Missing keys: refresh_token, account_id',
    });
  });

  it('rejects invalid JSON and non-object values', () => {
    expect(parseJsonPaste('{"access_token": ', fields)).toEqual({
      metadata: {},
      error: 'Invalid JSON',
    });
    expect(parseJsonPaste('[]', fields).error).toBe('Must be a JSON object');
  });
});

describe('Sign in with GitHub auth types', () => {
  const copilotOAuth: ProviderAuthType = {
    id: 'copilot:subscription',
    name: 'GitHub OAuth',
    type: 'oauth',
    description: '',
    sortOrder: 0,
  };
  const copilotApiKey: ProviderAuthType = { ...apiKeyAuth, id: 'copilot:api-key' };
  const copilot = {
    id: 'copilot',
    name: 'GitHub Copilot',
    authTypes: [copilotOAuth, copilotApiKey],
  } as Provider;

  it("finds GitHub Copilot's device-flow type and leaves it out of the Add key types", () => {
    expect(getDeviceFlowAuthType(copilot)).toBe(copilotOAuth);
    expect(getKeyAuthTypes(copilot)).toEqual([copilotApiKey]);
  });

  it('leaves every other provider with all of its auth types', () => {
    expect(getDeviceFlowAuthType(codex)).toBeUndefined();
    expect(getKeyAuthTypes(codex)).toBe(codex.authTypes);
    expect(getKeyAuthTypes(openai)).toBe(openai.authTypes);
  });

  it('needs the OAuth type, not just the id, to offer the device flow', () => {
    const odd = { ...copilot, authTypes: [{ ...copilotOAuth, type: 'api_key' }] } as Provider;
    expect(getDeviceFlowAuthType(odd)).toBeUndefined();
    expect(getKeyAuthTypes(odd)).toBe(odd.authTypes);
  });
});

describe('isKeylessProvider', () => {
  const none: ProviderAuthType = {
    id: 'apple-on-device:none',
    name: 'No Auth',
    type: 'none',
    description: '',
    sortOrder: 0,
  };

  it('is true only when every auth type needs no key', () => {
    expect(isKeylessProvider({ id: 'apple-on-device', authTypes: [none] } as Provider)).toBe(true);
    expect(isKeylessProvider(openai)).toBe(false);
    expect(isKeylessProvider({ ...openai, authTypes: [none, apiKeyAuth] } as Provider)).toBe(false);
  });

  it('is false for a provider with no auth types at all', () => {
    expect(isKeylessProvider({ id: 'snaglet-local', authTypes: [] } as unknown as Provider)).toBe(
      false
    );
  });
});
