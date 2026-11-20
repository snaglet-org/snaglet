/** Live-token substitution before requests and one-shot recovery after a 401. */
const mockReadAuth = jest.fn();
const mockSync = jest.fn();
const mockMarkFailed = jest.fn();
const mockManaged = jest.fn();
const mockMarkAuthFailed = jest.fn();

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/ProviderChatService/providers/claudeCliAuth', () => {
  const actual = jest.requireActual('@server/services/ProviderChatService/providers/claudeCliAuth');
  return { ...actual, readClaudeCliAuthCached: (...a: unknown[]) => mockReadAuth(...a) };
});
jest.mock('@server/services/ClaudeCodeAuthService/sync', () => ({
  syncClaudeCodeCredential: (...a: unknown[]) => mockSync(...a),
  markClaudeCodeCredentialFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markCredentialAuthFailed: (...a: unknown[]) => mockMarkAuthFailed(...a),
  isClaudeCodeManagedSecret: (...a: unknown[]) => mockManaged(...a),
}));

import {
  isClaudeCodeTokenKnownBad,
  markClaudeCodeTokenRejected,
  recoverClaudeCodeToken,
  resetClaudeCodeRecoveryState,
  resolveClaudeCodeSecret,
} from '@server/services/ClaudeCodeAuthService/recovery';

const OLD = 'sk-ant-oat01-old';
const NEW = 'sk-ant-oat01-new';
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  resetClaudeCodeRecoveryState();
  mockSync.mockResolvedValue({ credential: { id: 'cred-1' }, verification: 'untested' });
  mockMarkFailed.mockResolvedValue('cred-1');
  mockManaged.mockResolvedValue(true);
  mockMarkAuthFailed.mockResolvedValue(true);
});

describe('resolveClaudeCodeSecret', () => {
  it('passes ordinary API keys through without touching the keychain', async () => {
    expect(await resolveClaudeCodeSecret('sk-ant-api03-key')).toBe('sk-ant-api03-key');
    expect(mockReadAuth).not.toHaveBeenCalled();
  });

  it('leaves an OAuth token that is not the mirrored Claude Code credential alone', async () => {
    mockManaged.mockResolvedValue(false);
    mockReadAuth.mockResolvedValue({ accessToken: NEW, hasRefreshToken: true });
    expect(await resolveClaudeCodeSecret('sk-ant-oat01-other-account')).toBe(
      'sk-ant-oat01-other-account'
    );
    expect(mockReadAuth).not.toHaveBeenCalled();
    expect(await recoverClaudeCodeToken('sk-ant-oat01-other-account')).toBeNull();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('prefers a newer keychain token and mirrors it to the store', async () => {
    mockReadAuth.mockResolvedValue({ accessToken: NEW, hasRefreshToken: true });
    expect(await resolveClaudeCodeSecret(OLD)).toBe(NEW);
    await flush();
    expect(mockSync).toHaveBeenCalledWith({
      verify: false,
      auth: expect.objectContaining({ accessToken: NEW }),
    });
  });

  it('keeps the stored token when the keychain is missing, expired, or identical', async () => {
    mockReadAuth.mockResolvedValue(null);
    expect(await resolveClaudeCodeSecret(OLD)).toBe(OLD);
    mockReadAuth.mockResolvedValue({ accessToken: NEW, expiresAt: 1, hasRefreshToken: true });
    expect(await resolveClaudeCodeSecret(OLD)).toBe(OLD);
    mockReadAuth.mockResolvedValue({ accessToken: OLD, hasRefreshToken: true });
    expect(await resolveClaudeCodeSecret(OLD)).toBe(OLD);
    expect(mockSync).not.toHaveBeenCalled();
  });
});

describe('recoverClaudeCodeToken', () => {
  it('hands back a rotated token for one retry', async () => {
    mockReadAuth.mockResolvedValue({ accessToken: NEW, hasRefreshToken: true });
    expect(await recoverClaudeCodeToken(OLD)).toBe(NEW);
    expect(mockReadAuth).toHaveBeenCalledWith(true);
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(isClaudeCodeTokenKnownBad(OLD)).toBe(false);
  });

  it('marks the credential failed and remembers the dead token when nothing newer exists', async () => {
    mockReadAuth.mockResolvedValue({ accessToken: OLD, hasRefreshToken: true });
    expect(await recoverClaudeCodeToken(OLD)).toBeNull();
    expect(mockMarkFailed).toHaveBeenCalledWith(OLD);
    expect(isClaudeCodeTokenKnownBad(OLD)).toBe(true);
    // A later rotation clears the block.
    mockReadAuth.mockResolvedValue({ accessToken: NEW, hasRefreshToken: true });
    expect(await recoverClaudeCodeToken(OLD)).toBe(NEW);
    expect(isClaudeCodeTokenKnownBad(OLD)).toBe(false);
  });

  it('shares one recovery between concurrent failures on the same token and ignores API keys', async () => {
    mockReadAuth.mockResolvedValue({ accessToken: OLD, hasRefreshToken: true });
    const results = await Promise.all([
      recoverClaudeCodeToken(OLD, 'cred-1'),
      recoverClaudeCodeToken(OLD, 'cred-1'),
    ]);
    expect(results).toEqual([null, null]);
    expect(mockReadAuth).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(await recoverClaudeCodeToken('sk-ant-api03-key')).toBeNull();
    expect(mockReadAuth).toHaveBeenCalledTimes(1);
  });

  it('keys single-flight by token so distinct tokens get their own answers', async () => {
    // Run A (stale token) and run B (already rotated token) fail at once: the
    // keychain holds NEW, so A recovers to NEW and B is the dead one.
    mockReadAuth.mockResolvedValue({ accessToken: NEW, hasRefreshToken: true });
    const [forOld, forNew] = await Promise.all([
      recoverClaudeCodeToken(OLD, 'cred-1'),
      recoverClaudeCodeToken(NEW, 'cred-1'),
    ]);
    expect(forOld).toBe(NEW);
    expect(forNew).toBeNull();
    expect(mockReadAuth).toHaveBeenCalledTimes(2);
  });

  it('marks a rejected hand-pasted token failed on its own row, without touching the keychain', async () => {
    mockManaged.mockResolvedValue(false);
    const pasted = 'sk-ant-oat01-pasted';
    expect(await recoverClaudeCodeToken(pasted, 'cred-pasted')).toBeNull();
    expect(mockMarkAuthFailed).toHaveBeenCalledWith('cred-pasted', pasted);
    expect(mockReadAuth).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('a failure to mark the pasted row is logged, never thrown', async () => {
    mockManaged.mockResolvedValue(false);
    mockMarkAuthFailed.mockRejectedValue(new Error('db down'));
    await expect(recoverClaudeCodeToken('sk-ant-oat01-pasted', 'cred-pasted')).resolves.toBeNull();
  });

  it('passes the resolved credential id through the managed check', async () => {
    mockReadAuth.mockResolvedValue({ accessToken: NEW, hasRefreshToken: true });
    await resolveClaudeCodeSecret(OLD, 'cred-1');
    expect(mockManaged).toHaveBeenCalledWith(OLD, 'cred-1');
  });
});

describe('markClaudeCodeTokenRejected', () => {
  it('remembers a token Anthropic rejected on the retry and marks the credential failed', async () => {
    await markClaudeCodeTokenRejected(NEW);
    expect(isClaudeCodeTokenKnownBad(NEW)).toBe(true);
    expect(mockMarkFailed).toHaveBeenCalledWith(NEW);
  });
});
