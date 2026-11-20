import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';

const mockBootstrap = jest.fn<() => Promise<boolean>>();
const mockStamp = jest.fn<() => Promise<void>>();
const mockUpgrade = jest.fn<() => Promise<void>>();
const mockStart = jest.fn<() => Promise<void>>();
const mockStop = jest.fn<() => Promise<void>>();
const mockAdapter = jest.fn<() => void>();
const mockAdapterEnd = jest.fn<() => Promise<void>>();
const mockAdapterQuery = jest.fn<() => Promise<void>>();
let mockOwned = true;
let backupLifecycle:
  | {
      quiesce: () => Promise<void>;
      reconnect: () => Promise<void>;
      resume: () => void;
      failSwap: (error: unknown) => void;
    }
  | undefined;

jest.mock('@snaglet/db/migrations', () => ({
  bootstrapIfFresh: () => mockBootstrap(),
  pendingMigrationCount: async () => 0,
}));
jest.mock('@snaglet/db/runtime/load-env', () => ({ loadEnvFile: () => {} }));
jest.mock('@snaglet/db/runtime/postgres/startup-upgrade', () => ({
  upgradeManagedDatabase: () => mockUpgrade(),
}));
jest.mock('@snaglet/db/runtime/postgres/restore-swap', () => ({
  recoverInterruptedPostgresRestore: async () => {},
}));
jest.mock('@snaglet/db/runtime/postgres/runtime', () => ({
  stampPostgresDataDir: (...args: unknown[]) => Reflect.apply(mockStamp, undefined, args),
  bundledMigrationCount: () => 1,
  PostgresRuntime: class {
    owned = mockOwned;
    dataDir = 'fixture-data-directory';
    snagletHome = 'fixture-home';
    async start(): Promise<void> {
      await mockStart();
    }
    async stopIfOwned(): Promise<void> {
      await mockStop();
    }
    async connectionInfo(): Promise<object> {
      return {
        host: '127.0.0.1',
        port: 45678,
        database: 'snaglet',
        user: 'snaglet',
        password: 'fixture',
      };
    }
  },
}));
jest.mock('@snaglet/db/adapters', () => ({
  PostgresAdapter: class {
    constructor() {
      mockAdapter();
    }
    async end(): Promise<void> {
      await mockAdapterEnd();
    }
    async query(): Promise<void> {
      await mockAdapterQuery();
    }
  },
  PostgresBackupAdapter: class {
    constructor(options: typeof backupLifecycle) {
      backupLifecycle = options;
    }
  },
}));

import { closeDatabase, getBackupAdapter, getDbClient, initializeDatabase } from '@snaglet/db/db';

async function initializeFixture(): Promise<void> {
  await getDbClient({ allowReopenAfterClose: true });
  await initializeDatabase();
}

let priorUrl: string | undefined;
let priorMode: string | undefined;
beforeEach(() => {
  priorUrl = process.env.SNAGLET_DATABASE_URL;
  priorMode = process.env.SNAGLET_DB_MODE;
  delete process.env.SNAGLET_DATABASE_URL;
  delete process.env.SNAGLET_DB_MODE;
  mockOwned = true;
  mockBootstrap.mockReset().mockResolvedValue(true);
  mockStamp.mockReset().mockResolvedValue();
  mockUpgrade.mockReset().mockResolvedValue();
  mockStart.mockReset().mockResolvedValue();
  mockStop.mockReset().mockResolvedValue();
  mockAdapter.mockReset();
  mockAdapterEnd.mockReset().mockResolvedValue();
  mockAdapterQuery.mockReset().mockResolvedValue();
  backupLifecycle = undefined;
});

it('awaits a pending first start during shutdown and never publishes a late pool', async () => {
  let releaseStart!: () => void;
  mockStart.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releaseStart = resolve;
      })
  );
  const opening = getDbClient({ allowReopenAfterClose: true });
  const rejected = expect(opening).rejects.toThrow(/initialization was interrupted/);
  let closed = false;
  const closing = closeDatabase().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(mockStop).not.toHaveBeenCalled();
  releaseStart();
  await rejected;
  await closing;
  expect(mockStop).toHaveBeenCalledTimes(1);
  expect(mockAdapter).not.toHaveBeenCalled();
  await expect(getDbClient()).rejects.toThrow(/already ran/);
});

it('shares one pending lazy open across concurrent callers', async () => {
  let releaseStart!: () => void;
  mockStart.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releaseStart = resolve;
      })
  );
  const first = getDbClient({ allowReopenAfterClose: true });
  const second = getDbClient();
  expect(mockStart).toHaveBeenCalledTimes(1);
  releaseStart();
  expect(await first).toBe(await second);
  expect(mockAdapter).toHaveBeenCalledTimes(1);
});

