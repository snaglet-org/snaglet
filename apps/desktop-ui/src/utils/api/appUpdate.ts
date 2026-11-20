/**
 * appUpdateApi — client for the daily GitHub-release update check.
 *
 * Note: /api/server/* routes respond with raw JSON (no ApiResponse
 * envelope), hence fetchJson rather than fetchData.
 */

import { fetchJson, getApiUrl } from './core';

interface LatestRelease {
  version: string;
  url: string;
  publishedAt: string | null;
  name: string | null;
}

interface UpdateStatus {
  currentVersion: string;
  lastCheckedAt: string | null;
  latest: LatestRelease | null;
  updateAvailable: boolean;
}

export const appUpdateApi = {
  /** Cached snapshot — no network on the server side. */
  status: () => fetchJson<UpdateStatus>(getApiUrl('/server/update-status')),

  /** Force a real GitHub check now. */
  checkNow: () => fetchJson<UpdateStatus>(getApiUrl('/server/update-check'), { method: 'POST' }),
};
