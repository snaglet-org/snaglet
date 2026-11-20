/**
 * Claude Code sign-in sessions: the CLI process, keychain reads, preflight
 * and completion are all faked, so every outcome (adopt-without-browser, URL
 * hand-off, success, denial, timeout, cancel at each phase, missing CLI,
 * keychain rotation while the CLI lingers, duplicate starts) is exercised
 * without a browser or a real login.
 */
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/ProviderChatService/providers/claudeCliAuth', () => {
  const actual = jest.requireActual('@server/services/ProviderChatService/providers/claudeCliAuth');
  return { ...actual, readClaudeCliAuth: jest.fn(async () => null) };
});

import {
  ClaudeCodeLoginService,
  LOGIN_MESSAGES,
  findAuthorizationUrl,
  scrubSecrets,
} from '@server/services/ClaudeCodeAuthService/loginSession';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = jest.fn((signal?: string) => {
    this.signalCode = signal ?? 'SIGTERM';
    return true;
  });
  exit(code: number | null, signal: string | null = null) {
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};
const connected = { ok: true, message: 'connected', credentialId: 'cred-1' };

function make(overrides: {
  complete?: jest.Mock;
  preflight?: jest.Mock;
  readAuth?: jest.Mock;
  spawnLogin?: () => ChildProcess;
  timeoutMs?: number;
  completionTimeoutMs?: number;
}) {
  const child = new FakeChild();
  const complete = overrides.complete ?? jest.fn(async () => connected);
  const preflight = overrides.preflight ?? jest.fn(async () => null);
  const spawnLogin = jest.fn(overrides.spawnLogin ?? (() => child as unknown as ChildProcess));
  const service = new ClaudeCodeLoginService({
    spawnLogin,
    readAuth: overrides.readAuth ?? jest.fn(async () => null),
    preflight,
    complete,
    timeoutMs: overrides.timeoutMs ?? 60_000,
    completionTimeoutMs: overrides.completionTimeoutMs ?? 10_000,
  });
  return { service, child, complete, preflight, spawnLogin };
}

