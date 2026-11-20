/** Keychain → credential row mirroring: single row, verify-before-ok, 404 without a login. */
const mockListSafe = jest.fn();
const mockSave = jest.fn();
const mockEdit = jest.fn();
const mockVerify = jest.fn();
const mockUpdateStatus = jest.fn();
const mockReadAuth = jest.fn();
const mockGetSecretById = jest.fn();
const mockListAll = jest.fn();

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    listSafe: (...a: unknown[]) => mockListSafe(...a),
    save: (...a: unknown[]) => mockSave(...a),
    edit: (...a: unknown[]) => mockEdit(...a),
    getSecretById: (...a: unknown[]) => mockGetSecretById(...a),
  },
}));
jest.mock('@server/services/ProviderCredentialService/format', () => ({
  parseProviderCredentialInput: jest.fn(async () => undefined),
}));
jest.mock('@server/services/ProviderChatService', () => ({
  providerChatService: { verify: (...a: unknown[]) => mockVerify(...a) },
}));
jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: {
    updateVerificationStatus: (...a: unknown[]) => mockUpdateStatus(...a),
    listAll: (...a: unknown[]) => mockListAll(...a),
  },
}));
jest.mock('@server/services/ProviderChatService/providers/claudeCliAuth', () => {
  const actual = jest.requireActual('@server/services/ProviderChatService/providers/claudeCliAuth');
  return { ...actual, readClaudeCliAuthCached: (...a: unknown[]) => mockReadAuth(...a) };
});

import {
  isRejectedToken,
  rememberRejectedToken,
} from '@server/services/ClaudeCodeAuthService/rejectedTokens';
import {
  isClaudeCodeManagedSecret,
  markClaudeCodeCredentialFailed,
  markCredentialAuthFailed,
  readUsableClaudeCliAuth,
  syncClaudeCodeCredential,
} from '@server/services/ClaudeCodeAuthService/sync';

const auth = { accessToken: 'sk-ant-oat01-abc', hasRefreshToken: true };
const row = {
  id: 'cred-1',
  providerId: 'anthropic',
  authTypeId: 'anthropic:claude-code-pro',
  label: 'Claude Code login',
  metadataJson: { managed_by: 'claude-code-cli' },
  verificationStatus: 'untested',
};
/** A token the user pasted by hand under the same auth type — never Snaglet's to overwrite. */
const manualRow = { ...row, id: 'manual-1', label: 'My other Claude account', metadataJson: {} };
const legacyRow = { ...row, id: 'legacy-1', label: 'Claude Code CLI (imported)', metadataJson: {} };

beforeEach(() => {
  jest.clearAllMocks();
  mockReadAuth.mockResolvedValue(auth);
  mockListSafe.mockResolvedValue([]);
  mockListAll.mockResolvedValue([]);
  mockSave.mockResolvedValue(row);
  mockEdit.mockResolvedValue(row);
  // The row still holds the token just written unless a test rotates it.
  mockGetSecretById.mockImplementation(async () => auth.accessToken);
});

