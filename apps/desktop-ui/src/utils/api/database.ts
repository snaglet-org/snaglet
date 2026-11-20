import type { DbStatsResponse } from '@snaglet/shared/types';
import type { DbSnapshot, DbBackupJobStatus, DbPreUpdateCheckpoints } from './types';
import { getApiUrl, fetchJson, fetchData } from './core';

/** Backups (Settings → Data → Backups): database size plus snapshot jobs. */
export const databaseApi = {
  getStats: () => fetchJson<DbStatsResponse>(getApiUrl('/db/stats')),

  // These hit /api/admin/db/* which return the standard {success,data} envelope,
  // so they use fetchData to unwrap.

  /** Current backup/restore/reset job status (poll while one is running). */
  backupStatus: () => fetchData<DbBackupJobStatus>(getApiUrl('/admin/db/status')),

  /** Count and size of the packaged app's pre-update checkpoints. */
  preUpdateCheckpoints: () =>
    fetchData<DbPreUpdateCheckpoints>(getApiUrl('/admin/db/pre-update-checkpoints')),

  snapshots: {
    list: () => fetchData<DbSnapshot[]>(getApiUrl('/admin/db/snapshots')),

    create: (label?: string, format: 'custom' | 'plain-gzip' = 'custom') =>
      fetchData<DbBackupJobStatus>(getApiUrl('/admin/db/snapshots'), {
        method: 'POST',
        body: JSON.stringify({ label, format }),
      }),

    download: async (id: string): Promise<{ blob: Blob; fileName: string }> => {
      const response = await fetch(
        getApiUrl(`/admin/db/snapshots/${encodeURIComponent(id)}/download`)
      );
      if (!response.ok) throw new Error(`Snapshot download failed (HTTP ${response.status})`);
      const disposition = response.headers.get('content-disposition') ?? '';
      const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? `${id}.dump`;
      return { blob: await response.blob(), fileName };
    },

    restore: (id: string) =>
      fetchData<DbBackupJobStatus>(
        getApiUrl(`/admin/db/snapshots/${encodeURIComponent(id)}/restore`),
        { method: 'POST' }
      ),

    remove: (id: string) =>
      fetchData<{ ok: boolean }>(getApiUrl(`/admin/db/snapshots/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      }),
  },

  /** Clean-slate reset. Defaults: back up first, content-only scope. */
  reset: (opts: { createBackup?: boolean; scope?: 'content' | 'all' } = {}) =>
    fetchData<DbBackupJobStatus>(getApiUrl('/admin/db/reset'), {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
};
