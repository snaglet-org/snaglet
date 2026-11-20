/**
 * How db.ts provisions and opens the agent SQL pools (two readers and the
 * workspace writer): managed mode provisions the roles once per open (on first
 * use, and again after migrations), url mode provisions nothing, and every
 * failure refuses the pool instead of falling back to the app pool.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

interface AdapterConfig {
  user?: string;
  password?: string;
  connectionString?: string;
  options?: string;
  application_name?: string;
}

const mockAdapters: { config: AdapterConfig; poolMax?: number; ended: boolean }[] = [];
const mockProvisionTables = jest.fn<(db: unknown, options: object) => Promise<void>>();
const mockProvisionWorkspace =
  jest.fn<
    (
      db: unknown,
      options: object
    ) => Promise<{ unclassified: string[]; withheldColumns: string[]; missing: string[] }>
  >();
const mockVerifyTables = jest.fn<(pool: unknown, label: string) => Promise<void>>();
const mockVerifyWorkspace = jest.fn<(pool: unknown) => Promise<void>>();
const mockProvisionWriter =
  jest.fn<(db: unknown, options: object) => Promise<{ customSchemaGranted: boolean }>>();
const mockVerifyWriter = jest.fn<(pool: unknown) => Promise<void>>();

jest.mock('@snaglet/db/migrations', () => ({
  bootstrapIfFresh: async () => false,
  pendingMigrationCount: async () => 0,
}));
jest.mock('@snaglet/db/runtime/load-env', () => ({ loadEnvFile: () => {} }));
jest.mock('@snaglet/db/runtime/postgres/startup-upgrade', () => ({
  upgradeManagedDatabase: async () => {},
}));
jest.mock('@snaglet/db/runtime/postgres/restore-swap', () => ({
  recoverInterruptedPostgresRestore: async () => {},
}));
jest.mock('@snaglet/db/runtime/postgres/runtime', () => ({
  stampPostgresDataDir: async () => {},
  bundledMigrationCount: () => 1,
  TABLES_READER_ROLE: 'snaglet_tables_reader',
  provisionTablesReaderRole: (db: unknown, options: object) => mockProvisionTables(db, options),
  PostgresRuntime: class {
    owned = false;
    dataDir = 'fixture-data-directory';
    snagletHome = 'fixture-home';
    async start(): Promise<void> {}
    async stopIfOwned(): Promise<void> {}
    async ensureTablesReaderHbaEntry(): Promise<void> {}
    async ensureWorkspaceReaderHbaEntry(): Promise<void> {}
    async ensureWorkspaceWriterHbaEntry(): Promise<void> {}
    async connectionInfo(): Promise<object> {
      return {
        host: 'fixture-socket-dir',
        database: 'snaglet',
        user: 'snaglet',
        password: 'fixture-app-password',
        readerPassword: 'fixture-tables-password',
        workspaceReaderPassword: 'fixture-workspace-password',
        workspaceWriterPassword: 'fixture-writer-password',
      };
    }
  },
}));
jest.mock('@snaglet/db/runtime/postgres/workspaceReader', () => ({
  WORKSPACE_READER_ROLE: 'snaglet_workspace_reader',
  WORKSPACE_READER_SEARCH_PATH: 'public, user_tables',
  provisionWorkspaceReaderRole: (db: unknown, options: object) =>
    mockProvisionWorkspace(db, options),
  assertReaderSessionRestricted: (pool: unknown, label: string) => mockVerifyTables(pool, label),
  assertWorkspaceReaderRestricted: (pool: unknown) => mockVerifyWorkspace(pool),
}));
jest.mock('@snaglet/db/runtime/postgres/workspaceWriter', () => ({
  WORKSPACE_WRITER_ROLE: 'snaglet_workspace_writer',
  WORKSPACE_WRITER_SEARCH_PATH: 'user_tables',
  provisionWorkspaceWriterRole: (db: unknown, options: object) => mockProvisionWriter(db, options),
  assertWorkspaceWriterRestricted: (pool: unknown) => mockVerifyWriter(pool),
}));
jest.mock('@snaglet/db/adapters', () => ({
  PostgresAdapter: class {
    private readonly record: { config: AdapterConfig; poolMax?: number; ended: boolean };
    constructor(config: AdapterConfig, dependencies?: { poolMax?: number }) {
      this.record = { config, poolMax: dependencies?.poolMax, ended: false };
      mockAdapters.push(this.record);
    }
    async end(): Promise<void> {
      this.record.ended = true;
    }
    async query(): Promise<{ rows: unknown[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    }
  },
  PostgresBackupAdapter: class {},
}));

import {
  closeDatabase,
  getDbClient,
  getTablesReaderClient,
  getWorkspaceReaderClient,
  getWorkspaceWriterPool,
  initializeDatabase,
} from '@snaglet/db/db';

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'SNAGLET_DATABASE_URL',
  'SNAGLET_DB_MODE',
  'SNAGLET_WORKSPACE_READER_URL',
  'SNAGLET_WORKSPACE_WRITER_URL',
  'SNAGLET_TABLES_READER_URL',
];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  mockAdapters.length = 0;
  mockProvisionTables.mockReset().mockResolvedValue();
  mockProvisionWorkspace
    .mockReset()
    .mockResolvedValue({ unclassified: [], withheldColumns: [], missing: [] });
  mockVerifyTables.mockReset().mockResolvedValue();
  mockVerifyWorkspace.mockReset().mockResolvedValue();
  mockProvisionWriter.mockReset().mockResolvedValue({ customSchemaGranted: true });
  mockVerifyWriter.mockReset().mockResolvedValue();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await closeDatabase();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  jest.restoreAllMocks();
});

const readerAdapters = () => mockAdapters.filter((adapter) => adapter.poolMax === 2);

describe('managed mode', () => {
  it('provisions both readers once on first use and opens a verified workspace pool', async () => {
    await getDbClient({ allowReopenAfterClose: true });
    const [workspace, again, tables] = await Promise.all([
      getWorkspaceReaderClient(),
      getWorkspaceReaderClient(),
      getTablesReaderClient(),
    ]);
    expect(workspace).not.toBeNull();
    expect(again).toBe(workspace);
    expect(tables).not.toBeNull();
    expect(mockProvisionTables).toHaveBeenCalledTimes(1);
    expect(mockProvisionWorkspace).toHaveBeenCalledTimes(1);
    expect(mockProvisionWorkspace.mock.calls[0]?.[1]).toEqual({
      password: 'fixture-workspace-password',
      database: 'snaglet',
      revokePublic: true,
    });
    expect(mockVerifyWorkspace).toHaveBeenCalledTimes(1);
    expect(mockVerifyTables).toHaveBeenCalledWith(expect.anything(), 'tables reader');

    const pools = readerAdapters();
    expect(pools.map((pool) => pool.config.user).sort()).toEqual([
      'snaglet_tables_reader',
      'snaglet_workspace_reader',
    ]);
    const workspacePool = pools.find((pool) => pool.config.user === 'snaglet_workspace_reader');
    expect(workspacePool?.config).toMatchObject({
      password: 'fixture-workspace-password',
      application_name: 'snaglet-workspace-reader',
      options: '-c default_transaction_read_only=on -c search_path=public,user_tables',
    });
  });

  it('provisions the workspace writer beside the readers and opens a read-write pool', async () => {
    await getDbClient({ allowReopenAfterClose: true });
    const [writer, again] = await Promise.all([getWorkspaceWriterPool(), getWorkspaceWriterPool()]);
    expect(writer).not.toBeNull();
    expect(again).toBe(writer);
    expect(mockProvisionWriter).toHaveBeenCalledTimes(1);
    expect(mockProvisionWriter.mock.calls[0]?.[1]).toEqual({
      password: 'fixture-writer-password',
      database: 'snaglet',
      revokePublic: true,
    });
    expect(mockVerifyWriter).toHaveBeenCalledTimes(1);
    const writerPool = readerAdapters().find(
      (pool) => pool.config.user === 'snaglet_workspace_writer'
    );
    expect(writerPool?.config).toMatchObject({
      password: 'fixture-writer-password',
      application_name: 'snaglet-workspace-writer',
      options: '-c search_path=user_tables',
    });
    expect(writerPool?.config.options).not.toContain('default_transaction_read_only');
  });

  it('refuses the writer when its provisioning fails, without touching the readers', async () => {
    mockProvisionWriter.mockRejectedValue(new Error('fixture provisioning failure'));
    await getDbClient({ allowReopenAfterClose: true });
    expect(await getWorkspaceWriterPool()).toBeNull();
    expect(await getWorkspaceReaderClient()).not.toBeNull();
    expect(readerAdapters().map((pool) => pool.config.user)).toEqual(['snaglet_workspace_reader']);
  });

  it('refuses and closes a writer pool whose session fails the sandbox check', async () => {
    mockVerifyWriter.mockRejectedValue(new Error('fixture: can reach public'));
    await getDbClient({ allowReopenAfterClose: true });
    expect(await getWorkspaceWriterPool()).toBeNull();
    expect(readerAdapters()).toHaveLength(1);
    expect(readerAdapters()[0]?.ended).toBe(true);
  });

  it('rebuilds reader grants after migrations at boot', async () => {
    await getDbClient({ allowReopenAfterClose: true });
    await initializeDatabase();
    expect(mockProvisionWorkspace).toHaveBeenCalledTimes(1);
    await getWorkspaceReaderClient();
    expect(mockProvisionWorkspace).toHaveBeenCalledTimes(1);
    await initializeDatabase();
    expect(mockProvisionWorkspace).toHaveBeenCalledTimes(2);
    expect(mockProvisionTables).toHaveBeenCalledTimes(2);
    expect(mockProvisionWriter).toHaveBeenCalledTimes(2);
  });

  it('refuses the workspace reader when provisioning fails, without touching the tables reader', async () => {
    mockProvisionWorkspace.mockRejectedValue(new Error('fixture provisioning failure'));
    await getDbClient({ allowReopenAfterClose: true });
    expect(await getWorkspaceReaderClient()).toBeNull();
    expect(await getTablesReaderClient()).not.toBeNull();
    expect(readerAdapters().map((pool) => pool.config.user)).toEqual(['snaglet_tables_reader']);
  });

  it('refuses and closes a pool whose session fails the sandbox check', async () => {
    mockVerifyWorkspace.mockRejectedValue(new Error('fixture: superuser'));
    await getDbClient({ allowReopenAfterClose: true });
    expect(await getWorkspaceReaderClient()).toBeNull();
    expect(readerAdapters()).toHaveLength(1);
    expect(readerAdapters()[0]?.ended).toBe(true);
  });

  it('ends the reader and writer pools when the database closes', async () => {
    await getDbClient({ allowReopenAfterClose: true });
    await getWorkspaceReaderClient();
    await getTablesReaderClient();
    await getWorkspaceWriterPool();
    await closeDatabase();
    expect(readerAdapters()).toHaveLength(3);
    expect(readerAdapters().every((pool) => pool.ended)).toBe(true);
  });
});

describe('url mode', () => {
  it('provisions nothing and refuses database_query without SNAGLET_WORKSPACE_READER_URL', async () => {
    process.env.SNAGLET_DATABASE_URL = 'postgresql://snaglet:fixture@127.0.0.1:1/snaglet';
    await getDbClient({ allowReopenAfterClose: true });
    expect(await getWorkspaceReaderClient()).toBeNull();
    expect(mockProvisionWorkspace).not.toHaveBeenCalled();
    expect(mockProvisionTables).not.toHaveBeenCalled();
    expect(readerAdapters()).toHaveLength(0);
  });

  it('provisions nothing and refuses database_execute without SNAGLET_WORKSPACE_WRITER_URL', async () => {
    process.env.SNAGLET_DATABASE_URL = 'postgresql://snaglet:fixture@127.0.0.1:1/snaglet';
    await getDbClient({ allowReopenAfterClose: true });
    expect(await getWorkspaceWriterPool()).toBeNull();
    expect(mockProvisionWriter).not.toHaveBeenCalled();
    expect(readerAdapters()).toHaveLength(0);
  });

  it('uses and verifies the operator-supplied writer URL', async () => {
    process.env.SNAGLET_DATABASE_URL = 'postgresql://snaglet:fixture@127.0.0.1:1/snaglet';
    process.env.SNAGLET_WORKSPACE_WRITER_URL = 'postgresql://writer:fixture@127.0.0.1:1/snaglet';
    await getDbClient({ allowReopenAfterClose: true });
    expect(await getWorkspaceWriterPool()).not.toBeNull();
    expect(mockProvisionWriter).not.toHaveBeenCalled();
    expect(mockVerifyWriter).toHaveBeenCalledTimes(1);
    expect(readerAdapters()[0]?.config.connectionString).toBe(
      'postgresql://writer:fixture@127.0.0.1:1/snaglet'
    );
  });

  it('rejects a malformed SNAGLET_WORKSPACE_WRITER_URL', async () => {
    process.env.SNAGLET_DATABASE_URL = 'postgresql://snaglet:fixture@127.0.0.1:1/snaglet';
    process.env.SNAGLET_WORKSPACE_WRITER_URL = 'mysql://writer@127.0.0.1/snaglet';
    await expect(getDbClient({ allowReopenAfterClose: true })).rejects.toThrow(
      'SNAGLET_WORKSPACE_WRITER_URL must use the postgres:// or postgresql:// scheme'
    );
  });

  it('uses and verifies the operator-supplied reader URL', async () => {
    process.env.SNAGLET_DATABASE_URL = 'postgresql://snaglet:fixture@127.0.0.1:1/snaglet';
    process.env.SNAGLET_WORKSPACE_READER_URL = 'postgresql://reader:fixture@127.0.0.1:1/snaglet';
    await getDbClient({ allowReopenAfterClose: true });
    expect(await getWorkspaceReaderClient()).not.toBeNull();
    expect(mockProvisionWorkspace).not.toHaveBeenCalled();
    expect(mockVerifyWorkspace).toHaveBeenCalledTimes(1);
    expect(readerAdapters()[0]?.config.connectionString).toBe(
      'postgresql://reader:fixture@127.0.0.1:1/snaglet'
    );
  });

  it('rejects a malformed SNAGLET_WORKSPACE_READER_URL', async () => {
    process.env.SNAGLET_DATABASE_URL = 'postgresql://snaglet:fixture@127.0.0.1:1/snaglet';
    process.env.SNAGLET_WORKSPACE_READER_URL = 'mysql://reader@127.0.0.1/snaglet';
    await expect(getDbClient({ allowReopenAfterClose: true })).rejects.toThrow(
      'SNAGLET_WORKSPACE_READER_URL must use the postgres:// or postgresql:// scheme'
    );
  });
});
