import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SNAGLET_REPOSITORY } from '@snaglet/shared/constants/release';
import { appUpdateApi } from './api';
import {
  appUpdateUnsupportedReason,
  confirmAppUpdate,
  dismissAppUpdateOffer,
  offerAppUpdate,
  useAppUpdateState,
} from './appUpdate';
import { isTauriEnv } from './tauriEnv';
import { showToast } from './toast';

const shell = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('./api', () => ({ appUpdateApi: { status: vi.fn() } }));
vi.mock('./tauriEnv', () => ({ isTauriEnv: vi.fn(() => false) }));
vi.mock('./toast', () => ({ showToast: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: shell.invoke,
  Channel: class {
    constructor(public onmessage: (message: unknown) => void) {}
  },
}));

const RELEASE_URL = `https://github.com/${SNAGLET_REPOSITORY}/releases/tag/v9.9.9`;

beforeEach(() => {
  vi.mocked(appUpdateApi.status).mockResolvedValue({
    currentVersion: '1.0.0',
    lastCheckedAt: null,
    latest: { version: 'v9.9.9', url: RELEASE_URL, publishedAt: null, name: null },
    updateAvailable: true,
    lastError: null,
  });
});

afterEach(() => {
  dismissAppUpdateOffer();
  vi.restoreAllMocks();
  vi.mocked(isTauriEnv).mockReturnValue(false);
  vi.mocked(showToast).mockReset();
  shell.invoke.mockReset();
});

/** Every toast message shown, in order. */
function toasts(): string[] {
  return vi.mocked(showToast).mock.calls.map(([message]) => message);
}

/** The last toast shown: its message and options. */
function lastToast() {
  const calls = vi.mocked(showToast).mock.calls;
  return calls[calls.length - 1];
}

describe('offering an update', () => {
  it('opens the latest release page in the browser shell', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    offerAppUpdate('v9.9.9');
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(RELEASE_URL, '_blank', 'noopener'));
  });

  it('only asks in the desktop app: nothing is invoked until Install', () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    const { result } = renderHook(() => useAppUpdateState());
    act(() => offerAppUpdate('v1.0.1'));
    expect(result.current.offer).toBe('v1.0.1');
    act(() => dismissAppUpdateOffer());
    expect(result.current.offer).toBeNull();
    expect(shell.invoke).not.toHaveBeenCalled();
  });
});

describe('installing in the desktop app', () => {
  beforeEach(() => vi.mocked(isTauriEnv).mockReturnValue(true));

  it('shows each step in one toast while the shell installs', async () => {
    shell.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      expect(command).toBe('install_app_update');
      const progress = args.onProgress as { onmessage: (message: unknown) => void };
      progress.onmessage({ phase: 'downloading', version: '1.0.1', downloaded: 50, total: 200 });
      progress.onmessage({ phase: 'downloading', version: '1.0.1', downloaded: 3e6, total: null });
      progress.onmessage({ phase: 'installing', version: '1.0.1' });
      return '1.0.1';
    });
    await expect(confirmAppUpdate()).resolves.toBe('updated to 1.0.1');
    expect(toasts()).toEqual([
      'Checking for the Snaglet update…',
      'Downloading Snaglet 1.0.1… 25%',
      'Downloading Snaglet 1.0.1… 3 MB',
      'Installing Snaglet 1.0.1. Snaglet will restart.',
      'Snaglet 1.0.1 is installed. Restarting…',
    ]);
    for (const [, options] of vi.mocked(showToast).mock.calls) {
      expect(options?.id).toBe('app-update');
    }
  });

  it('shows the real reason and offers the release page when the update fails', async () => {
    shell.invoke.mockImplementation(async (command: string) => {
      if (command === 'install_app_update') {
        throw {
          kind: 'signatureRejected',
          message: 'The downloaded update failed its signature check.',
        };
      }
      return undefined;
    });
    await expect(confirmAppUpdate()).resolves.toBe(
      'The downloaded update failed its signature check.'
    );
    const [message, options] = lastToast();
    expect(message).toBe('The downloaded update failed its signature check.');
    expect(options?.action?.label).toBe('Release page');
    options?.action?.run();
    await vi.waitFor(() =>
      expect(shell.invoke).toHaveBeenCalledWith('open_url', { url: RELEASE_URL })
    );
  });

  it('says so without a release page when Snaglet is already up to date', async () => {
    shell.invoke.mockRejectedValue({ kind: 'upToDate', message: 'Snaglet is up to date.' });
    await confirmAppUpdate();
    const [message, options] = lastToast();
    expect(message).toBe('Snaglet is up to date.');
    expect(options?.action).toBeUndefined();
  });

  it('keeps the outcome when a progress step arrives late', async () => {
    let progress: { onmessage: (message: unknown) => void } | undefined;
    shell.invoke.mockImplementation(async (_command: string, args: Record<string, unknown>) => {
      progress = args.onProgress as typeof progress;
      throw { kind: 'offline', message: 'Snaglet couldn’t reach GitHub.' };
    });
    await confirmAppUpdate();
    progress?.onmessage({ phase: 'installing', version: '1.0.1' });
    expect(lastToast()[0]).toBe('Snaglet couldn’t reach GitHub.');
  });

  it('joins a running update and shows its progress again instead of asking', async () => {
    let finish: (version: string) => void = () => {};
    let progress: { onmessage: (message: unknown) => void } | undefined;
    shell.invoke.mockImplementation(
      (_command: string, args: Record<string, unknown>) =>
        new Promise<string>((resolve) => {
          progress = args.onProgress as typeof progress;
          finish = resolve;
        })
    );
    const { result } = renderHook(() => useAppUpdateState());
    let first: Promise<string> = Promise.resolve('');
    act(() => {
      first = confirmAppUpdate();
    });
    await vi.waitFor(() => expect(shell.invoke).toHaveBeenCalledTimes(1));
    act(() =>
      progress?.onmessage({ phase: 'downloading', version: '1.0.1', downloaded: 1, total: 2 })
    );
    expect(result.current.running).toBe(true);
    expect(result.current.message).toBe('Downloading Snaglet 1.0.1… 50%');

    vi.mocked(showToast).mockClear();
    act(() => offerAppUpdate('v1.0.1'));
    expect(result.current.offer).toBeNull();
    expect(lastToast()[0]).toBe('Downloading Snaglet 1.0.1… 50%');

    const second = confirmAppUpdate();
    await act(async () => finish('1.0.1'));
    await expect(first).resolves.toBe('updated to 1.0.1');
    await expect(second).resolves.toBe('updated to 1.0.1');
    expect(shell.invoke).toHaveBeenCalledTimes(1);
    expect(result.current.running).toBe(false);
  });
});

describe('whether this copy can update itself', () => {
  it('says the browser version does not install updates', async () => {
    await expect(appUpdateUnsupportedReason()).resolves.toMatch(/browser version/);
  });

  it('asks the shell and passes its reason on', async () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    shell.invoke.mockResolvedValueOnce(undefined);
    await expect(appUpdateUnsupportedReason()).resolves.toBeNull();
    expect(shell.invoke).toHaveBeenCalledWith('app_update_support');
    shell.invoke.mockRejectedValueOnce({
      kind: 'unsupported',
      message: 'Snaglet Preview doesn’t install updates.',
    });
    await expect(appUpdateUnsupportedReason()).resolves.toBe(
      'Snaglet Preview doesn’t install updates.'
    );
  });
});
