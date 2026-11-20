import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provider, ProviderCredential } from '@desktop/utils/api';
import type { ClaudeCodeLoginSnapshot } from '@snaglet/shared/types';
import { useProviders } from './useProviders';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listCredentials: vi.fn(),
  saveCredential: vi.fn(),
  verifyCredential: vi.fn(),
  importCliCredential: vi.fn(),
  startClaudeCodeLogin: vi.fn(),
  getClaudeCodeLogin: vi.fn(),
  cancelClaudeCodeLogin: vi.fn(),
  deleteCredential: vi.fn(),
  showToast: vi.fn(),
  tauriInvoke: vi.fn(),
  fallbackList: vi.fn(),
  listForProvider: vi.fn(),
  agentsList: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  providersApi: {
    list: mocks.list,
    listCredentials: mocks.listCredentials,
    saveCredential: mocks.saveCredential,
    verifyCredential: mocks.verifyCredential,
    importCliCredential: mocks.importCliCredential,
    startClaudeCodeLogin: mocks.startClaudeCodeLogin,
    getClaudeCodeLogin: mocks.getClaudeCodeLogin,
    cancelClaudeCodeLogin: mocks.cancelClaudeCodeLogin,
    deleteCredential: mocks.deleteCredential,
  },
  providerFallbackCredentialsApi: { list: mocks.fallbackList },
  modelsApi: { listForProvider: mocks.listForProvider },
  agentsApi: { list: mocks.agentsList },
}));

vi.mock('@desktop/utils/toast', () => ({ showToast: mocks.showToast }));

// Only reached when a test stubs the Tauri globals; jsdom otherwise takes
// the `window.open` path.
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.tauriInvoke }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const apiKeyAuth = {
  id: 'codex:api-key',
  name: 'API Key',
  type: 'api_key',
  description: '',
  sortOrder: 0,
};
const codex = {
  id: 'codex',
  name: 'Codex',
  type: 'llm',
  sortOrder: 0,
  primaryCredentialId: null,
  authTypes: [apiKeyAuth],
} as unknown as Provider;

const claudeCodeAuth = {
  id: 'anthropic:claude-code-pro',
  name: 'Claude Code login',
  type: 'oauth',
  description: '',
  sortOrder: 1,
};
const anthropic = {
  id: 'anthropic',
  name: 'Anthropic',
  type: 'llm',
  sortOrder: 1,
  primaryCredentialId: null,
  authTypes: [{ ...apiKeyAuth, id: 'anthropic:api-key' }, claudeCodeAuth],
} as unknown as Provider;

const claudeCodeRow = (status: ProviderCredential['verificationStatus']): ProviderCredential => ({
  id: 'credential-claude-code',
  providerId: 'anthropic',
  authTypeId: claudeCodeAuth.id,
  authType: 'oauth',
  label: 'Claude Code login',
  hasSecret: true,
  updatedAt: '2026-07-29T12:00:00.000Z',
  verificationStatus: status,
});

const loginSnapshot = (
  patch: Partial<ClaudeCodeLoginSnapshot> & Pick<ClaudeCodeLoginSnapshot, 'state'>
): ClaudeCodeLoginSnapshot => ({
  id: 'login-session-1',
  startedAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z',
  ...patch,
});

const savedRow = (status: ProviderCredential['verificationStatus']): ProviderCredential => ({
  id: 'credential-1',
  providerId: 'codex',
  authTypeId: apiKeyAuth.id,
  authType: 'api_key',
  label: '',
  hasSecret: true,
  updatedAt: '2026-07-29T12:00:00.000Z',
  verificationStatus: status,
});

async function setup(providerId = 'codex') {
  const hook = renderHook(() => useProviders({ providerId }));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([codex, anthropic]);
  mocks.listCredentials.mockResolvedValue([]);
  mocks.fallbackList.mockResolvedValue([]);
  mocks.listForProvider.mockResolvedValue([]);
  mocks.agentsList.mockResolvedValue([]);
  mocks.saveCredential.mockResolvedValue(savedRow('untested'));
  mocks.importCliCredential.mockResolvedValue(savedRow('untested'));
});

