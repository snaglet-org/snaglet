import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const query = jest.fn<(sql: string) => Promise<{ rows: Record<string, unknown>[] }>>();
const client = { query };
jest.mock('@snaglet/db/db', () => ({
  getDb: () => client,
  getDbClient: () => client,
  getBackupAdapter: jest.fn(),
  transaction: (work: (db: unknown) => Promise<unknown>) => work(client),
}));
jest.mock('@snaglet/db/migrations', () => ({
  pendingMigrationCount: jest.fn(),
  reapplySeedFiles: jest.fn(),
  reapplyProviderCatalogSeed: jest.fn(),
  reapplyLocalModelSeeds: jest.fn(),
  SEED_REPLAY_FILES: [],
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const renewWorkspaceId = jest.fn(async () => 'workspace-new');
jest.mock('@server/services/workspaceId', () => ({
  renewWorkspaceId: () => renewWorkspaceId(),
}));
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn(),
    syncToDatabase: async () => ({ errors: [] }),
  },
}));
import { getDbJobStatus, startReset } from '@server/services/DatabaseBackupService';

describe('DatabaseBackupService reset preservation', () => {
  beforeEach(() => {
    renewWorkspaceId.mockClear();
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM information_schema.tables')) {
        return {
          rows: [
            '_migrations',
            'table_catalog',
            'table_fields',
            'docs',
            'users',
            'feature_flags',
          ].map((table_name) => ({ table_name })),
        };
      }
      return { rows: [] };
    });
  });

  it.each(['content', 'all'] as const)(
    'preserves custom-table field metadata on %s reset',
    async (scope) => {
      startReset({ createBackup: false, scope });
      for (let attempt = 0; attempt < 100 && getDbJobStatus().running; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(getDbJobStatus()).toMatchObject({ running: false, error: null });
      const deletes = query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.startsWith('DELETE'));
      expect(deletes).toContain('DELETE FROM public."docs"');
      expect(deletes.some((sql) => /table_catalog|table_fields|_migrations/.test(sql))).toBe(false);
    }
  );

  it.each(['content', 'all'] as const)(
    'gives the workspace a new id after a %s reset, so windows drop panes saved for the old content',
    async (scope) => {
      startReset({ createBackup: false, scope });
      for (let attempt = 0; attempt < 100 && getDbJobStatus().running; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(getDbJobStatus()).toMatchObject({ running: false, error: null });
      expect(renewWorkspaceId).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps the feature flags (Home included) on a content reset', async () => {
    startReset({ createBackup: false, scope: 'content' });
    for (let attempt = 0; attempt < 100 && getDbJobStatus().running; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const deletes = query.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith('DELETE'));
    expect(deletes).toContain('DELETE FROM public."docs"');
    expect(deletes).not.toContain('DELETE FROM public."feature_flags"');
  });

  it('still succeeds when the new id cannot be saved', async () => {
    renewWorkspaceId.mockRejectedValueOnce(new Error('settings unwritable'));
    startReset({ createBackup: false, scope: 'content' });
    for (let attempt = 0; attempt < 100 && getDbJobStatus().running; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(getDbJobStatus()).toMatchObject({ running: false, error: null, requiresRestart: true });
  });
});
