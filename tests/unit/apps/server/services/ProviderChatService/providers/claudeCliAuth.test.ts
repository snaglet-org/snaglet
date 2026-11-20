/** Keychain payload parsing: only safe fields surface, expiry drives usability, reads are cached. */
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: unknown, out?: { stdout: string }) => void;
    mockExecFile(...args.slice(0, -1))
      .then((stdout: string) => cb(null, { stdout }))
      .catch((err: unknown) => cb(err));
  },
}));

import {
  forgetClaudeCliAuthCache,
  isClaudeCliAuthCurrent,
  parseClaudeCliAuth,
  readClaudeCliAuth,
  readClaudeCliAuthCached,
  tokenFingerprint,
} from '@server/services/ProviderChatService/providers/claudeCliAuth';

const payload = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-token',
      refreshToken: 'sk-ant-ort01-refresh',
      expiresAt: 1_800_000_000_000,
      scopes: ['user:inference', 7],
      subscriptionType: 'max',
      ...extra,
    },
  });

beforeEach(() => {
  jest.clearAllMocks();
  forgetClaudeCliAuthCache();
});

describe('parseClaudeCliAuth', () => {
  it('surfaces the access token and safe metadata but never the refresh token', () => {
    const auth = parseClaudeCliAuth(payload())!;
    expect(auth).toEqual({
      accessToken: 'sk-ant-oat01-token',
      expiresAt: 1_800_000_000_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      hasRefreshToken: true,
    });
    expect(JSON.stringify(auth)).not.toContain('refresh');
  });
  it('tolerates missing optional fields and rejects malformed payloads', () => {
    expect(parseClaudeCliAuth(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }))).toEqual({
      accessToken: 'x',
      expiresAt: undefined,
      scopes: undefined,
      subscriptionType: undefined,
      hasRefreshToken: false,
    });
    expect(parseClaudeCliAuth('not json')).toBeNull();
    expect(parseClaudeCliAuth(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
  });
});

describe('isClaudeCliAuthCurrent', () => {
  it('applies a one-minute skew before the CLI expiry', () => {
    const now = 1_000_000;
    const auth = parseClaudeCliAuth(payload({ expiresAt: now + 30_000 }))!;
    expect(isClaudeCliAuthCurrent(auth, now)).toBe(false);
    expect(isClaudeCliAuthCurrent({ ...auth, expiresAt: now + 90_000 }, now)).toBe(true);
    expect(isClaudeCliAuthCurrent({ ...auth, expiresAt: undefined }, now)).toBe(true);
  });
});

describe('readClaudeCliAuth', () => {
  it('shells out to security read-only with fixed arguments', async () => {
    mockExecFile.mockResolvedValue(payload());
    const auth = await readClaudeCliAuth();
    expect(auth?.accessToken).toBe('sk-ant-oat01-token');
    const [cmd, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('security');
    expect(args.slice(0, 3)).toEqual(['find-generic-password', '-s', 'Claude Code-credentials']);
    expect(args[args.length - 1]).toBe('-w');
  });
  it('returns null when the keychain entry is missing', async () => {
    mockExecFile.mockRejectedValue(new Error('The specified item could not be found'));
    expect(await readClaudeCliAuth()).toBeNull();
  });
  it('caches reads and refreshes on demand', async () => {
    mockExecFile.mockResolvedValue(payload());
    await readClaudeCliAuthCached();
    await readClaudeCliAuthCached();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    await readClaudeCliAuthCached(true);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

it('fingerprints are short, stable and non-reversible', () => {
  expect(tokenFingerprint('sk-ant-oat01-token')).toHaveLength(12);
  expect(tokenFingerprint('a')).toBe(tokenFingerprint('a'));
  expect(tokenFingerprint('a')).not.toBe(tokenFingerprint('b'));
});