describe('useProviders disconnect', () => {
  it('toasts what the server re-pointed off the deleted credential', async () => {
    mocks.listCredentials.mockResolvedValue([savedRow('ok')]);
    mocks.deleteCredential.mockResolvedValue({
      deleted: { id: 'credential-1', providerId: 'codex', label: 'Work key' },
      message: 'Moved the provider primary, 2 agents to "Backup key".',
    });
    const hook = await setup();

    await act(() => hook.result.current.disconnectCredential('credential-1'));

    expect(mocks.deleteCredential).toHaveBeenCalledWith('credential-1');
    expect(mocks.showToast).toHaveBeenCalledWith(
      'Moved the provider primary, 2 agents to "Backup key".',
      { durationMs: 5000 }
    );
    expect(hook.result.current.error).toBeNull();
  });

  it('stays quiet when nothing pointed at the deleted credential', async () => {
    mocks.deleteCredential.mockResolvedValue({
      deleted: { id: 'credential-1', providerId: 'codex', label: '' },
      message: null,
    });
    const hook = await setup();

    await act(() => hook.result.current.disconnectCredential('credential-1'));

    expect(mocks.deleteCredential).toHaveBeenCalledWith('credential-1');
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});

describe('useProviders provider switching', () => {
  it('keeps the newly selected provider models when the previous read answers late', async () => {
    const codexModels = deferred<unknown[]>();
    mocks.listForProvider.mockImplementation((providerId: string) =>
      providerId === 'codex'
        ? codexModels.promise
        : Promise.resolve([{ id: 'model-anthropic', providerId: 'anthropic' }])
    );
    const hook = renderHook(({ providerId }) => useProviders({ providerId }), {
      initialProps: { providerId: 'codex' },
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    hook.rerender({ providerId: 'anthropic' });
    await waitFor(() =>
      expect(hook.result.current.providerModels).toEqual([
        { id: 'model-anthropic', providerId: 'anthropic' },
      ])
    );

    await act(async () => {
      codexModels.resolve([{ id: 'model-codex', providerId: 'codex' }]);
      await codexModels.promise;
    });
    expect(hook.result.current.selectedProviderId).toBe('anthropic');
    expect(hook.result.current.providerModels).toEqual([
      { id: 'model-anthropic', providerId: 'anthropic' },
    ]);
  });
});

describe('useProviders Connect vs Test', () => {
  it('saves after a failed Test and reports the row as untested, not verified', async () => {
    mocks.verifyCredential.mockResolvedValue({ valid: false, message: 'model not allowed' });
    const { result } = await setup();

    act(() => result.current.patchDraft('codex', { secret: 'sk-test-123' }, apiKeyAuth.id));
    await act(() => result.current.testCredential(codex, apiKeyAuth));
    expect(result.current.verifyStates.codex).toEqual({
      status: 'fail',
      message: 'model not allowed',
    });

    await act(() => result.current.saveCredential(codex));

    expect(mocks.saveCredential).toHaveBeenCalledWith({
      providerId: 'codex',
      authTypeId: apiKeyAuth.id,
      authType: 'api_key',
      label: undefined,
      secret: 'sk-test-123',
      metadata: undefined,
    });
    expect(result.current.error).toBeNull();
    expect(result.current.verifyStates.codex.status).toBe('untested');
    expect(result.current.verifyStates.codex.message).toMatch(/Saved — not tested/);
    expect(result.current.getDraft(codex).secret).toBe('');
  });

  it('never upgrades a saved row to verified from a passing draft Test', async () => {
    mocks.verifyCredential.mockResolvedValue({ valid: true, message: 'ok' });
    const { result } = await setup();

    act(() => result.current.patchDraft('codex', { secret: 'sk-test-123' }, apiKeyAuth.id));
    await act(() => result.current.testCredential(codex, apiKeyAuth));
    expect(result.current.verifyStates.codex.status).toBe('ok');

    await act(() => result.current.saveCredential(codex));

    expect(result.current.verifyStates.codex.status).toBe('untested');
  });

  it('rejects a malformed Codex API key offline without calling the server', async () => {
    const { result } = await setup();

    act(() => result.current.patchDraft('codex', { secret: 'ghu_not_a_key' }, apiKeyAuth.id));
    await act(() => result.current.saveCredential(codex));

    expect(mocks.saveCredential).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Codex API keys start with "sk-".');
    expect(result.current.getDraft(codex).secret).toBe('ghu_not_a_key');
  });

  it('keeps the draft and the failed Test message when the server rejects the save', async () => {
    mocks.verifyCredential.mockResolvedValue({ valid: false, message: 'nope' });
    mocks.saveCredential.mockRejectedValue(new Error('Codex subscription requires refresh_token'));
    const { result } = await setup();

    act(() => result.current.patchDraft('codex', { secret: 'sk-test-123' }, apiKeyAuth.id));
    await act(() => result.current.testCredential(codex, apiKeyAuth));
    await act(() => result.current.saveCredential(codex));

    expect(result.current.error).toBe('Codex subscription requires refresh_token');
    expect(result.current.verifyStates.codex).toEqual({ status: 'fail', message: 'nope' });
    expect(result.current.getDraft(codex).secret).toBe('sk-test-123');
  });

  it('clears the draft once saved even when the list refresh fails', async () => {
    const { result } = await setup();
    mocks.listCredentials.mockRejectedValueOnce(new Error('list unavailable'));

    act(() => result.current.patchDraft('codex', { secret: 'sk-test-123' }, apiKeyAuth.id));
    await act(() => result.current.saveCredential(codex));

    expect(mocks.saveCredential).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('list unavailable');
    expect(result.current.getDraft(codex).secret).toBe('');
    expect(result.current.verifyStates.codex.status).toBe('untested');
    expect(result.current.savingProviderId).toBeNull();
  });

  it('reports a CLI import as untested rather than verified', async () => {
    const { result } = await setup();

    await act(() => result.current.importCliCredential('codex'));

    expect(mocks.importCliCredential).toHaveBeenCalledWith('codex');
    expect(result.current.verifyStates.codex.status).toBe('untested');
    expect(result.current.verifyStates.codex.message).toMatch(
      /Imported from local CLI login — not tested/
    );
  });

  it('reports an import as succeeded when only the list refresh fails', async () => {
    const { result } = await setup();
    mocks.listCredentials.mockRejectedValueOnce(new Error('list unavailable'));

    await act(() => result.current.importCliCredential('codex'));

    expect(mocks.importCliCredential).toHaveBeenCalledTimes(1);
    // The import landed, so it must not read as a failed import (which would
    // invite a second, duplicate import); the refresh failure is separate.
    expect(result.current.error).toBe('list unavailable');
    expect(result.current.error).not.toMatch(/Failed to import/);
    expect(result.current.verifyStates.codex.status).toBe('untested');
    expect(result.current.verifyStates.codex.message).toMatch(
      /Imported from local CLI login — not tested/
    );
    expect(result.current.savingProviderId).toBeNull();
  });

  it('still reports a failed import as a failed import', async () => {
    mocks.importCliCredential.mockRejectedValueOnce(new Error('no local login'));
    const { result } = await setup();

    await act(() => result.current.importCliCredential('codex'));

    expect(result.current.error).toBe('no local login');
    expect(result.current.verifyStates.codex?.message ?? '').not.toMatch(/Imported/);
    expect(result.current.savingProviderId).toBeNull();
  });
});

describe('useProviders Claude Code sign-in', () => {
  const openSpy = vi.fn<typeof window.open>();
  const authorizationUrl = 'https://auth.example.com/authorize';

  beforeEach(() => {
    vi.stubGlobal('open', openSpy);
    mocks.startClaudeCodeLogin.mockResolvedValue(loginSnapshot({ state: 'checking' }));
    mocks.getClaudeCodeLogin.mockResolvedValue(loginSnapshot({ state: 'waiting' }));
    mocks.cancelClaudeCodeLogin.mockResolvedValue(
      loginSnapshot({ state: 'cancelled', message: 'Sign-in canceled.' })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Tick the 2s poll interval once, flushing the async work it kicks off. */
  const tickPoll = () => act(() => vi.advanceTimersByTimeAsync(2000));

  it('connects from an existing login without a browser, refreshing lists and models', async () => {
    mocks.getClaudeCodeLogin.mockResolvedValue(
      loginSnapshot({
        state: 'connected',
        credentialId: 'credential-claude-code',
        message: 'Claude Code login connected and verified.',
      })
    );
    const { result } = await setup('anthropic');
    mocks.listCredentials.mockResolvedValue([claudeCodeRow('ok')]);
    const listCalls = mocks.list.mock.calls.length;
    const modelCalls = mocks.listForProvider.mock.calls.length;
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    expect(result.current.claudeCodeLogin).toEqual({
      status: 'checking',
      message: null,
      sessionId: 'login-session-1',
    });

    await tickPoll();

    expect(mocks.startClaudeCodeLogin).toHaveBeenCalledTimes(1);
    expect(mocks.getClaudeCodeLogin).toHaveBeenCalledWith('login-session-1');
    expect(openSpy).not.toHaveBeenCalled();
    expect(mocks.list.mock.calls.length).toBe(listCalls + 1);
    expect(mocks.listForProvider.mock.calls.length).toBe(modelCalls + 1);
    expect(mocks.listForProvider).toHaveBeenLastCalledWith('anthropic');
    expect(result.current.credentials).toEqual([claudeCodeRow('ok')]);
    expect(result.current.claudeCodeLogin).toEqual({
      status: 'connected',
      message: 'Claude Code login connected and verified.',
      sessionId: 'login-session-1',
    });
    expect(result.current.verifyStates.anthropic).toEqual({
      status: 'ok',
      message: 'Signed in with Claude Code — verified.',
    });

    // Terminal state stops the interval.
    await tickPoll();
    expect(mocks.getClaudeCodeLogin).toHaveBeenCalledTimes(1);
  });

  it('does not poll when the start response is already terminal', async () => {
    mocks.startClaudeCodeLogin.mockResolvedValue(
      loginSnapshot({ state: 'connected', credentialId: 'credential-claude-code' })
    );
    const { result } = await setup('anthropic');
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    await tickPoll();

    expect(result.current.claudeCodeLogin.status).toBe('connected');
    expect(mocks.getClaudeCodeLogin).not.toHaveBeenCalled();
  });

  it('polls checking → waiting (opening the URL when it appears) → connected', async () => {
    mocks.getClaudeCodeLogin
      .mockResolvedValueOnce(loginSnapshot({ state: 'checking' }))
      .mockResolvedValueOnce(loginSnapshot({ state: 'waiting', authorizationUrl }))
      .mockResolvedValueOnce(loginSnapshot({ state: 'waiting', authorizationUrl }))
      .mockResolvedValueOnce(loginSnapshot({ state: 'importing' }))
      .mockResolvedValueOnce(loginSnapshot({ state: 'verifying' }))
      .mockResolvedValueOnce(
        loginSnapshot({ state: 'connected', credentialId: 'credential-claude-code' })
      );
    const { result } = await setup('anthropic');
    mocks.listCredentials.mockResolvedValue([claudeCodeRow('ok')]);
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    expect(result.current.claudeCodeLogin.status).toBe('checking');
    expect(openSpy).not.toHaveBeenCalled();

    await tickPoll();
    expect(result.current.claudeCodeLogin.status).toBe('checking');
    expect(openSpy).not.toHaveBeenCalled();

    await tickPoll();
    expect(result.current.claudeCodeLogin.status).toBe('waiting');
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(authorizationUrl, '_blank', 'noopener,noreferrer');

    // The same URL is not re-opened on every poll.
    await tickPoll();
    expect(openSpy).toHaveBeenCalledTimes(1);

    await tickPoll();
    expect(result.current.claudeCodeLogin.status).toBe('importing');
    await tickPoll();
    expect(result.current.claudeCodeLogin.status).toBe('verifying');
    await tickPoll();
    expect(result.current.claudeCodeLogin.status).toBe('connected');
    expect(result.current.credentials).toEqual([claudeCodeRow('ok')]);
    expect(result.current.verifyStates.anthropic.status).toBe('ok');

    await tickPoll();
    expect(mocks.getClaudeCodeLogin).toHaveBeenCalledTimes(6);
  });

  it('opens the URL straight from the start response when the server already has it', async () => {
    mocks.startClaudeCodeLogin.mockResolvedValue(
      loginSnapshot({ state: 'waiting', authorizationUrl })
    );
    const { result } = await setup('anthropic');
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(result.current.claudeCodeLogin.status).toBe('waiting');
    await tickPoll();
    expect(mocks.getClaudeCodeLogin).toHaveBeenCalledWith('login-session-1');
  });

  it('surfaces the server message when the session fails and stops polling', async () => {
    mocks.getClaudeCodeLogin.mockResolvedValue(
      loginSnapshot({ state: 'failed', message: 'Claude authorization was denied.' })
    );
    const { result } = await setup('anthropic');
    const credentialCalls = mocks.listCredentials.mock.calls.length;
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    await tickPoll();

    expect(result.current.claudeCodeLogin).toEqual({
      status: 'failed',
      message: 'Claude authorization was denied.',
      sessionId: 'login-session-1',
    });
    expect(result.current.verifyStates.anthropic).toBeUndefined();
    expect(mocks.listCredentials.mock.calls.length).toBe(credentialCalls);

    await tickPoll();
    expect(mocks.getClaudeCodeLogin).toHaveBeenCalledTimes(1);
  });

  it('reports a failed start without polling', async () => {
    mocks.startClaudeCodeLogin.mockRejectedValue(new Error('claude CLI not installed'));
    const { result } = await setup('anthropic');
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    await tickPoll();

    expect(result.current.claudeCodeLogin).toEqual({
      status: 'failed',
      message: 'claude CLI not installed',
      sessionId: null,
    });
    expect(mocks.getClaudeCodeLogin).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('cancels through the API and stops polling', async () => {
    const { result } = await setup('anthropic');
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    await tickPoll();
    expect(mocks.getClaudeCodeLogin).toHaveBeenCalledTimes(1);

    await act(() => result.current.cancelClaudeCodeLogin());

    expect(mocks.cancelClaudeCodeLogin).toHaveBeenCalledWith('login-session-1');
    expect(result.current.claudeCodeLogin).toEqual({
      status: 'cancelled',
      message: 'Sign-in canceled.',
      sessionId: 'login-session-1',
    });

    await tickPoll();
    await tickPoll();
    expect(mocks.getClaudeCodeLogin).toHaveBeenCalledTimes(1);
  });

  it('cancels while the authorization URL is still being opened', async () => {
    // Tauri path: `open_url` is awaited, which is where Cancel can land.
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const openUrl = deferred<void>();
    mocks.tauriInvoke.mockReturnValue(openUrl.promise);
    mocks.startClaudeCodeLogin.mockResolvedValue(
      loginSnapshot({ state: 'waiting', authorizationUrl })
    );
    const { result } = await setup('anthropic');
    vi.useFakeTimers();

    let started: Promise<void> = Promise.resolve();
    await act(async () => {
      started = result.current.startClaudeCodeLogin();
      await vi.waitFor(() => expect(mocks.tauriInvoke).toHaveBeenCalledTimes(1));
    });
    expect(mocks.tauriInvoke).toHaveBeenCalledWith('open_url', { url: authorizationUrl });
    expect(result.current.claudeCodeLogin.status).toBe('waiting');

    await act(() => result.current.cancelClaudeCodeLogin());
    expect(mocks.cancelClaudeCodeLogin).toHaveBeenCalledWith('login-session-1');
    expect(result.current.claudeCodeLogin.status).toBe('cancelled');

    await act(async () => {
      openUrl.resolve();
      await started;
    });
    await tickPoll();
    await tickPoll();

    expect(result.current.claudeCodeLogin.status).toBe('cancelled');
    expect(mocks.getClaudeCodeLogin).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('ignores a start response that lands after unmount', async () => {
    const start = deferred<ClaudeCodeLoginSnapshot>();
    mocks.startClaudeCodeLogin.mockReturnValue(start.promise);
    const { result, unmount } = await setup('anthropic');
    vi.useFakeTimers();

    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = result.current.startClaudeCodeLogin();
    });
    expect(result.current.claudeCodeLogin.status).toBe('checking');
    unmount();

    await act(async () => {
      start.resolve(loginSnapshot({ state: 'waiting', authorizationUrl }));
      await started;
    });
    await tickPoll();
    await tickPoll();

    expect(openSpy).not.toHaveBeenCalled();
    expect(mocks.getClaudeCodeLogin).not.toHaveBeenCalled();
    expect(result.current.claudeCodeLogin).toEqual({
      status: 'checking',
      message: null,
      sessionId: null,
    });
  });

  it('ignores a stale rejected poll from a session the user already left', async () => {
    const stalePoll = deferred<ClaudeCodeLoginSnapshot>();
    mocks.getClaudeCodeLogin.mockReturnValueOnce(stalePoll.promise);
    const { result } = await setup('anthropic');
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    await tickPoll();
    expect(mocks.getClaudeCodeLogin).toHaveBeenCalledWith('login-session-1');

    await act(() => result.current.cancelClaudeCodeLogin());
    expect(result.current.claudeCodeLogin.status).toBe('cancelled');

    mocks.startClaudeCodeLogin.mockResolvedValue(
      loginSnapshot({ id: 'login-session-2', state: 'checking' })
    );
    mocks.getClaudeCodeLogin.mockResolvedValue(
      loginSnapshot({ id: 'login-session-2', state: 'waiting' })
    );
    await act(() => result.current.startClaudeCodeLogin());
    expect(result.current.claudeCodeLogin).toEqual({
      status: 'checking',
      message: null,
      sessionId: 'login-session-2',
    });

    await act(async () => {
      stalePoll.reject(new Error('session login-session-1 not found'));
      await Promise.resolve();
    });

    expect(result.current.claudeCodeLogin.status).toBe('checking');
    expect(result.current.claudeCodeLogin.sessionId).toBe('login-session-2');

    await tickPoll();
    expect(mocks.getClaudeCodeLogin).toHaveBeenLastCalledWith('login-session-2');
    expect(result.current.claudeCodeLogin.status).toBe('waiting');
  });

  it('ignores a second start while a sign-in is in flight', async () => {
    const { result } = await setup('anthropic');
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    await act(() => result.current.startClaudeCodeLogin());

    expect(mocks.startClaudeCodeLogin).toHaveBeenCalledTimes(1);
    expect(result.current.claudeCodeLogin.status).toBe('checking');
  });

  it('allows a fresh sign-in after a terminal state', async () => {
    mocks.getClaudeCodeLogin.mockResolvedValueOnce(
      loginSnapshot({ state: 'failed', message: 'Denied.' })
    );
    const { result } = await setup('anthropic');
    vi.useFakeTimers();

    await act(() => result.current.startClaudeCodeLogin());
    await tickPoll();
    expect(result.current.claudeCodeLogin.status).toBe('failed');

    await act(() => result.current.startClaudeCodeLogin());
    expect(mocks.startClaudeCodeLogin).toHaveBeenCalledTimes(2);
    expect(result.current.claudeCodeLogin.status).toBe('checking');

    await act(() => result.current.cancelClaudeCodeLogin());
  });
});

describe('useProviders local connection testing', () => {
  it.each(['ollama', 'lm-studio'])('tests %s without a credential', async (id) => {
    const local = { ...codex, id, name: id };
    mocks.list.mockResolvedValue([local]);
    mocks.verifyCredential.mockResolvedValue({ valid: true, message: 'Connected' });
    const { result } = await setup(id);
    await act(async () => result.current.testCredential(local, local.authTypes[0]));
    expect(mocks.verifyCredential).toHaveBeenCalledWith({
      providerId: id,
      secret: '',
      authType: undefined,
      metadata: undefined,
    });
    expect(mocks.saveCredential).not.toHaveBeenCalled();
  });

  it('continues to reject empty credentials for a cloud provider', async () => {
    const { result } = await setup();
    await act(async () => result.current.testCredential(codex, apiKeyAuth));
    expect(mocks.verifyCredential).not.toHaveBeenCalled();
  });
});

describe('useProviders GitHub Copilot draft', () => {
  const copilotOAuth = {
    ...claudeCodeAuth,
    id: 'copilot:subscription',
    name: 'GitHub OAuth',
    sortOrder: 0,
  };
  const copilotApiKey = { ...apiKeyAuth, id: 'copilot:api-key', sortOrder: 1 };
  const copilot = {
    ...codex,
    id: 'copilot',
    name: 'GitHub Copilot',
    authTypes: [copilotOAuth, copilotApiKey],
  } as unknown as Provider;

  it('starts on the API key type, since Sign in with GitHub sets its own', async () => {
    mocks.list.mockResolvedValue([codex, anthropic, copilot]);
    const { result } = await setup('copilot');

    expect(result.current.getDefaultAuthTypeId(copilot)).toBe(copilotApiKey.id);
    expect(result.current.getDraft(copilot).authTypeId).toBe(copilotApiKey.id);
    // Providers without Sign in with GitHub keep their first auth type.
    expect(result.current.getDefaultAuthTypeId(anthropic)).toBe('anthropic:api-key');
  });

  it('saves a device-flow token as GitHub OAuth, then resets the draft to the API key type', async () => {
    mocks.list.mockResolvedValue([codex, anthropic, copilot]);
    const { result } = await setup('copilot');

    act(() =>
      result.current.patchDraft(
        'copilot',
        { authTypeId: copilotOAuth.id, secret: 'gho_device_token' },
        result.current.getDefaultAuthTypeId(copilot)
      )
    );
    await act(() => result.current.saveCredential(copilot));

    expect(mocks.saveCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'copilot',
        authTypeId: copilotOAuth.id,
        authType: 'oauth',
        secret: 'gho_device_token',
      })
    );
    expect(result.current.getDraft(copilot)).toMatchObject({
      authTypeId: copilotApiKey.id,
      secret: '',
    });
    expect(result.current.verifyStates.copilot.status).toBe('untested');
  });
});
