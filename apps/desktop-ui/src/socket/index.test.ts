/**
 * socketClient — the desktop-shell bridge for restart, move-home and the
 * folder picker. Tauri v2 exposes only `window.__TAURI_INTERNALS__` unless
 * `withGlobalTauri` is on, so detection must not depend on `__TAURI__`: the
 * packaged app would otherwise take the browser path for every operation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const restartMock = vi.fn();
const getMock = vi.fn();
vi.mock('@desktop/utils/api/database-setup', () => ({
  databaseSetupApi: {
    restart: () => restartMock(),
    get: () => getMock(),
  },
}));

const fetchJsonMock = vi.fn();
vi.mock('@desktop/utils/api/core', () => ({
  getApiUrl: (route: string) => `http://127.0.0.1:4001/api${route}`,
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

import { socketClient } from '.';

type TauriWindow = { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };

function markTauriWithoutGlobal() {
  (window as unknown as TauriWindow).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
  invokeMock.mockReset();
  restartMock.mockReset();
  getMock.mockReset();
  fetchJsonMock.mockReset();
  delete (window as unknown as TauriWindow).__TAURI_INTERNALS__;
  delete (window as unknown as TauriWindow).__TAURI__;
});

describe('socketClient inside the Tauri shell', () => {
  it('restarts through the shell, not the dev-server endpoint', async () => {
    markTauriWithoutGlobal();
    invokeMock.mockResolvedValue(undefined);

    await socketClient.restartApp();

    expect(invokeMock).toHaveBeenCalledWith('restart_app', undefined);
    expect(restartMock).not.toHaveBeenCalled();
  });

  it('moves the Snaglet home through the shell and surfaces its error', async () => {
    markTauriWithoutGlobal();
    invokeMock.mockRejectedValueOnce('Snaglet home destination must be empty');

    await expect(socketClient.moveSnagletHome('/Volumes/Test/Snaglet')).rejects.toBe(
      'Snaglet home destination must be empty'
    );
    expect(invokeMock).toHaveBeenCalledWith('move_snaglet_home', { path: '/Volumes/Test/Snaglet' });
  });

  it('uses the native folder picker', async () => {
    markTauriWithoutGlobal();
    invokeMock.mockResolvedValue('/Volumes/Test/Snaglet');

    await expect(socketClient.pickFolder()).resolves.toBe('/Volumes/Test/Snaglet');
    expect(invokeMock).toHaveBeenCalledWith('pick_folder', { title: null });
    await socketClient.pickFolder('Choose the export folder');
    expect(invokeMock).toHaveBeenLastCalledWith('pick_folder', {
      title: 'Choose the export folder',
    });
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });
});

describe('socketClient.saveDownload', () => {
  it('hands the bytes and an encoded suggested name to the shell', async () => {
    markTauriWithoutGlobal();
    invokeMock.mockResolvedValue('/Users/test-user/Desktop/café snapshot.dump');

    const saved = await socketClient.saveDownload(
      new Blob(['PGDMP']),
      'café snapshot.dump',
      'Save snapshot'
    );

    expect(saved).toBe('/Users/test-user/Desktop/café snapshot.dump');
    const [command, body, options] = invokeMock.mock.calls[0] as [
      string,
      Uint8Array,
      { headers: Record<string, string> },
    ];
    expect(command).toBe('save_download');
    expect(new TextDecoder().decode(body)).toBe('PGDMP');
    expect(options.headers).toEqual({
      'X-Snaglet-File-Name': 'caf%C3%A9%20snapshot.dump',
      'X-Snaglet-Dialog-Title': 'Save%20snapshot',
    });
  });

  it('is unavailable in a plain browser', async () => {
    await expect(
      socketClient.saveDownload(new Blob(['x']), 'snapshot.dump', 'Save snapshot')
    ).rejects.toThrow('desktop app');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('socketClient in a plain browser', () => {
  it('refuses to move the Snaglet home', async () => {
    await expect(socketClient.moveSnagletHome('/Volumes/Test/Snaglet')).rejects.toThrow(
      'available in the desktop app'
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('asks the local server for a folder', async () => {
    fetchJsonMock.mockResolvedValue({ path: '/Users/test-user/Snaglet' });

    await expect(socketClient.pickFolder()).resolves.toBe('/Users/test-user/Snaglet');
    expect(fetchJsonMock).toHaveBeenCalledWith('http://127.0.0.1:4001/api/server/pick-folder', {
      method: 'POST',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
