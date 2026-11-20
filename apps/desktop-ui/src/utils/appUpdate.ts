/**
 * runAppUpdate — the "click to update" action behind app_update
 * notifications.
 *
 * In the Tauri shell it first tries the native in-place updater
 * (install_app_update → download, install, restart). Without a signed
 * release carrying updater artifacts that command fails fast, and this falls
 * back to opening the GitHub release page (default browser in Tauri, a new
 * tab in the browser shell).
 *
 * Returns a human-readable outcome for optional UI toasts. If the in-place
 * update succeeds the app restarts and the return value never matters.
 */

import { SNAGLET_REPOSITORY } from '@snaglet/shared/constants/release';
import { appUpdateApi } from './api';
import { isTauriEnv } from './tauriEnv';

const FALLBACK_RELEASES_URL = `https://github.com/${SNAGLET_REPOSITORY}/releases/latest`;

export async function runAppUpdate(): Promise<string> {
  const releaseUrl = await appUpdateApi
    .status()
    .then((s) => s.latest?.url ?? FALLBACK_RELEASES_URL)
    .catch(() => FALLBACK_RELEASES_URL);

  if (isTauriEnv()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const version = await invoke<string>('install_app_update');
      // Normally unreachable — install restarts the app.
      return `updated to ${version}`;
    } catch {
      // Updater dormant/failed — fall through to the release page.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_url', { url: releaseUrl });
        return 'opened release page';
      } catch {
        // Shell command missing/failed — last-resort web fallback.
      }
    }
  }

  window.open(releaseUrl, '_blank', 'noopener');
  return 'opened release page';
}
