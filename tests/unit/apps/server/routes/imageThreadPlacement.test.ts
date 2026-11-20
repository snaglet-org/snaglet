/**
 * Thread-uploaded images land in the thread's project container, next to the
 * thread, not at the workspace root.
 *
 * The placement is decided server-side from a `threadId`: the client asserts
 * no container on this path, so a stale cached container cannot be sent and
 * the branch cannot place a node anywhere the caller likes. Rejection cases
 * assert `createImage` was never called, since it is the one step that
 * persists anything (the node and its bytes together).
 */

import request from 'supertest';
import express from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createImage = jest.fn();
const threadsFindById = jest.fn();
const emitTreeNodeCreated = jest.fn();

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
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...a: unknown[]) => threadsFindById(...a) },
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: (...a: unknown[]) => emitTreeNodeCreated(...a),
  emitTreeNodeUpdated: jest.fn(),
  emitTreeNodeDeleted: jest.fn(),
  snapshotFromImage: (image: Record<string, unknown>) => ({
    id: image.id,
    kind: 'image',
    title: image.name,
    parentId: image.containerId,
  }),
}));
jest.mock('@server/realtime/actorContext', () => ({ getCurrentActor: () => null }));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import imagesRouter from '@server/domains/images/images.routes';
import { errorHandler } from '@server/middleware';

// 1x1 transparent GIF — smallest valid payload the route will parse.
const DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function app() {
  const a = express();
  a.use(express.json({ limit: '10mb' }));
  a.use('/api/images', imagesRouter);
  a.use(errorHandler);
  return a;
}

const thread = (over: Record<string, unknown> = {}) => ({
  id: 'thread-1',
  title: 'Design review',
  projectId: 'container-nested',
  archived: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  threadsFindById.mockResolvedValue(thread());
  createImage.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    sortOrder: 0,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  }));
});

/** The containerId handed to Images.createImage on the most recent call. */
const placedIn = () =>
  (createImage.mock.calls[0]?.[0] as { containerId: string | null } | undefined)?.containerId;

describe('placement follows the thread', () => {
  it('places the image in the thread’s container', async () => {
    const res = await request(app())
      .post('/api/images')
      .send({ dataUrl: DATA_URL, threadId: 'thread-1' });

    expect(res.status).toBe(201);
    expect(placedIn()).toBe('container-nested');
  });

  it('places it in a nested project, whatever the depth', async () => {
    // Depth is irrelevant to the route: it uses the thread's own project id,
    // so nesting is inherited from the thread rather than recomputed.
    threadsFindById.mockResolvedValue(thread({ projectId: 'container-deeply-nested' }));

    await request(app()).post('/api/images').send({ dataUrl: DATA_URL, threadId: 'thread-1' });

    expect(placedIn()).toBe('container-deeply-nested');
  });

  it('leaves a root-level thread’s image at the root', async () => {
    threadsFindById.mockResolvedValue(thread({ projectId: null }));

    await request(app()).post('/api/images').send({ dataUrl: DATA_URL, threadId: 'thread-1' });

    expect(placedIn()).toBeNull();
  });

  it('resolves placement from the current read, so a later upload follows a moved thread', async () => {
    // Two uploads either side of a move. The first image is never revisited —
    // "not reparented" is the invariant, and the route has no path that could
    // touch an already-created node.
    await request(app()).post('/api/images').send({ dataUrl: DATA_URL, threadId: 'thread-1' });
    expect(placedIn()).toBe('container-nested');

    threadsFindById.mockResolvedValue(thread({ projectId: 'container-moved' }));
    await request(app()).post('/api/images').send({ dataUrl: DATA_URL, threadId: 'thread-1' });

    const second = createImage.mock.calls[1][0] as { containerId: string | null };
    expect(second.containerId).toBe('container-moved');
    // The first call's arguments are unchanged — nothing re-placed it.
    expect(placedIn()).toBe('container-nested');
    expect(createImage).toHaveBeenCalledTimes(2);
  });
});