/** Start and let the (null) preflight pass so the CLI is spawned. */
async function startWaiting(service: ClaudeCodeLoginService) {
  const snap = service.start();
  await flush();
  expect(service.status(snap.id)?.state).toBe('waiting');
  return snap;
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }));
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('ClaudeCodeLoginService', () => {
  it('registers the session synchronously in checking and connects from preflight without a browser', async () => {
    const preflight = jest.fn(async () => connected);
    const { service, spawnLogin } = make({ preflight });
    const snap = service.start();
    expect(snap.state).toBe('checking');
    expect(service.status(snap.id)?.state).toBe('checking');
    await flush();
    expect(service.status(snap.id)).toMatchObject({ state: 'connected', credentialId: 'cred-1' });
    expect(spawnLogin).not.toHaveBeenCalled();
    expect(service.active).toBe(false);
  });

  it('falls through to the CLI when preflight finds nothing usable or throws', async () => {
    const preflight = jest.fn(async () => {
      throw new Error('keychain unreadable sk-ant-oat01-SECRET');
    });
    const { service, spawnLogin } = make({ preflight });
    const snap = service.start();
    await flush();
    expect(service.status(snap.id)?.state).toBe('waiting');
    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  it('surfaces the authorization URL the CLI prints and connects when it exits 0', async () => {
    const { service, child, complete } = make({});
    const snap = await startWaiting(service);
    child.stdout.emit(
      'data',
      'Opening https://claude.ai/oauth/authorize?code=true&state=abc in your browser\n'
    );
    expect(service.status(snap.id)?.authorizationUrl).toBe(
      'https://claude.ai/oauth/authorize?code=true&state=abc'
    );
    child.exit(0);
    await flush();
    expect(service.status(snap.id)).toMatchObject({ state: 'connected', credentialId: 'cred-1' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('waits for the URL terminator when the CLI splits a URL across chunks', async () => {
    const { service, child } = make({});
    const snap = await startWaiting(service);
    child.stdout.emit('data', 'Open https://claude.ai/oauth/auth');
    expect(service.status(snap.id)?.authorizationUrl).toBeUndefined();
    child.stdout.emit('data', 'orize?client=snaglet&state=1');
    expect(service.status(snap.id)?.authorizationUrl).toBeUndefined();
    child.stdout.emit('data', ' to continue\n');
    expect(service.status(snap.id)?.authorizationUrl).toBe(
      'https://claude.ai/oauth/authorize?client=snaglet&state=1'
    );
  });

  it('publishes a URL printed without a trailing newline once the CLI exits', async () => {
    const { service, child } = make({});
    const snap = await startWaiting(service);
    child.stdout.emit('data', 'https://claude.ai/oauth/authorize?client=snaglet');
    expect(service.status(snap.id)?.authorizationUrl).toBeUndefined();
    child.exit(0);
    await flush();
    expect(service.status(snap.id)?.authorizationUrl).toBe(
      'https://claude.ai/oauth/authorize?client=snaglet'
    );
  });

  it('reports a failed import when the post-login sync says the token is bad', async () => {
    const complete = jest.fn(async () => ({ ok: false, message: 'Authentication failed (401)' }));
    const { service, child } = make({ complete });
    const snap = await startWaiting(service);
    child.exit(0);
    await flush();
    expect(service.status(snap.id)).toMatchObject({
      state: 'failed',
      message: 'Authentication failed (401)',
    });
  });

  it('fails with a fixed message — never CLI output — when the browser flow is denied', async () => {
    const { service, child, complete } = make({});
    const snap = await startWaiting(service);
    child.stderr.emit('data', 'Error: access denied by user (token sk-ant-oat01-SECRET)\n');
    child.exit(1);
    await flush();
    const done = service.status(snap.id)!;
    expect(done).toMatchObject({ state: 'failed', message: LOGIN_MESSAGES.denied });
    expect(JSON.stringify(done)).not.toContain('SECRET');
    expect(complete).not.toHaveBeenCalled();
  });

  it('times out from creation even if the initial keychain read never returns', async () => {
    const readAuth = jest.fn(() => new Promise<null>(() => undefined));
    const { service, spawnLogin } = make({ readAuth, timeoutMs: 1_000 });
    const snap = service.start();
    await flush();
    jest.advanceTimersByTime(1_001);
    expect(service.status(snap.id)).toMatchObject({
      state: 'timed_out',
      message: LOGIN_MESSAGES.timedOut,
    });
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  it('times out, kills the CLI, and stays timed_out through a late exit', async () => {
    const { service, child } = make({ timeoutMs: 1_000 });
    const snap = await startWaiting(service);
    jest.advanceTimersByTime(1_001);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(service.status(snap.id)?.state).toBe('timed_out');
    child.exit(null, 'SIGTERM');
    await flush();
    expect(service.status(snap.id)?.state).toBe('timed_out');
  });

  it('cancel during preflight is terminal and prevents the spawn', async () => {
    let release: (value: null) => void = () => undefined;
    const preflight = jest.fn(() => new Promise<null>((resolve) => (release = resolve)));
    const { service, spawnLogin, complete } = make({ preflight });
    const snap = service.start();
    expect(service.cancel(snap.id)?.state).toBe('cancelled');
    release(null);
    await flush();
    expect(spawnLogin).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(service.status(snap.id)?.state).toBe('cancelled');
  });

  it('cancel stops the process and stays canceled even if the CLI then exits 0', async () => {
    const { service, child, complete } = make({});
    const snap = await startWaiting(service);
    expect(service.cancel('nope')).toBeNull();
    expect(service.cancel(snap.id)?.state).toBe('cancelled');
    expect(child.kill).toHaveBeenCalled();
    child.exit(0);
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(service.status(snap.id)?.state).toBe('cancelled');
  });

  it('a keychain poll that resolves after cancellation cannot flip the outcome', async () => {
    type Auth = { accessToken: string; hasRefreshToken: boolean };
    let releaseRead: (value: Auth) => void = () => undefined;
    const readAuth = jest
      .fn()
      .mockResolvedValueOnce({ accessToken: 'sk-ant-oat01-old', hasRefreshToken: true })
      .mockImplementation(() => new Promise<Auth>((resolve) => (releaseRead = resolve)));
    const { service, complete } = make({ readAuth });
    const snap = await startWaiting(service);
    jest.advanceTimersByTime(3_000);
    await flush();
    service.cancel(snap.id);
    releaseRead({ accessToken: 'sk-ant-oat01-new', hasRefreshToken: true });
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(service.status(snap.id)?.state).toBe('cancelled');
  });

  it('a cancel while importing is reported, and the late completion result is dropped', async () => {
    let release: (value: typeof connected) => void = () => undefined;
    const complete = jest.fn(() => new Promise<typeof connected>((resolve) => (release = resolve)));
    const { service, child } = make({ complete });
    const snap = await startWaiting(service);
    child.exit(0);
    await flush();
    expect(service.status(snap.id)?.state).toBe('verifying');
    expect(service.cancel(snap.id)?.state).toBe('cancelled');
    release(connected);
    await flush();
    expect(service.status(snap.id)?.state).toBe('cancelled');
  });

  it('bounds the import/verify step after the browser flow', async () => {
    const complete = jest.fn(() => new Promise<never>(() => undefined));
    const { service, child } = make({ complete, completionTimeoutMs: 5_000 });
    const snap = await startWaiting(service);
    child.exit(0);
    await flush();
    expect(service.status(snap.id)?.state).toBe('verifying');
    jest.advanceTimersByTime(5_001);
    await flush();
    expect(service.status(snap.id)).toMatchObject({
      state: 'failed',
      message: LOGIN_MESSAGES.importTimedOut,
    });
  });

  it('reports a fixed message when the import step throws', async () => {
    const complete = jest.fn(async () => {
      throw new Error('db down sk-ant-oat01-SECRET');
    });
    const { service, child } = make({ complete });
    const snap = await startWaiting(service);
    child.exit(0);
    await flush();
    expect(service.status(snap.id)).toMatchObject({
      state: 'failed',
      message: LOGIN_MESSAGES.importFailed,
    });
  });

  it('dedupes starts across checking, waiting and verifying; a settled session can be restarted', async () => {
    let release: (value: null) => void = () => undefined;
    const preflight = jest
      .fn()
      .mockImplementationOnce(() => new Promise<null>((resolve) => (release = resolve)))
      .mockResolvedValue(null);
    const { service, child, preflight: pf, spawnLogin } = make({ preflight });
    const a = service.start();
    expect(service.start().id).toBe(a.id); // checking
    release(null);
    await flush();
    expect(service.status(a.id)?.state).toBe('waiting');
    expect(service.start().id).toBe(a.id); // waiting
    expect(pf).toHaveBeenCalledTimes(1);
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    child.exit(0);
    await flush();
    expect(service.status(a.id)?.state).toBe('connected');
    const b = service.start();
    expect(b.id).not.toBe(a.id);
    expect(pf).toHaveBeenCalledTimes(2);
  });

  it('treats a rotated keychain token as success even while the CLI lingers', async () => {
    const readAuth = jest
      .fn()
      .mockResolvedValueOnce({ accessToken: 'sk-ant-oat01-old', hasRefreshToken: true })
      .mockResolvedValue({ accessToken: 'sk-ant-oat01-new', hasRefreshToken: true });
    const { service, child, complete } = make({ readAuth });
    const snap = await startWaiting(service);
    await jest.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(child.kill).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(service.status(snap.id)?.state).toBe('connected');
  });

  it('explains a missing CLI with a fixed message', async () => {
    const { service } = make({
      spawnLogin: () => {
        const child = new FakeChild();
        setImmediate(() =>
          child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
        );
        return child as unknown as ChildProcess;
      },
    });
    const snap = service.start();
    await flush();
    expect(service.status(snap.id)).toMatchObject({
      state: 'failed',
      message: LOGIN_MESSAGES.missingCli,
    });
  });

  it('shutdown cancels an in-flight sign-in', async () => {
    const { service, child } = make({});
    const snap = await startWaiting(service);
    service.shutdown();
    expect(child.kill).toHaveBeenCalled();
    expect(service.status(snap.id)?.state).toBe('cancelled');
  });
});

describe('helpers', () => {
  it('scrubs tokens and OAuth codes', () => {
    expect(scrubSecrets('token sk-ant-oat01-abc_DEF and ?code=xyz&state=1')).toBe(
      'token sk-ant-… and ?code=…&state=1'
    );
  });
  it('only accepts Anthropic-owned authorization hosts without token material', () => {
    expect(findAuthorizationUrl('go to https://evil.example/phish?x=1 now')).toBeUndefined();
    expect(
      findAuthorizationUrl('https://claude.ai/cb?access_token=sk-ant-oat01-x ')
    ).toBeUndefined();
    expect(findAuthorizationUrl('https://claude.ai/cb#code=abcdefghijkl&state=1 ')).toBeUndefined();
    expect(findAuthorizationUrl('https://claude.ai/cb?code=abcdefghijkl&state=1 ')).toBeUndefined();
    expect(findAuthorizationUrl('https://claude.ai/cb?Access_Token=abc ')).toBeUndefined();
    expect(findAuthorizationUrl('https://claude.ai/cb#CODE=abcdefghijkl ')).toBeUndefined();
    expect(findAuthorizationUrl('https://claude.ai/cb?code=abc ')).toBeUndefined();
    expect(findAuthorizationUrl('https://claude.ai/cb?code=TRUE ')).toBeUndefined();
    expect(findAuthorizationUrl('https://user:pw@claude.ai/oauth/authorize?a=1 ')).toBeUndefined();
    // The real authorize URL carries `code=true` as a flag, not a secret.
    expect(
      findAuthorizationUrl('https://claude.ai/oauth/authorize?code=true&response_type=code&state=1')
    ).toBe('https://claude.ai/oauth/authorize?code=true&response_type=code&state=1');
    expect(findAuthorizationUrl('see https://console.anthropic.com/oauth/authorize?a=b.')).toBe(
      'https://console.anthropic.com/oauth/authorize?a=b.'
    );
    // Still arriving: a URL that runs to the end of the text is skipped unless told it is complete.
    expect(findAuthorizationUrl('https://claude.ai/oauth/auth', false)).toBeUndefined();
    expect(findAuthorizationUrl('https://claude.ai/oauth/auth', true)).toBe(
      'https://claude.ai/oauth/auth'
    );
  });
});
