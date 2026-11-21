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

type Progress = { onmessage: (message: unknown) => void };

function statusWithLatest(version: string) {
  return {
    currentVersion: '1.0.0',
    lastCheckedAt: null,
    latest: { version, url: RELEASE_URL, publishedAt: null, name: null },
    updateAvailable: true,
    lastError: null,
  };
}

/** The shell answers `app_update_support` with `support` and `install_app_update` with `install`. */
function shellAnswers(
  support: () => Promise<unknown>,
  install?: (args: { onProgress: Progress }) => unknown
) {
  shell.invoke.mockImplementation(async (command: string, args: { onProgress: Progress }) => {
    if (command === 'app_update_support') return support();
    if (command === 'install_app_update') return install?.(args);
    return undefined;
  });
}

beforeEach(() => {
  vi.mocked(appUpdateApi.status).mockResolvedValue(statusWithLatest('v9.9.9'));
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

function installs(): unknown[] {
  return shell.invoke.mock.calls.filter(([command]) => command === 'install_app_update');
}

describe('offering an update', () => {
  it('gives the reason and the release page in the browser shell', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useAppUpdateState());
    await act(() => offerAppUpdate('v9.9.9'));
    expect(result.current.offer).toBeNull();
    const [message, options] = lastToast();
    expect(message).toBe('The browser version doesn’t install updates.');
    options?.action?.run();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(RELEASE_URL, '_blank', 'noopener'));
  });

  it('only asks in the desktop app: nothing is installed until Install', async () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    shellAnswers(async () => undefined);
    const { result } = renderHook(() => useAppUpdateState());
    await act(() => offerAppUpdate('v9.9.9'));
    expect(result.current.offer).toBe('v9.9.9');
    act(() => dismissAppUpdateOffer());
    expect(result.current.offer).toBeNull();
    expect(installs()).toHaveLength(0);
  });

  it('gives the shell’s reason instead of asking where this copy cannot update', async () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    shellAnswers(async () => {
      throw { kind: 'unsupported', message: 'Snaglet Preview doesn’t install updates.' };
    });
    const { result } = renderHook(() => useAppUpdateState());
    await act(() => offerAppUpdate('v9.9.9'));
    expect(result.current.offer).toBeNull();
    const [message, options] = lastToast();
    expect(message).toBe('Snaglet Preview doesn’t install updates.');
    expect(options?.action?.label).toBe('Release page');
    expect(installs()).toHaveLength(0);
  });

  it('names the latest known release when it is newer than the notice', async () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    shellAnswers(async () => undefined);
    const { result } = renderHook(() => useAppUpdateState());
    vi.mocked(appUpdateApi.status).mockResolvedValue(statusWithLatest('v1.0.2'));
    await act(() => offerAppUpdate('v1.0.1'));
    expect(result.current.offer).toBe('v1.0.2');
    act(() => dismissAppUpdateOffer());
    vi.mocked(appUpdateApi.status).mockResolvedValue(statusWithLatest('v1.0.0'));
    await act(() => offerAppUpdate('v1.0.1'));
    expect(result.current.offer).toBe('v1.0.1');
  });
});

describe('installing in the desktop app', () => {
  beforeEach(() => vi.mocked(isTauriEnv).mockReturnValue(true));

  it('shows each step in one toast while the shell installs', async () => {
    shellAnswers(
      async () => undefined,
      ({ onProgress }) => {
        onProgress.onmessage({
          phase: 'downloading',
          version: '1.0.1',
          downloaded: 50,
          total: 200,
        });
        onProgress.onmessage({
          phase: 'downloading',
          version: '1.0.1',
          downloaded: 3e6,
          total: null,
        });
        onProgress.onmessage({ phase: 'installing', version: '1.0.1' });
        return '1.0.1';
      }
    );
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

  it('shows the reason, offers the release page, and keeps the failure until the next try', async () => {
    const { result } = renderHook(() => useAppUpdateState());
    shellAnswers(
      async () => undefined,
      () => {
        throw {
          kind: 'signatureRejected',
          message: 'The downloaded update failed its signature check.',
        };
      }
    );
    await act(async () => {
      await expect(confirmAppUpdate()).resolves.toBe(
        'The downloaded update failed its signature check.'
      );
    });
    const [message, options] = lastToast();
    expect(message).toBe('The downloaded update failed its signature check.');
    expect(options?.action?.label).toBe('Release page');
    expect(result.current.failure).toBe('The downloaded update failed its signature check.');
    options?.action?.run();
    await vi.waitFor(() =>
      expect(shell.invoke).toHaveBeenCalledWith('open_url', { url: RELEASE_URL })
    );

    // A new attempt clears it.
    let finish: (version: string) => void = () => {};
    shellAnswers(
      async () => undefined,
      () => new Promise<string>((resolve) => (finish = resolve))
    );
    let next: Promise<string> = Promise.resolve('');
    act(() => {
      next = confirmAppUpdate();
    });
    expect(result.current.failure).toBeNull();
    await vi.waitFor(() => expect(installs()).toHaveLength(2));
    await act(async () => {
      finish('1.0.1');
      await next;
    });
  });

  it('says so without a release page when Snaglet is already up to date', async () => {
    shellAnswers(
      async () => undefined,
      () => {
        throw { kind: 'upToDate', message: 'Snaglet is up to date.' };
      }
    );
    await confirmAppUpdate();
    const [message, options] = lastToast();
    expect(message).toBe('Snaglet is up to date.');
    expect(options?.action).toBeUndefined();
  });

  it('keeps the outcome when a progress step arrives late', async () => {
    let progress: Progress | undefined;
    shellAnswers(
      async () => undefined,
      ({ onProgress }) => {
        progress = onProgress;
        throw { kind: 'offline', message: 'Snaglet couldn’t reach GitHub.' };
      }
    );
    await confirmAppUpdate();
    progress?.onmessage({ phase: 'installing', version: '1.0.1' });
    expect(lastToast()[0]).toBe('Snaglet couldn’t reach GitHub.');
  });

  it('joins a running update and shows its progress again instead of asking', async () => {
    let finish: (version: string) => void = () => {};
    let progress: Progress | undefined;
    shellAnswers(
      async () => undefined,
      ({ onProgress }) =>
        new Promise<string>((resolve) => {
          progress = onProgress;
          finish = resolve;
        })
    );
    const { result } = renderHook(() => useAppUpdateState());
    let first: Promise<string> = Promise.resolve('');
    act(() => {
      first = confirmAppUpdate();
    });
    await vi.waitFor(() => expect(progress).toBeDefined());
    act(() =>
      progress?.onmessage({ phase: 'downloading', version: '1.0.1', downloaded: 1, total: 2 })
    );
    expect(result.current.running).toBe(true);
    expect(result.current.message).toBe('Downloading Snaglet 1.0.1… 50%');

    vi.mocked(showToast).mockClear();
    await act(() => offerAppUpdate('v1.0.1'));
    expect(result.current.offer).toBeNull();
    expect(lastToast()[0]).toBe('Downloading Snaglet 1.0.1… 50%');

    const second = confirmAppUpdate();
    await act(async () => finish('1.0.1'));
    await expect(first).resolves.toBe('updated to 1.0.1');
    await expect(second).resolves.toBe('updated to 1.0.1');
    expect(installs()).toHaveLength(1);
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