describe('rejections happen before anything is created', () => {
  it('404s an unknown thread and writes nothing', async () => {
    threadsFindById.mockResolvedValue(null);

    const res = await request(app())
      .post('/api/images')
      .send({ dataUrl: DATA_URL, threadId: 'thread-missing' });

    expect(res.status).toBe(404);
    // createImage is the only write, so not calling it is the proof that
    // no node or bytes were left behind.
    expect(createImage).not.toHaveBeenCalled();
    expect(emitTreeNodeCreated).not.toHaveBeenCalled();
  });

  it('404s a non-thread id the same way, so the error cannot probe other nodes', async () => {
    // The lookup is scoped to threads, so a doc id simply misses. Same status
    // and same message as a genuinely missing thread.
    threadsFindById.mockResolvedValue(null);

    const res = await request(app())
      .post('/api/images')
      .send({ dataUrl: DATA_URL, threadId: 'doc-1111111111111-q2kna0cwq' });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toMatch(/thread not found/i);
    expect(createImage).not.toHaveBeenCalled();
  });

  it('refuses an archived thread rather than creating an orphan', async () => {
    // The message that would carry this image could never be sent, so
    // accepting the upload would bill the user for a later failure.
    threadsFindById.mockResolvedValue(thread({ archived: true }));

    const res = await request(app())
      .post('/api/images')
      .send({ dataUrl: DATA_URL, threadId: 'thread-1' });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/archived/i);
    expect(createImage).not.toHaveBeenCalled();
    expect(emitTreeNodeCreated).not.toHaveBeenCalled();
  });

  it('rejects threadId and containerId together instead of picking one', async () => {
    // A precedence rule would let a caller believe it had placed the image
    // somewhere it did not, with nothing to notice.
    const res = await request(app())
      .post('/api/images')
      .send({ dataUrl: DATA_URL, threadId: 'thread-1', containerId: 'container-other' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not both/i);
    expect(createImage).not.toHaveBeenCalled();
    expect(threadsFindById).not.toHaveBeenCalled();
  });
});

describe('non-thread callers are unchanged', () => {
  it('honors an explicit containerId when no threadId is given', async () => {
    const res = await request(app())
      .post('/api/images')
      .send({ dataUrl: DATA_URL, containerId: 'container-explicit' });

    expect(res.status).toBe(201);
    expect(placedIn()).toBe('container-explicit');
    // No thread lookup on this path at all.
    expect(threadsFindById).not.toHaveBeenCalled();
  });

  it('still creates at the root when neither is given', async () => {
    const res = await request(app()).post('/api/images').send({ dataUrl: DATA_URL });

    expect(res.status).toBe(201);
    expect(placedIn()).toBeNull();
    expect(threadsFindById).not.toHaveBeenCalled();
  });

  it('an absent threadId property is a plain workspace upload', async () => {
    // Absence is the only way to opt out of thread placement. Presence is a
    // promise the caller is expected to keep.
    await request(app())
      .post('/api/images')
      .send({ dataUrl: DATA_URL, containerId: 'container-explicit' });

    expect(placedIn()).toBe('container-explicit');
    expect(threadsFindById).not.toHaveBeenCalled();
  });
});

describe('a present threadId must be usable — no silent degradation', () => {
  it.each([
    ['blank string', '   '],
    ['empty string', ''],
    ['null', null],
    ['a number', 42],
    ['an object', { id: 'thread-1' }],
    ['an array', ['thread-1']],
  ])('400s a present-but-invalid threadId (%s)', async (_label, threadId) => {
    const res = await request(app()).post('/api/images').send({ dataUrl: DATA_URL, threadId });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/threadId must be a non-empty string/i);
    // The failure mode this prevents: falling back to a root upload the user
    // never asked for, with a 201 that looks like success.
    expect(createImage).not.toHaveBeenCalled();
    expect(threadsFindById).not.toHaveBeenCalled();
  });

  it.each([
    ['blank string', '   '],
    ['null', null],
    ['a number', 42],
  ])(
    '400s a present-but-invalid threadId (%s) even alongside containerId',
    async (_label, threadId) => {
      // Must not quietly become an explicit-container upload: the caller asked
      // for thread placement and got something else.
      const res = await request(app())
        .post('/api/images')
        .send({ dataUrl: DATA_URL, threadId, containerId: 'container-explicit' });

      expect(res.status).toBe(400);
      expect(createImage).not.toHaveBeenCalled();
      expect(threadsFindById).not.toHaveBeenCalled();
    }
  );
});

describe('the tree event carries the resolved placement', () => {
  it('emits parentId matching the thread’s container', async () => {
    await request(app()).post('/api/images').send({ dataUrl: DATA_URL, threadId: 'thread-1' });

    expect(emitTreeNodeCreated).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', parentId: 'container-nested' })
    );
  });

  it('emits a null parent for a flat thread', async () => {
    threadsFindById.mockResolvedValue(thread({ projectId: null }));

    await request(app()).post('/api/images').send({ dataUrl: DATA_URL, threadId: 'thread-1' });

    expect(emitTreeNodeCreated).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', parentId: null })
    );
  });
});

describe('bytes and metadata are untouched by this change', () => {
  it('still parses the data URL and passes the decoded bytes through', async () => {
    await request(app())
      .post('/api/images')
      .send({ dataUrl: DATA_URL, threadId: 'thread-1', name: 'shot.gif' });

    const input = createImage.mock.calls[0][0] as {
      mimeType: string;
      data: Buffer;
      sizeBytes: number;
      name: string;
    };
    expect(input.mimeType).toBe('image/gif');
    expect(input.data.length).toBeGreaterThan(0);
    expect(input.sizeBytes).toBe(input.data.length);
    expect(input.name).toBe('shot.gif');
  });
});
