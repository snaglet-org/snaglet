import request from 'supertest';
import express from 'express';
import { z } from 'zod';
import { validateBody, validateQuery, validateParams } from '@server/middleware/validation';

describe('Validation Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
  });

  describe('validateBody', () => {
    const testSchema = z.object({
      email: z.string().email(),
      age: z.number().min(18),
    });

    beforeEach(() => {
      app.post('/test', validateBody(testSchema), (req, res) => {
        res.json({ success: true, data: req.body });
      });
    });

    it('should pass validation with valid body', async () => {
      const response = await request(app)
        .post('/test')
        .send({ email: 'test@example.com', age: 25 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe('test@example.com');
    });

    it('should return 400 with invalid email', async () => {
      const response = await request(app).post('/test').send({ email: 'not-an-email', age: 25 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toBeDefined();
      expect(response.body.details[0].path).toBe('email');
    });

    it('should return 400 with missing required field', async () => {
      const response = await request(app).post('/test').send({ email: 'test@example.com' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toBeDefined();
    });

    it('should return 400 with age below minimum', async () => {
      const response = await request(app)
        .post('/test')
        .send({ email: 'test@example.com', age: 16 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details[0].path).toBe('age');
    });

    it('should include validation error details', async () => {
      const response = await request(app).post('/test').send({ email: 'bad', age: 'not-a-number' });

      expect(response.status).toBe(400);
      expect(response.body.details).toBeInstanceOf(Array);
      expect(response.body.details.length).toBeGreaterThan(0);
      expect(response.body.details[0]).toHaveProperty('path');
      expect(response.body.details[0]).toHaveProperty('message');
    });
  });

  describe('validateQuery', () => {
    const querySchema = z.object({
      page: z.coerce.number().min(1),
      limit: z.coerce.number().min(1).max(100),
    });

    beforeEach(() => {
      app.get('/test', validateQuery(querySchema), (req, res) => {
        res.json({ success: true, query: req.query });
      });
    });

    it('should pass validation with valid query params', async () => {
      const response = await request(app).get('/test?page=1&limit=10');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.query.page).toBe(1);
      expect(response.body.query.limit).toBe(10);
    });

    it('should coerce string to number', async () => {
      const response = await request(app).get('/test?page=2&limit=50');

      expect(response.status).toBe(200);
      expect(typeof response.body.query.page).toBe('number');
      expect(typeof response.body.query.limit).toBe('number');
    });

    it('should return 400 with invalid query param', async () => {
      const response = await request(app).get('/test?page=0&limit=10');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 when limit exceeds max', async () => {
      const response = await request(app).get('/test?page=1&limit=200');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('validateParams', () => {
    const paramsSchema = z.object({
      id: z.coerce.number().positive(),
    });

    beforeEach(() => {
      app.get('/test/:id', validateParams(paramsSchema), (req, res) => {
        res.json({ success: true, params: req.params });
      });
    });

    it('should pass validation with valid param', async () => {
      const response = await request(app).get('/test/123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.params.id).toBe(123);
    });

    it('should return 400 with non-numeric param', async () => {
      const response = await request(app).get('/test/abc');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 with negative param', async () => {
      const response = await request(app).get('/test/-5');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });
});