describe('syncClaudeCodeCredential', () => {
  it('creates the credential and marks it ok after a live verification', async () => {
    mockVerify.mockResolvedValue({ valid: true, message: 'Connected successfully' });
    const result = await syncClaudeCodeCredential({ verify: true });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        authTypeId: 'anthropic:claude-code-pro',
        secret: auth.accessToken,
        metadata: { managed_by: 'claude-code-cli' },
      })
    );
    expect(mockVerify).toHaveBeenCalledWith('anthropic', auth.accessToken, expect.any(Object));
    expect(mockUpdateStatus).toHaveBeenCalledWith('cred-1', 'ok');
    expect(result.verification).toBe('ok');
    expect(result.credential.verificationStatus).toBe('ok');
  });

  it('a successful explicit verification clears a remembered rejection for that token', async () => {
    rememberRejectedToken(auth.accessToken);
    mockVerify.mockResolvedValue({ valid: true, message: 'Connected successfully' });
    await syncClaudeCodeCredential({ verify: true });
    expect(isRejectedToken(auth.accessToken)).toBe(false);
  });

  it('updates the marked row in place instead of adding a duplicate', async () => {
    mockListAll.mockResolvedValue([
      { ...row, id: 'api-key', authTypeId: 'anthropic:api-key' },
      manualRow,
      row,
    ]);
    await syncClaudeCodeCredential({ verify: false });
    expect(mockEdit).toHaveBeenCalledWith(
      'cred-1',
      expect.objectContaining({
        secret: auth.accessToken,
        metadata: { managed_by: 'claude-code-cli' },
      })
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockUpdateStatus).toHaveBeenCalledWith('cred-1', 'untested');
  });

  it('never overwrites a manually pasted token under the same auth type', async () => {
    mockListAll.mockResolvedValue([manualRow]);
    await syncClaudeCodeCredential({ verify: false });
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('adopts (and marks) the row the legacy one-shot importer wrote', async () => {
    mockListAll.mockResolvedValue([manualRow, legacyRow]);
    await syncClaudeCodeCredential({ verify: false });
    expect(mockEdit).toHaveBeenCalledWith(
      'legacy-1',
      expect.objectContaining({ metadata: { managed_by: 'claude-code-cli' } })
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('marks the row failed when Anthropic rejects the token', async () => {
    mockVerify.mockResolvedValue({ valid: false, message: 'OAuth access token has been revoked' });
    const result = await syncClaudeCodeCredential({ verify: true });
    expect(mockUpdateStatus).toHaveBeenCalledWith('cred-1', 'fail');
    expect(result).toMatchObject({
      verification: 'fail',
      message: 'OAuth access token has been revoked',
    });
  });

  it('serializes concurrent upserts so the first creates and the second updates', async () => {
    mockListAll.mockResolvedValueOnce([]).mockResolvedValue([row]);
    await Promise.all([
      syncClaudeCodeCredential({ verify: false }),
      syncClaudeCodeCredential({ verify: false }),
    ]);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalledTimes(1);
  });

  it('discards a verdict for a token that was rotated away while it was being verified', async () => {
    let releaseVerify: (value: { valid: boolean; message: string }) => void = () => undefined;
    mockVerify.mockImplementationOnce(
      () => new Promise<{ valid: boolean; message: string }>((resolve) => (releaseVerify = resolve))
    );
    mockListAll.mockResolvedValue([{ ...row, verificationStatus: 'ok' }]);
    mockEdit.mockResolvedValue({ ...row, verificationStatus: 'ok' });
    const first = syncClaudeCodeCredential({ verify: true });
    await new Promise((resolve) => setImmediate(resolve));
    // The old token's passing verdict must not remain visible while the
    // replacement token is waiting for its own verification.
    expect(mockUpdateStatus).toHaveBeenLastCalledWith('cred-1', 'untested');
    // Rotation lands: the row now stores token B.
    const rotated = { accessToken: 'sk-ant-oat01-B', hasRefreshToken: true };
    mockGetSecretById.mockImplementation(async () => rotated.accessToken);
    await syncClaudeCodeCredential({ verify: false, auth: rotated });
    releaseVerify({ valid: true, message: 'Connected successfully' });
    const result = await first;
    expect(result.verification).toBe('untested');
    expect(result.message).toContain('changed while');
    expect(mockUpdateStatus).not.toHaveBeenCalledWith('cred-1', 'ok');
  });

  it('a verification that times out does not block the next sync', async () => {
    mockVerify
      .mockRejectedValueOnce(
        Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
      )
      .mockResolvedValueOnce({ valid: true, message: 'Connected successfully' });
    const first = await syncClaudeCodeCredential({ verify: true });
    expect(first.verification).toBe('fail');
    expect(first.message).toContain('Could not verify');
    mockListAll.mockResolvedValue([row]);
    const second = await syncClaudeCodeCredential({ verify: true });
    expect(second.verification).toBe('ok');
  });

  it('is a 404 when the keychain has no login', async () => {
    mockReadAuth.mockResolvedValue(null);
    await expect(syncClaudeCodeCredential({ verify: true })).rejects.toThrow(
      /No Claude Code login found/
    );
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('readUsableClaudeCliAuth', () => {
  it('ignores a login the CLI already considers expired', async () => {
    mockReadAuth.mockResolvedValue({ ...auth, expiresAt: Date.now() - 1 });
    expect(await readUsableClaudeCliAuth()).toBeNull();
    mockReadAuth.mockResolvedValue({ ...auth, expiresAt: Date.now() + 600_000 });
    expect(await readUsableClaudeCliAuth()).toMatchObject({ accessToken: auth.accessToken });
  });
});

describe('markClaudeCodeCredentialFailed', () => {
  it('flags only the managed Claude Code row, and only while it still holds the rejected token', async () => {
    mockListAll.mockResolvedValue([
      { ...row, id: 'api-key', authTypeId: 'anthropic:api-key' },
      manualRow,
      row,
    ]);
    expect(await markClaudeCodeCredentialFailed(auth.accessToken)).toBe('cred-1');
    expect(mockUpdateStatus).toHaveBeenCalledWith('cred-1', 'fail');
    mockUpdateStatus.mockClear();
    // A late 401 for the old token must not condemn the newer stored one.
    expect(await markClaudeCodeCredentialFailed('sk-ant-oat01-older')).toBeNull();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    mockListAll.mockResolvedValue([manualRow]);
    expect(await markClaudeCodeCredentialFailed(auth.accessToken)).toBeNull();
  });
});

describe('isClaudeCodeManagedSecret', () => {
  it('decides by credential identity when the caller resolved one', async () => {
    mockListAll.mockResolvedValue([manualRow, row]);
    expect(await isClaudeCodeManagedSecret('sk-ant-oat01-x', 'cred-1')).toBe(true);
    expect(await isClaudeCodeManagedSecret('sk-ant-oat01-x', 'manual-1')).toBe(false);
    expect(mockGetSecretById).not.toHaveBeenCalled();
  });
  it('falls back to comparing the secret with the managed row only', async () => {
    mockListAll.mockResolvedValue([manualRow, row]);
    mockGetSecretById.mockResolvedValue('sk-ant-oat01-mirrored');
    expect(await isClaudeCodeManagedSecret('sk-ant-oat01-mirrored')).toBe(true);
    expect(await isClaudeCodeManagedSecret('sk-ant-oat01-other-account')).toBe(false);
    expect(mockGetSecretById).toHaveBeenCalledWith('cred-1');
    mockListAll.mockResolvedValue([manualRow]);
    expect(await isClaudeCodeManagedSecret('sk-ant-oat01-mirrored')).toBe(false);
  });
});

describe('markCredentialAuthFailed', () => {
  it('marks any credential failed, but only while it still holds the rejected token', async () => {
    mockGetSecretById.mockResolvedValue('sk-ant-oat01-pasted');
    expect(await markCredentialAuthFailed('manual-1', 'sk-ant-oat01-pasted')).toBe(true);
    expect(mockUpdateStatus).toHaveBeenCalledWith('manual-1', 'fail');

    mockUpdateStatus.mockClear();
    mockGetSecretById.mockResolvedValue('sk-ant-oat01-replaced');
    expect(await markCredentialAuthFailed('manual-1', 'sk-ant-oat01-pasted')).toBe(false);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});
