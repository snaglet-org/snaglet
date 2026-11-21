/**
 * App updates in the UI: the one flow behind both the update notification and
 * Settings → Updates.
 *
 * `offerAppUpdate(version)` only asks: `AppUpdatePrompt` shows "Install and
 * restart?". Nothing is downloaded until `confirmAppUpdate()` (its Install
 * button) calls the shell's `install_app_update`
 * (apps/desktop/src-tauri/src/app_update.rs), which downloads, verifies,
 * installs and restarts. Each step shows in one toast and in Settings →
 * Updates; a failure shows the shell's reason and offers the release page. In
 * a browser, offering opens the release page instead.
 */

import { useSyncExternalStore } from 'react';
import { SNAGLET_REPOSITORY } from '@snaglet/shared/constants/release';
import { appUpdateApi } from './api';
import { isTauriEnv } from './tauriEnv';
import { showToast } from './toast';

const FALLBACK_RELEASES_URL = `https://github.com/${SNAGLET_REPOSITORY}/releases/latest`;
const TOAST_ID = 'app-update';
/** Long enough for a slow download; every progress step restarts it. */
const PROGRESS_TOAST_MS = 10 * 60_000;
const RESULT_TOAST_MS = 15_000;

/** The shell's `UpdateProgress`. */
type UpdateProgress =
  | { phase: 'checking' }
  | { phase: 'downloading'; version: string; downloaded: number; total: number | null }
  | { phase: 'installing'; version: string };

/** Outcomes where the release page would not help. */
const NO_RELEASE_PAGE = new Set(['upToDate', 'busy']);

interface AppUpdateState {
  /** The version the prompt asks about, or null while no prompt is open. */
  offer: string | null;
  /** True from Install until the outcome is known. */
  running: boolean;
  /** The latest step or outcome, as the toast shows it. */
  message: string | null;
}

let state: AppUpdateState = { offer: null, running: false, message: null };
const listeners = new Set<() => void>();

function setState(next: Partial<AppUpdateState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppUpdateState(): AppUpdateState {
  return useSyncExternalStore(subscribe, () => state);
}

function progressMessage(progress: UpdateProgress): string {
  switch (progress.phase) {
    case 'checking':
      return 'Checking for the Snaglet update…';
    case 'downloading': {
      const amount = progress.total
        ? `${Math.floor((progress.downloaded * 100) / progress.total)}%`
        : `${Math.round(progress.downloaded / 1_000_000)} MB`;
      return `Downloading Snaglet ${progress.version}… ${amount}`;
    }
    case 'installing':
      return `Installing Snaglet ${progress.version}. Snaglet will restart.`;
  }
}

/** The shell rejects with `{ kind, message }` (`UpdateError`). */
function failureOf(error: unknown): { kind: string; message: string } {
  if (error && typeof error === 'object') {
    const { kind, message } = error as { kind?: unknown; message?: unknown };
    if (typeof message === 'string' && message) {
      return { kind: typeof kind === 'string' ? kind : 'failed', message };
    }
  }
  return {
    kind: 'failed',
    message:
      typeof error === 'string' && error
        ? `The update could not be installed: ${error}`
        : 'The update could not be installed.',
  };
}

async function openReleasePage(url: string): Promise<void> {
  if (isTauriEnv()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_url', { url });
      return;
    } catch {
      // Shell command missing or failed: last-resort web fallback.
    }
  }
  window.open(url, '_blank', 'noopener');
}

function releasePageUrl(): Promise<string> {
  return appUpdateApi
    .status()
    .then((status) => status.latest?.url ?? FALLBACK_RELEASES_URL)
    .catch(() => FALLBACK_RELEASES_URL);
}

function showStep(message: string): void {
  setState({ message });
  showToast(message, { id: TOAST_ID, durationMs: PROGRESS_TOAST_MS });
}

let running: Promise<string> | null = null;

async function installInPlace(): Promise<string> {
  const releaseUrl = releasePageUrl();
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  let settled = false;
  const onProgress = new Channel<UpdateProgress>((progress) => {
    // A late step must not overwrite the outcome.
    if (!settled) showStep(progressMessage(progress));
  });
  showStep(progressMessage({ phase: 'checking' }));
  try {
    const version = await invoke<string>('install_app_update', { onProgress });
    settled = true;
    showStep(`Snaglet ${version} is installed. Restarting…`);
    return `updated to ${version}`;
  } catch (error) {
    settled = true;
    const failure = failureOf(error);
    const url = await releaseUrl;
    setState({ message: failure.message });
    showToast(failure.message, {
      id: TOAST_ID,
      durationMs: RESULT_TOAST_MS,
      ...(NO_RELEASE_PAGE.has(failure.kind)
        ? {}
        : { action: { label: 'Release page', run: () => void openReleasePage(url) } }),
    });
    return failure.message;
  }
}

/**
 * Ask whether to install `version` (a release tag). While an update is
 * already running this shows its current step again instead; in a browser it
 * opens the release page.
 */
export function offerAppUpdate(version: string): void {
  if (running) {
    if (state.message) showStep(state.message);
    return;
  }
  if (!isTauriEnv()) {
    void releasePageUrl().then(openReleasePage);
    return;
  }
  setState({ offer: version });
}

/** Later: close the prompt; nothing is downloaded. */
export function dismissAppUpdateOffer(): void {
  setState({ offer: null });
}

/**
 * Install: close the prompt and run the update. Resolves to a human-readable
 * outcome; a second call while it runs joins the running update.
 */
export function confirmAppUpdate(): Promise<string> {
  setState({ offer: null });
  if (!running) {
    setState({ running: true, message: null });
    running = installInPlace().finally(() => {
      running = null;
      setState({ running: false });
    });
  }
  return running;
}

/**
 * Why this copy of Snaglet cannot install updates itself (a browser, a
 * preview or development build, or an install location it cannot replace),
 * or null when it can. Asks the shell, which applies the same checks as an
 * install.
 */
export async function appUpdateUnsupportedReason(): Promise<string | null> {
  if (!isTauriEnv()) return 'The browser version doesn’t install updates.';
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('app_update_support');
    return null;
  } catch (error) {
    return failureOf(error).message;
  }
}
