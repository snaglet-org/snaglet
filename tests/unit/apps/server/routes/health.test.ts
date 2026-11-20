import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express, { Express } from 'express';

// Mock @snaglet/db to avoid import.meta.url issues in Jest
const mockCheckDatabaseConnection = jest.fn().mockResolvedValue(undefined);
const mockIsDatabaseEnabled = jest.fn(() => false);
const mockPendingMigrationCount = jest.fn(async () => 0);
const mockProbeEmbeddingModel = jest.fn(async () => null);

jest.mock('../../../../../packages/db/index.ts', () => ({
  isDatabaseEnabled: mockIsDatabaseEnabled,
  checkDatabaseConnection: mockCheckDatabaseConnection,
  getDbClient: jest.fn(async () => ({})),
  getPool: jest.fn(),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(),
  getDatabase: jest.fn(),
  initializeDatabase: jest.fn(),
  closeDatabase: jest.fn(),
}));

jest.mock('../../../../../packages/db/migrations.ts', () => ({
  pendingMigrationCount: (...args: unknown[]) => mockPendingMigrationCount(...args),
}));
jest.mock('../../../../../packages/db/runtime/snaglet-home.ts', () => ({
  resolveDbHome: () => '/tmp/snaglet-test-home',
}));

// The readiness route probes the built-in local embedder (a real ONNX
// session); jest's VM realm can't run onnxruntime, so stub the probe healthy.
jest.mock('@server/services/embedding/EmbeddingProvider.js', () => ({
  probeEmbeddingModel: (...args: unknown[]) => mockProbeEmbeddingModel(...args),
}));

import healthRoutes from '@server/routes/health';
import { isDatabaseEnabled, initializeDatabase, closeDatabase } from '@snaglet/db';

describe('Health Check Endpoints', () => {
  let app: Express;
  const previousLocalIntelligence = process.env.SNAGLET_LOCAL_INTELLIGENCE;

  beforeAll(async () => {
    app = express();
    app.use('/health', healthRoutes);

    // Initialize database if enabled
    if (isDatabaseEnabled()) {
      await initializeDatabase();
    }
  });

  afterAll(async () => {
    if (previousLocalIntelligence === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    else process.env.SNAGLET_LOCAL_INTELLIGENCE = previousLocalIntelligence;
    if (isDatabaseEnabled()) {
      await closeDatabase();
    }
  });

  beforeEach(() => {
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    mockProbeEmbeddingModel.mockClear();
  });

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return valid ISO 8601 timestamp', async () => {
      const response = await request(app).get('/health');
      const timestamp = new Date(response.body.timestamp);

      expect(timestamp.toISOString()).toBe(response.body.timestamp);
    });
  });

  describe('GET /health/ready', () => {
    it('does not probe or load an embedding model while local intelligence is disabled', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body.checks.embedding).toEqual({
        status: 'ok',
        message: 'automatic local intelligence disabled',
      });
      expect(mockProbeEmbeddingModel).not.toHaveBeenCalled();
    });

    it('restores the embedding readiness probe after explicit opt-in', async () => {
      process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(mockProbeEmbeddingModel).toHaveBeenCalledTimes(1);
    });

    it('should return status based on dependencies', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(600);
      expect(response.body).toMatchObject({
        status: expect.stringMatching(/^(ready|not_ready)$/),
        timestamp: expect.any(String),
        checks: expect.any(Object),
      });
    });

    it('should include database check', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.body.checks).toHaveProperty('database');
      expect(response.body.checks.database).toHaveProperty('status');
      expect(['ok', 'error']).toContain(response.body.checks.database.status);
    });

    it('should return 200 when all checks pass', async () => {
      const response = await request(app).get('/health/ready');

      if (response.body.status === 'ready') {
        expect(response.status).toBe(200);
        Object.values(response.body.checks as Record<string, { status: string }>).forEach(
          (check) => {
            expect(check.status).toBe('ok');
          }
        );
      }
    });

    it('should return 503 when any check fails', async () => {
      mockIsDatabaseEnabled.mockReturnValueOnce(true);
      mockCheckDatabaseConnection.mockRejectedValueOnce(new Error('Connection refused'));

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
      const checks = Object.values(response.body.checks as Record<string, { status: string }>);
      const hasError = checks.some((check) => check.status === 'error');
      expect(hasError).toBe(true);
    });
  });

  describe('GET /health/metrics', () => {
    it('should return 200 with metrics', async () => {
      const response = await request(app).get('/health/metrics');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        uptime: {
          seconds: expect.any(Number),
          human: expect.any(String),
        },
        memory: {
          rss: expect.any(String),
          heapTotal: expect.any(String),
          heapUsed: expect.any(String),
          external: expect.any(String),
        },
        timestamp: expect.any(String),
      });
    });

    it('should return non-negative uptime', async () => {
      const response = await request(app).get('/health/metrics');

      expect(response.body.uptime.seconds).toBeGreaterThanOrEqual(0);
    });

    it('should format memory values correctly', async () => {
      const response = await request(app).get('/health/metrics');
      const memoryValues = Object.values(response.body.memory);

      memoryValues.forEach((value) => {
        expect(value).toMatch(/^\d+(\.\d+)?\s+(Bytes|KB|MB|GB|TB)$/);
      });
    });

    it('should not expose system fingerprint data', async () => {
      const response = await request(app).get('/health/metrics');

      expect(response.body.node).toBeUndefined();
    });
  });

  describe('GET /health/ready — schema currency', () => {
    // The route caches the probe for a few seconds. Move a fake clock past
    // the TTL between requests instead of exposing a reset seam from the
    // route module (nothing in production would consume it).
    let clock = Date.now();
    const advancePastTtl = () => {
      clock += 60_000;
    };
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      advancePastTtl();
      mockPendingMigrationCount.mockReset().mockResolvedValue(0);
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('reports schema ok when no migrations are pending', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body.checks.schema).toEqual({ status: 'ok' });
    });

    it('is not ready while migrations are pending and names the exact repair command', async () => {
      mockPendingMigrationCount.mockResolvedValue(2);

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
      expect(response.body.checks.schema.status).toBe('error');
      expect(response.body.checks.schema.message).toContain('2 pending schema migration(s)');
      expect(response.body.checks.schema.message).toContain('/tmp/snaglet-test-home');
      expect(response.body.checks.schema.message).toContain('SNAGLET_ENV=dev pnpm db:migrate');
    });

    it('flips back to ready once the migrations are applied (cache expires)', async () => {
      mockPendingMigrationCount.mockResolvedValue(1);
      expect((await request(app).get('/health/ready')).status).toBe(503);

      // Within the TTL the cached answer stands…
      mockPendingMigrationCount.mockResolvedValue(0);
      expect((await request(app).get('/health/ready')).status).toBe(503);
      // …and once it expires the ledger is re-read.
      advancePastTtl();
      expect((await request(app).get('/health/ready')).status).toBe(200);
    });

    it('is not ready when the schema state cannot be determined', async () => {
      mockPendingMigrationCount.mockRejectedValue(new Error('ledger unreadable'));

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.checks.schema.status).toBe('error');
    });

    it('does not probe the schema when the database itself is down', async () => {
      mockCheckDatabaseConnection.mockRejectedValueOnce(new Error('down'));

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.checks.database.status).toBe('error');
      expect(response.body.checks.schema).toBeUndefined();
      expect(mockPendingMigrationCount).not.toHaveBeenCalled();
    });
  });
});
