import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCredential } from '@desktop/utils/api';
import { GoogleOAuthFlow } from './GoogleOAuthFlow';

const mocks = vi.hoisted(() => ({
  getGoogleClientConfig: vi.fn(),
  listCredentials: vi.fn(),
  updateCredential: vi.fn(),
}));

vi.mock('@desktop/utils/api/providers', () => ({
  providersApi: {
    getGoogleClientConfig: mocks.getGoogleClientConfig,
    listCredentials: mocks.listCredentials,
    updateCredential: mocks.updateCredential,
    setGoogleClientConfig: vi.fn(),
    clearGoogleClientConfig: vi.fn(),
  },
}));
vi.mock('@desktop/utils/api/core', () => ({ getApiUrl: (path: string) => path }));

const google = (id: string): ProviderCredential =>
  ({ id, providerId: 'google-workspace', label: 'Google (me@example.com)' }) as ProviderCredential;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// The credentials list the server would answer with, and an optional gate that
// holds every answer back until released (a slow server).
let stored: ProviderCredential[] = [];
let gate: ReturnType<typeof deferred<void>> | null = null;

async function startConnect(onConnected = vi.fn(), onCancel = vi.fn()) {
  render(<GoogleOAuthFlow onConnected={onConnected} onCancel={onCancel} />);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
  await flush();
  return { onConnected, onCancel };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  stored = [];
  gate = null;
  mocks.listCredentials.mockImplementation(async () => {
    const snapshot = stored;
    if (gate) await gate.promise;
    return snapshot;
  });
  mocks.getGoogleClientConfig.mockResolvedValue({ configured: true, clientId: 'client-1' });
  mocks.updateCredential.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { url: 'https://accounts.google.test/consent' } }),
    })
  );
  vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GoogleOAuthFlow reconnecting', () => {
  it('does not report an existing connection as the new one before Google approves', async () => {
    stored = [google('old-credential')];
    const { onConnected } = await startConnect();

    await tick(2000);
    await tick(2000);

    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.queryByText(/Google Workspace connected/)).not.toBeInTheDocument();

    // The callback replaces the existing credential with a new one.
    stored = [google('new-credential')];
    await tick(2000);

    expect(onConnected).toHaveBeenCalledExactlyOnceWith(
      'new-credential',
      'Google (me@example.com)'
    );
  });

  it('still connects a first-time account', async () => {
    const { onConnected } = await startConnect();
    stored = [google('first-credential')];
    await tick(2000);

    expect(onConnected).toHaveBeenCalledExactlyOnceWith(
      'first-credential',
      'Google (me@example.com)'
    );
  });
});

describe('GoogleOAuthFlow overlapping checks', () => {
  it('reports one connection even when the credentials list answers slowly', async () => {
    const { onConnected } = await startConnect();
    stored = [google('new-credential')];
    gate = deferred<void>();

    await tick(6000); // three poll ticks while the first check is still waiting
    gate.resolve();
    await flush();

    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('does not connect after the user canceled while a check was in flight', async () => {
    const { onConnected, onCancel } = await startConnect();
    stored = [google('new-credential')];
    gate = deferred<void>();

    await tick(2000); // a check is now waiting on the slow list
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    gate.resolve();
    await flush();

    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.queryByText(/Google Workspace connected/)).not.toBeInTheDocument();
  });
});
