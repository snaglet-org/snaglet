/**
 * jsonBody: the API-wide JSON parser skips only POST /api/images (the images
 * router parses that body itself, with a larger limit) and answers any other
 * body over 8 MB with a 413 that names the limit.
 */

import request from 'supertest';
import express from 'express';
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { errorHandler } from '@server/middleware';
import { jsonBody } from '@server/middleware/jsonBody';

/** Reports whether jsonBody parsed the body before the route ran. */
function app() {
  const a = express();
  a.use(jsonBody);
  a.all('*', (req, res) => {
    res.json({ parsed: req.body !== undefined });
  });
  a.use(errorHandler);
  return a;
}

const BODY = { hello: 'world' };

describe('jsonBody', () => {
  it.each([
    ['the upload route', '/api/images'],
    ['a trailing slash', '/api/images/'],
    ['different letter case', '/API/Images'],
    ['a query string', '/api/images?source=composer'],
  ])('leaves an image upload by %s to the images router', async (_label, path) => {
    const res = await request(app()).post(path).send(BODY);

    expect(res.body).toEqual({ parsed: false });
  });

  it.each([
    ['POST', '/api/images/image-1111111111111-aaaaaaaaa'],
    ['POST', '/api/images-extra'],
    ['POST', '/api/other/images'],
    ['PATCH', '/api/images'],
    ['PUT', '/api/images'],
  ])('parses %s %s as usual', async (method, path) => {
    const res = await request(app())
      [method.toLowerCase() as 'post' | 'patch' | 'put'](path)
      .send(BODY);

    expect(res.body).toEqual({ parsed: true });
  });

  it('answers a body over 8 MB with 413 and the limit', async () => {
    const res = await request(app())
      .post('/api/other')
      .send({ blob: 'x'.repeat(9 * 1024 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.message).toBe('This request is too large. Requests can be up to 8 MB.');
  });
});
