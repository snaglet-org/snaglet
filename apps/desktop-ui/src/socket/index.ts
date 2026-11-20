import { sleep } from '@snaglet/shared/utils';
import { isTauriEnv } from '@desktop/utils/tauriEnv';

interface SocketStatus {
  status: string;
  version: string;
  capabilities: string[];
}

interface SocketError {
  error: string;
}

type SocketResponse<T> = T | SocketError;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

const webStub = { error: 'not available in web mode' };

async function restartDevServerAndReload(): Promise<void> {
  const { databaseSetupApi } = await import('@desktop/utils/api/database-setup');
  try {
    await databaseSetupApi.restart();
  } catch {
    // The connection can drop before the response flushes; polling below
    // distinguishes an expected restart from a real failure.
  }

  const deadline = Date.now() + 90_000;
  await sleep(2500);
  while (Date.now() < deadline) {
    try {
      await databaseSetupApi.get();
      window.location.reload();
      return;
    } catch {
      await sleep(1500);
    }
  }

  throw new Error('Server did not come back within 90s — restart it manually (pnpm dev).');
}

export const socketClient = {
  async getStatus(): Promise<SocketResponse<SocketStatus>> {
    if (!isTauriEnv()) return webStub;
    return invoke<SocketStatus>('socket_status');
  },

  async readFile(path: string): Promise<SocketResponse<string>> {
    if (!isTauriEnv()) return webStub;
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    return readTextFile(path);
  },

  async writeFile(path: string, content: string): Promise<SocketResponse<void>> {
    if (!isTauriEnv()) return webStub;
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    return writeTextFile(path, content);
  },

  async restartApp(): Promise<void> {
    // Tauri shell: relaunch the desktop app so a changed SNAGLET_HOME takes effect
    // (the path is resolved once at startup). In a plain browser, ask the local
    // dev server to restart through the same endpoint used by DB Setup.
    if (isTauriEnv()) {
      await invoke<void>('restart_app');
      return;
    }
    await restartDevServerAndReload();
  },

  async moveSnagletHome(path: string): Promise<void> {
    if (!isTauriEnv()) throw new Error('Moving Snaglet home is available in the desktop app.');
    await invoke<void>('move_snaglet_home', { path });
  },

  async pickFolder(title?: string): Promise<string | null> {
    // Tauri shell: native dialog via the rfd-backed `pick_folder` command. The
    // title names the purpose (project folder, export folder, new Snaglet home); the
    // browser fallback has no title to set.
    if (isTauriEnv()) return invoke<string | null>('pick_folder', { title: title ?? null });
    // Browser: the Snaglet server runs locally, so ask it to open a native folder
    // dialog on the host and hand back the resolved absolute path.
    try {
      const { getApiUrl, fetchJson } = await import('@desktop/utils/api/core');
      const { path } = await fetchJson<{ path: string | null }>(getApiUrl('/server/pick-folder'), {
        method: 'POST',
      });
      return path ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Save bytes the page already holds through the shell's native save dialog.
   * WKWebView has no save dialog: a `download` link lands silently in
   * ~/Downloads (or fails), so the desktop app hands the bytes to the shell,
   * which lets the user pick where they go. Resolves to the saved path, or
   * null when the dialog is dismissed.
   */
  async saveDownload(blob: Blob, fileName: string, title: string): Promise<string | null> {
    if (!isTauriEnv()) throw new Error('Native save is available in the desktop app.');
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return tauriInvoke<string | null>('save_download', bytes, {
      headers: {
        'X-Snaglet-File-Name': encodeURIComponent(fileName),
        'X-Snaglet-Dialog-Title': encodeURIComponent(title),
      },
    });
  },
};