it('keeps the explicit reopen guard armed after an attempted reopen fails', async () => {
  await closeDatabase();
  mockStart.mockRejectedValue(new Error('fixture startup failed'));
  await expect(getDbClient({ allowReopenAfterClose: true })).rejects.toThrow(
    'fixture startup failed'
  );
  await expect(getDbClient()).rejects.toThrow(/already ran/);
});

it('waits for an active restore reconnect before closing its replacement pool and runtime', async () => {
  const events: string[] = [];
  mockAdapterEnd.mockImplementation(async () => {
    events.push('adapter:end');
  });
  mockStop.mockImplementation(async () => {
    events.push('runtime:stop');
  });
  await getDbClient({ allowReopenAfterClose: true });
  await getBackupAdapter();
  expect(backupLifecycle).toBeDefined();
  const restore = backupLifecycle!;
  await restore.quiesce();

  let releaseProbe!: () => void;
  mockAdapterQuery.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releaseProbe = resolve;
      })
  );
  const reconnecting = restore.reconnect();
  await Promise.resolve();
  expect(mockAdapter).toHaveBeenCalledTimes(2);

  // This caller is already waiting on the swap when shutdown starts.
  const waitingGetter = getDbClient();
  let closed = false;
  const closing = closeDatabase().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(mockStop).not.toHaveBeenCalled();

  releaseProbe();
  await reconnecting;
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(mockAdapterEnd).toHaveBeenCalledTimes(1);

  restore.resume();
  await closing;
  await expect(waitingGetter).rejects.toThrow(/already ran/);
  expect(mockAdapterEnd).toHaveBeenCalledTimes(2);
  expect(mockStop).toHaveBeenCalledTimes(1);
  expect(events).toEqual(['adapter:end', 'adapter:end', 'runtime:stop']);
});

it('fails closed and still stops the owned runtime when restore rollback is terminal', async () => {
  await getDbClient({ allowReopenAfterClose: true });
  await getBackupAdapter();
  expect(backupLifecycle).toBeDefined();
  const restore = backupLifecycle!;
  await restore.quiesce();
  const waitingGetter = getDbClient();
  const closing = closeDatabase();

  restore.failSwap(new Error('fixture restore rollback failed'));
  await expect(waitingGetter).rejects.toThrow('fixture restore rollback failed');
  await closing;

  expect(mockAdapter).toHaveBeenCalledTimes(1);
  expect(mockAdapterEnd).toHaveBeenCalledTimes(1);
  expect(mockStop).toHaveBeenCalledTimes(1);
  await expect(getDbClient()).rejects.toThrow(/already ran/);
});
afterEach(async () => {
  await closeDatabase();
  if (priorUrl === undefined) delete process.env.SNAGLET_DATABASE_URL;
  else process.env.SNAGLET_DATABASE_URL = priorUrl;
  if (priorMode === undefined) delete process.env.SNAGLET_DB_MODE;
  else process.env.SNAGLET_DB_MODE = priorMode;
});

it('stamps the actual owned data directory only after fresh bootstrap succeeds', async () => {
  mockBootstrap.mockImplementation(async () => {
    expect(mockStamp).not.toHaveBeenCalled();
    return true;
  });
  await initializeFixture();
  expect(mockStamp).toHaveBeenCalledWith('fixture-data-directory');
  expect(mockUpgrade).not.toHaveBeenCalled();
});

it('does not stamp a failed bootstrap', async () => {
  mockBootstrap.mockRejectedValue(new Error('fixture bootstrap failure'));
  await expect(initializeFixture()).rejects.toThrow('fixture bootstrap failure');
  expect(mockStamp).not.toHaveBeenCalled();
});

it('leaves existing owned database stamping to the successful upgrade path', async () => {
  mockBootstrap.mockResolvedValue(false);
  await initializeFixture();
  expect(mockUpgrade).toHaveBeenCalledTimes(1);
  expect(mockStamp).not.toHaveBeenCalled();
});

it('does not stamp a source managed database', async () => {
  mockOwned = false;
  await initializeFixture();
  expect(mockStamp).not.toHaveBeenCalled();
});

it('does not stamp an external URL database', async () => {
  process.env.SNAGLET_DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:45678/fixture';
  await initializeFixture();
  expect(mockStamp).not.toHaveBeenCalled();
  expect(mockUpgrade).not.toHaveBeenCalled();
});
