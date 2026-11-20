import { fetchData, getApiUrl } from './core';

interface DatabaseSetupState {
  mode: 'managed' | 'external';
  available: boolean;
  managed?: {
    state: 'uninitialized' | 'stopped' | 'stale' | 'running' | 'conflict';
    running: boolean;
    postgresVersion: string;
    pgvectorVersion: string;
    dataDir: string;
    sizeBytes: number;
    pid?: number;
    detail?: string;
  };
  external?: { configured: boolean; displayTarget: string | null };
}

export interface ExternalDatabaseTestResult {
  database: string;
  version: string;
  vectorInstalled: boolean;
  pgTrgmInstalled: boolean;
}

export const databaseSetupApi = {
  get: () => fetchData<DatabaseSetupState>(getApiUrl('/database-setup')),

  testExternal: (databaseUrl: string) =>
    fetchData<ExternalDatabaseTestResult>(getApiUrl('/database-setup/test-external'), {
      method: 'POST',
      body: JSON.stringify({ databaseUrl }),
      headers: { 'Content-Type': 'application/json' },
    }),

  /** Asks the server to exit; the supervisor restarts it. */
  restart: () =>
    fetchData<{ restarting: boolean }>(getApiUrl('/database-setup/restart'), {
      method: 'POST',
    }),
};
