import request from 'supertest';
import express from 'express';

jest.mock('../../../../../apps/server/src/config/logger', () => ({
  logger: {
    error: jest.fn(),
    http: jest.fn(),
  },
  httpLogStream: {
    write: jest.fn(),
  },
}));

// Mock @snaglet/db to avoid import.meta.url issues in Jest
jest.mock('../../../../../packages/db/index.ts', () => ({
  isDatabaseEnabled: () => false,
  getPool: jest.fn(),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(),
  getDatabase: jest.fn(),
  initializeDatabase: jest.fn(),
  closeDatabase: jest.fn(),
}));

import apiRoutes from '@server/routes/api';

describe('API Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRoutes);
  });

  describe('GET /api/health', () => {
    it('should return 200 status code', async () => {
      const response = await request(app).get('/api/health');
      expect(response.status).toBe(200);
    });

    it('should return health status object', async () => {
      const response = await request(app).get('/api/health');

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('message');
    });

    it('should return healthy status', async () => {
      const response = await request(app).get('/api/health');

      expect(response.body.status).toBe('healthy');
      expect(response.body.message).toBe('Server is running and responsive');
    });

    it('should return valid ISO timestamp', async () => {
      const response = await request(app).get('/api/health');

      const timestamp = new Date(response.body.timestamp);
      expect(timestamp).toBeInstanceOf(Date);
      expect(timestamp.getTime()).not.toBeNaN();
    });

    it('should return JSON content type', async () => {
      const response = await request(app).get('/api/health');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });
});
