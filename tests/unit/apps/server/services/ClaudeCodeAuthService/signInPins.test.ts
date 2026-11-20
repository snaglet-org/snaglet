/**
 * A verified Claude Code sign-in takes over whatever was pinned to a dead
 * Claude Code credential (a hand-pasted token Snaglet cannot refresh), instead of
 * leaving agents and summary models on the dead row. API-key rows are never
 * moved onto a subscription login.
 */
const mockListAll = jest.fn();
const mockGetSecretById = jest.fn();
const mockRepoint = jest.fn();

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: { listAll: (...a: unknown[]) => mockListAll(...a) },
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecretById: (...a: unknown[]) => mockGetSecretById(...a) },
}));
jest.mock('@server/services/ProviderCredentialService/credentialPins', () => ({
  repointCredentialPins: (...a: unknown[]) => mockRepoint(...a),
}));
jest.mock('@server/services/ClaudeCodeAuthService/sync', () => ({
  CLAUDE_CODE_PROVIDER_ID: 'anthropic',
  CLAUDE_CODE_AUTH_TYPE_ID: 'anthropic:claude-code-pro',
}));

import {
  adoptPinsForClaudeCodeSignIn,
  findDeadClaudeCodeCredentialIds,
} from '@server/services/ClaudeCodeAuthService/signInPins';
import {
  forgetAllRejectedTokens,
  rememberRejectedToken,
} from '@server/services/ClaudeCodeAuthService/rejectedTokens';

const row = (over: Record<string, unknown>) => ({
  providerId: 'anthropic',
  authTypeId: 'anthropic:claude-code-pro',
  authType: 'oauth',
  label: 'Claude Code token',
  verificationStatus: 'untested',
  ...over,
});

const MANAGED = row({ id: 'cred-managed', verificationStatus: 'ok' });
const PASTED_FAILED = row({ id: 'cred-pasted', verificationStatus: 'fail' });
const PASTED_REJECTED = row({ id: 'cred-rejected' });
const PASTED_HEALTHY = row({ id: 'cred-healthy', verificationStatus: 'ok' });
const API_KEY_FAILED = row({
  id: 'cred-api-key',
  authTypeId: 'anthropic:api-key',
  authType: 'api_key',
  verificationStatus: 'fail',
});
const OTHER_PROVIDER = row({ id: 'cred-openai', providerId: 'openai', verificationStatus: 'fail' });

beforeEach(() => {
  jest.clearAllMocks();
  forgetAllRejectedTokens();
  mockListAll.mockResolvedValue([
    MANAGED,
    PASTED_FAILED,
    PASTED_REJECTED,
    PASTED_HEALTHY,
    API_KEY_FAILED,
    OTHER_PROVIDER,
  ]);
  mockGetSecretById.mockImplementation(async (id: string) =>
    id === 'cred-rejected' ? 'sk-ant-oat01-rejected' : 'sk-ant-oat01-other'
  );
  mockRepoint.mockResolvedValue({ agentIds: [] });
});

describe('findDeadClaudeCodeCredentialIds', () => {
  it('finds Claude Code rows whose last check failed or whose token Anthropic rejected', async () => {
    rememberRejectedToken('sk-ant-oat01-rejected');
    await expect(findDeadClaudeCodeCredentialIds('cred-managed')).resolves.toEqual([
      'cred-pasted',
      'cred-rejected',
    ]);
  });

  it('never counts the managed row, a healthy row, an API key or another provider', async () => {
    const dead = await findDeadClaudeCodeCredentialIds('cred-managed');
    expect(dead).not.toContain('cred-managed');
    expect(dead).not.toContain('cred-healthy');
    expect(dead).not.toContain('cred-api-key');
    expect(dead).not.toContain('cred-openai');
  });

  it('skips a row whose secret cannot be read instead of failing the sign-in', async () => {
    mockListAll.mockResolvedValue([MANAGED, PASTED_REJECTED]);
    mockGetSecretById.mockRejectedValue(new Error('db down'));
    await expect(findDeadClaudeCodeCredentialIds('cred-managed')).resolves.toEqual([]);
  });
});

describe('adoptPinsForClaudeCodeSignIn', () => {
  it('moves the dead rows’ pins and an empty primary to the new managed row', async () => {
    await adoptPinsForClaudeCodeSignIn('cred-managed');
    expect(mockRepoint).toHaveBeenCalledWith({
      providerId: 'anthropic',
      fromCredentialIds: ['cred-pasted'],
      toCredentialId: 'cred-managed',
      fillEmptyPrimary: true,
      context: 'Claude Code sign-in',
    });
  });
});
