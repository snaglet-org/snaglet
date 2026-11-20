import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Express } from 'express';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

const mockGetDatabaseRuntimeStatus = jest.fn();
const mockGetDbClient = jest.fn();
const mockAdapterQuery = jest.fn();
const mockAdapterEnd = jest.fn();
const mockPostgresAdapter = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@snaglet/db/db', () => ({
  getDatabaseRuntimeStatus: (...args: unknown[]) => mockGetDatabaseRuntimeStatus(...args),
  getDbClient: (...args: unknown[]) => mockGetDbClient(...args),
}));

jest.mock('@snaglet/db/adapters/postgres', () => ({
  PostgresAdapter: function MockPostgresAdapter(options: unknown) {
    return mockPostgresAdapter(options);
  },
}));

jest.mock('@server/config/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import databaseSetupRouter from '@server/routes/database-setup';
import { errorHandler } from '@server/middleware/errorHandler';

describe('database-setup routes', () => {
  let app: Express;
  let scratchDirs: string[];
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    scratchDirs = [];
    originalDatabaseUrl = process.env.SNAGLET_DATABASE_URL;
    delete process.env.SNAGLET_DATABASE_URL;

    mockAdapterEnd.mockResolvedValue(undefined);
    mockPostgresAdapter.mockImplementation(() => ({
      query: mockAdapterQuery,
      end: mockAdapterEnd,
    }));

    app = express();
    app.use(express.json());
    app.use('/api/database-setup', databaseSetupRouter);
    app.use(errorHandler);
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.SNAGLET_DATABASE_URL;
    } else {
      process.env.SNAGLET_DATABASE_URL = originalDatabaseUrl;
    }
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeScratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'snaglet-database-setup-test-'));
    scratchDirs.push(dir);
    return dir;
  }

  it('reports managed state, versions, data directory, and size without secrets', async () => {
    process.env.SNAGLET_DATABASE_URL =
      'postgresql://route-user:route-password@should-not-appear.internal:6432/snaglet';

    mockGetDatabaseRuntimeStatus.mockResolvedValue({
      mode: 'managed',
      available: true,
      managed: {
        state: 'running',
        running: true,
        postgresVersion: '17.6',
        pgvectorVersion: '0.8.0',
        dataDir: '/managed/postgres/data',
        socketDir: '/private/secret-postgres-socket',
        pid: 4321,
        detail: 'ready',
        password: 'runtime-password-must-not-leak',
      },
    });
    mockGetDbClient.mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [{ sizeBytes: 987_654_321 }] }),
    });

    const response = await request(app).get('/api/database-setup');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      mode: 'managed',
      available: true,
      managed: {
        state: 'running',
        running: true,
        postgresVersion: '17.6',
        pgvectorVersion: '0.8.0',
        dataDir: '/managed/postgres/data',
        sizeBytes: 987_654_321,
        pid: 4321,
        detail: 'ready',
      },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('secret-postgres-socket');
    expect(serialized).not.toContain('runtime-password-must-not-leak');
    expect(serialized).not.toContain('route-password');
    expect(serialized).not.toContain('should-not-appear.internal');
    expect(serialized).not.toContain('SNAGLET_DATABASE_URL');
  });

  it('reports external configuration using only a credential-free display target', async () => {
    process.env.SNAGLET_DATABASE_URL =
      'postgresql://external-user:external-password@db.internal:6543/snaglet?sslmode=require&sslkey=private';
    mockGetDatabaseRuntimeStatus.mockResolvedValue({
      mode: 'url',
      available: true,
      url: { configured: true },
    });

    const response = await request(app).get('/api/database-setup');

    expect(response.status).toBe(200);
    expect(response.body.data.external).toEqual({
      configured: true,
      displayTarget: 'db.internal:6543/snaglet',
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('external-user');
    expect(serialized).not.toContain('external-password');
    expect(serialized).not.toContain('sslmode');
    expect(serialized).not.toContain('sslkey');
  });

  it.each([
    ['malformed', 'not a database URL'],
    ['non-PostgreSQL', 'https://example.com/snaglet'],
  ])(
    'rejects a %s external database URL before constructing an adapter',
    async (_label, databaseUrl) => {
      const response = await request(app)
        .post('/api/database-setup/test-external')
        .send({ databaseUrl });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(mockPostgresAdapter).not.toHaveBeenCalled();
    }
  );

  it('returns database capabilities for a successful external connection and closes the adapter', async () => {
    const databaseUrl = 'postgresql://tester:success-secret@db.internal:5432/snaglet';
    mockAdapterQuery.mockResolvedValue({
      rows: [
        {
          database: 'snaglet',
          version: '17.6',
          vectorInstalled: true,
          pgTrgmInstalled: false,
        },
      ],
    });

    const response = await request(app)
      .post('/api/database-setup/test-external')
      .send({ databaseUrl });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      database: 'snaglet',
      version: '17.6',
      vectorInstalled: true,
      pgTrgmInstalled: false,
    });
    expect(mockPostgresAdapter).toHaveBeenCalledWith({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
    });
    expect(mockAdapterQuery).toHaveBeenCalledTimes(1);
    expect(mockAdapterEnd).toHaveBeenCalledTimes(1);
  });

  it('closes a failed external adapter without exposing or logging its URL or password', async () => {
    const databaseUrl =
      'postgresql://failure-user:failure-password@secret-db.internal:5432/snaglet-private';
    mockAdapterQuery.mockRejectedValue(
      new Error(`password failure-password rejected for ${databaseUrl}`)
    );

    const response = await request(app)
      .post('/api/database-setup/test-external')
      .send({ databaseUrl });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Could not connect to external PostgreSQL with the supplied URL',
      },
    });
    expect(mockAdapterEnd).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[database-setup] external PostgreSQL connection test failed',
      { errorType: 'Error' }
    );

    const serializedResponse = JSON.stringify(response.body);
    const serializedLogs = JSON.stringify([
      mockLoggerWarn.mock.calls,
      mockLoggerInfo.mock.calls,
      mockLoggerError.mock.calls,
    ]);
    for (const secret of [
      databaseUrl,
      'failure-user',
      'failure-password',
      'secret-db.internal',
      'snaglet-private',
    ]) {
      expect(serializedResponse).not.toContain(secret);
      expect(serializedLogs).not.toContain(secret);
    }
  });
});
