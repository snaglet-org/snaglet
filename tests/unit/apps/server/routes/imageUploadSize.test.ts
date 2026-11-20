/**
 * Upload size limits: the upload route takes images up to MAX_IMAGE_BYTES
 * (50 MB) and refuses larger ones with a message that names the limit. The
 * app is wired as in index.ts, with the API-wide JSON parser in front, so the
 * test also proves that parser leaves the upload route to its own limit.
 */

import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import express from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createImage = jest.fn();

jest.mock('@snaglet/db/tables/images', () => ({
  Images: {
    createImage: (...a: unknown[]) => createImage(...a),
    listImages: jest.fn(),
    findImageById: jest.fn(),
    findMetaById: jest.fn(),
  },
  imageBlobPath: jest.fn(),
  storageKeyFor: jest.fn(),
}));
jest.mock('@snaglet/db/tables/threads', () => ({ Threads: { findById: jest.fn() } }));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: jest.fn(),
  emitTreeNodeUpdated: jest.fn(),
  emitTreeNodeDeleted: jest.fn(),
  snapshotFromImage: (image: Record<string, unknown>) => ({ id: image.id, kind: 'image' }),
}));
jest.mock('@server/realtime/actorContext', () => ({ getCurrentActor: () => null }));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import imagesRouter from '@server/domains/images/images.routes';
import { errorHandler } from '@server/middleware';
import { jsonBody } from '@server/middleware/jsonBody';
import { MAX_IMAGE_BYTES } from '@snaglet/shared/utils';

const MB = 1024 * 1024;
const GIF_HEADER = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

const otherRoute = jest.fn();

function app() {
  const a = express();
  a.use(jsonBody);
  a.use('/api/images', imagesRouter);
  a.post('/api/other', (req, res) => {
    otherRoute(req.body);
    res.json({ ok: true });
  });
  a.use(errorHandler);
  return a;
}

/**
 * POST `bytes` of filler to the upload route in 1 MB writes, so the test never
 * holds the whole body. The parser drains a refused body before it answers.
 */
async function postStreamedBody(bytes: number): Promise<{ status: number; message: unknown }> {
  const server = app().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/images',
          headers: { 'Content-Type': 'application/json', 'Content-Length': bytes },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              error?: { message?: unknown };
            };
            resolve({ status: res.statusCode ?? 0, message: body.error?.message });
          });
        }
      );
      req.on('error', reject);
      const filler = Buffer.alloc(MB, 0x20);
      let sent = 0;
      const writeMore = () => {
        while (sent < bytes) {
          const piece = filler.subarray(0, Math.min(filler.length, bytes - sent));
          sent += piece.length;
          if (!req.write(piece)) {
            req.once('drain', writeMore);
            return;
          }
        }
        req.end();
      };
      writeMore();
    });
  } finally {
    server.close();
  }
}

/** A GIF data URL whose decoded bytes total `size`. The route checks the type, not the pixels. */
function gifDataUrl(size: number): string {
  const bytes = Buffer.alloc(size);
  GIF_HEADER.copy(bytes);
  return `data:image/gif;base64,${bytes.toString('base64')}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  createImage.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    sortOrder: 0,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  }));
});

describe('image upload size', () => {
  it('accepts a 9 MB image in a body over the API-wide 8 MB limit', async () => {
    const res = await request(app())
      .post('/api/images')
      .send({ name: 'large.gif', dataUrl: gifDataUrl(9 * MB) });

    expect(res.status).toBe(201);
    expect(createImage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/gif', sizeBytes: 9 * MB })
    );
  });

  it('refuses a body too large for a 50 MB image with 413 and the limit', async () => {
    const res = await postStreamedBody(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 2 * MB);

    expect(res.status).toBe(413);
    expect(res.message).toBe('This image is too large. Images can be up to 50 MB.');
    expect(createImage).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps the 8 MB limit, with a 413 that names it, on every other route', async () => {
    const res = await request(app())
      .post('/api/other')
      .send({ blob: 'x'.repeat(9 * MB) });

    expect(res.status).toBe(413);
    expect(res.body.error.message).toBe('This request is too large. Requests can be up to 8 MB.');
    expect(otherRoute).not.toHaveBeenCalled();
  });
});

describe('data URL parsing', () => {
  it('accepts Base64 broken across lines', async () => {
    const dataUrl = gifDataUrl(64);
    const comma = dataUrl.indexOf(',') + 1;
    const wrapped = dataUrl.slice(0, comma) + dataUrl.slice(comma).replace(/(.{76})/g, '$1\r\n');

    const res = await request(app()).post('/api/images').send({ dataUrl: wrapped });

    expect(res.status).toBe(201);
    expect(createImage).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: 64 }));
  });

  it('stores an image/jpg upload as image/jpeg', async () => {
    const res = await request(app())
      .post('/api/images')
      .send({ dataUrl: gifDataUrl(64).replace('image/gif', 'image/jpg') });

    expect(res.status).toBe(201);
    expect(createImage).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/jpeg' }));
  });

  it.each([
    ['a character outside Base64', 'data:image/gif;base64,R0lG*ODlh'],
    [
      'a header that does not end within 128 characters',
      `data:image/${'x'.repeat(200)};base64,R0lG`,
    ],
    ['no Base64 marker', 'data:image/gif,R0lGODlh'],
    ['no payload', 'data:image/gif;base64,'],
    ['no data: prefix', 'R0lGODlh'],
  ])('rejects a data URL with %s', async (_label, dataUrl) => {
    const res = await request(app()).post('/api/images').send({ dataUrl });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid image payload/i);
    expect(createImage).not.toHaveBeenCalled();
  });
});
