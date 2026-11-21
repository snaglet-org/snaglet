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
  /** Why the most recent check failed, or null. */
  lastError: string | null;
}

export const appUpdateApi = {
  /** Cached snapshot — no network on the server side. */
  status: () => fetchJson<UpdateStatus>(getApiUrl('/server/update-status')),

  /** Check GitHub now (the server asks at most once a minute). */
  checkNow: () => fetchJson<UpdateStatus>(getApiUrl('/server/update-check'), { method: 'POST' }),
};
