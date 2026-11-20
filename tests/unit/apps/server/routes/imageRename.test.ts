/**
 * PATCH /api/images/:id with `name`: validation, the stale-name conflict, and
 * the tree event other windows use to repaint the new name.
 */

import request from 'supertest';
import express from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const rename = jest.fn();
const findMetaById = jest.fn();
const updateMetadata = jest.fn();
const emitTreeNodeUpdated = jest.fn();

jest.mock('@snaglet/db/tables/images', () => ({
  Images: {
    rename: (...a: unknown[]) => rename(...a),
    findMetaById: (...a: unknown[]) => findMetaById(...a),
    updateMetadata: (...a: unknown[]) => updateMetadata(...a),
    moveTo: jest.fn(),
    createImage: jest.fn(),
    listImages: jest.fn(),
    findImageById: jest.fn(),
  },
}));
jest.mock('@snaglet/db/tables/threads', () => ({ Threads: { findById: jest.fn() } }));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: jest.fn(),
  emitTreeNodeUpdated: (...a: unknown[]) => emitTreeNodeUpdated(...a),
  snapshotFromImage: jest.fn(),
}));
jest.mock('@server/realtime/actorContext', () => ({ getCurrentActor: () => null }));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import imagesRouter from '@server/domains/images/images.routes';
import { errorHandler } from '@server/middleware';

const ID = 'image-1111111111111-aaaaaaaaa';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/images', imagesRouter);
  a.use(errorHandler);
  return a;
}

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  containerId: null,
  name: 'Capture.png',
  description: null,
  tags: [],
  mimeType: 'image/png',
  sizeBytes: 4,
  sortOrder: 0,
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  findMetaById.mockResolvedValue(row());
});

describe('PATCH /api/images/:id name', () => {
  it('renames through the model and emits the new title', async () => {
    rename.mockResolvedValue({
      status: 'renamed',
      image: row({ name: 'Sunset', updatedAt: '2026-08-05T00:00:00.000Z' }),
    });

    const res = await request(app())
      .patch(`/api/images/${ID}`)
      .send({ name: '  Sunset ', expectedName: 'Capture.png' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: ID, name: 'Sunset' });
    expect(rename).toHaveBeenCalledWith(ID, 'Sunset', { expectedName: 'Capture.png' });
    expect(emitTreeNodeUpdated).toHaveBeenCalledWith({
      id: ID,
      kind: 'image',
      title: 'Sunset',
      updatedAt: '2026-08-05T00:00:00.000Z',
    });
  });

  it('does not announce a title for an unchanged name', async () => {
    rename.mockResolvedValue({ status: 'unchanged', image: row() });
    const res = await request(app()).patch(`/api/images/${ID}`).send({ name: 'Capture.png' });
    expect(res.status).toBe(200);
    expect(emitTreeNodeUpdated.mock.calls[0]?.[0]).not.toHaveProperty('title');
  });

  it.each([
    [{ name: '   ' }, /Enter a name/],
    [{ name: 'x'.repeat(121) }, /at most 120 characters/],
    [{ name: 42 }, /name must be a string/],
    [{ name: 'Ok', expectedName: 7 }, /expectedName must be a string/],
    [{ name: 'Ok', containerId: 'container-1' }, /separate requests/],
  ])('refuses %j', async (body, message) => {
    const res = await request(app()).patch(`/api/images/${ID}`).send(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(message);
    expect(rename).not.toHaveBeenCalled();
  });

  it('returns 409 with the current name when the image was renamed meanwhile', async () => {
    rename.mockResolvedValue({ status: 'conflict', currentName: 'Someone else' });
    const res = await request(app())
      .patch(`/api/images/${ID}`)
      .send({ name: 'Mine', expectedName: 'Capture.png' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Someone else');
    expect(emitTreeNodeUpdated).not.toHaveBeenCalled();
  });

  it('reports a store the file system refuses as a clear 403', async () => {
    rename.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied, link /snaglet-home/images/x'), {
        code: 'EACCES',
      })
    );
    const res = await request(app()).patch(`/api/images/${ID}`).send({ name: 'Mine' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/not allowed to rename \\"Capture.png\\"/);
    expect(JSON.stringify(res.body)).not.toContain('/snaglet-home');
  });

  it('returns 404 for an unknown image', async () => {
    findMetaById.mockResolvedValue(null);
    const res = await request(app()).patch(`/api/images/${ID}`).send({ name: 'Mine' });
    expect(res.status).toBe(404);
    expect(rename).not.toHaveBeenCalled();
  });
});
