/**
 * POST /api/export — the human-facing door.
 *
 * What this file pins is the boundary, not the file format: who may ask for
 * what, and the shape of the two responses (server wrote it / here are the
 * bytes). ExportService is mocked so the route's own decisions are visible.
 */

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const runExport = jest.fn();
const currentActor = jest.fn();

jest.mock('@server/services/ExportService', () => ({
  EXPORT_KINDS: ['doc', 'thread', 'image', 'agent_memories', 'container'],
  runExport: (...a: unknown[]) => runExport(...a),
}));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => currentActor(),
}));
// The error-path case below drives a genuine 500 through `errorHandler`, which
// logs the stack. Mocked to keep a deliberate failure from printing a real
// stack trace next to green output, where it reads like a broken test run.
// Repo convention — see routes/models.test.ts.
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import exportRoutes from '@server/routes/export';
import { contentDisposition } from '@server/routes/export';
import { errorHandler } from '@server/middleware';
import { logger } from '@server/config/logger';

const HUMAN = { actorId: 'member-1', actorKind: 'user', actorName: 'Test User' };
const AGENT = { actorId: 'agent-1', actorKind: 'agent', actorName: 'Clio' };
const EXTERNAL = { actorId: 'member-9', actorKind: 'external', actorName: 'Partner' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/export', exportRoutes);
  a.use(errorHandler);
  return a;
}

const written = {
  result: {
    kind: 'doc',
    id: 'doc-1',
    fileName: 'Notes.md',
    bytes: 12,
    path: '/Users/test-user/Desktop/Notes.md',
    overwritten: false,
    downloaded: false,
  },
  payload: {
    fileName: 'Notes.md',
    data: Buffer.from('hello world!'),
    contentType: 'text/markdown',
  },
};

const downloaded = {
  result: { kind: 'doc', id: 'doc-1', fileName: 'Notes.md', bytes: 12, downloaded: true },
  payload: {
    fileName: 'Notes.md',
    data: Buffer.from('hello world!'),
    contentType: 'text/markdown; charset=utf-8',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  currentActor.mockReturnValue(HUMAN);
  runExport.mockResolvedValue(written);
});

describe('validation', () => {
  it('rejects an unknown kind', async () => {
    const res = await request(app()).post('/api/export').send({ kind: 'file', id: 'file-1' });
    expect(res.status).toBe(400);
    expect(runExport).not.toHaveBeenCalled();
  });

  it('rejects a missing id', async () => {
    const res = await request(app()).post('/api/export').send({ kind: 'doc', id: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive or non-integer messageLimit', async () => {
    for (const messageLimit of [0, -5, 1.5, 'many']) {
      const res = await request(app())
        .post('/api/export')
        .send({ kind: 'thread', id: 't-1', options: { messageLimit } });
      expect(res.status).toBe(400);
    }
    expect(runExport).not.toHaveBeenCalled();
  });

  it('passes a valid messageLimit through', async () => {
    await request(app())
      .post('/api/export')
      .send({ kind: 'thread', id: 't-1', options: { messageLimit: 500 } });
    expect(runExport).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ messageLimit: 500 }) })
    );
  });
});

describe('actor matrix for recursive container export', () => {
  const body = { kind: 'container', id: 'container-1', destDir: '/Users/test-user/Desktop' };

  it('allows an authenticated person and forwards one batched request', async () => {
    runExport.mockResolvedValue({
      result: {
        kind: 'container',
        id: 'container-1',
        fileName: 'Planning',
        bytes: 120,
        path: '/Users/test-user/Desktop/Planning',
        downloaded: false,
        report: {
          summary: { containers: 1, docs: 0, skipped: 0, failed: 0 },
        },
      },
    });

    const res = await request(app()).post('/api/export').send(body);

    expect(res.status).toBe(200);
    expect(runExport).toHaveBeenCalledTimes(1);
    expect(runExport).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'container', id: 'container-1', destDir: body.destDir })
    );
  });

  it.each([
    ['agent', AGENT],
    ['external MCP actor', EXTERNAL],
    ['missing actor', undefined],
  ])('refuses an %s', async (_label, actor) => {
    currentActor.mockReturnValue(actor);
    const res = await request(app()).post('/api/export').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(runExport).not.toHaveBeenCalled();
  });

  it('requires a destination because a folder cannot be streamed as one file', async () => {
    const res = await request(app())
      .post('/api/export')
      .send({ kind: 'container', id: 'container-1' });
    expect(res.status).toBe(400);
    expect(runExport).not.toHaveBeenCalled();
  });
});

describe('actor matrix for agent_memories', () => {
  it('allows an authenticated person, bound to the requested agent', async () => {
    runExport.mockResolvedValue({
      ...written,
      result: { ...written.result, kind: 'agent_memories', id: 'agent-7' },
    });

    const res = await request(app())
      .post('/api/export')
      .send({ kind: 'agent_memories', id: 'agent-7', destDir: '/tmp/x' });

    expect(res.status).toBe(200);
    expect(runExport).toHaveBeenCalledWith(expect.objectContaining({ allowedAgentId: 'agent-7' }));
  });

  it('refuses an agent actor', async () => {
    currentActor.mockReturnValue(AGENT);
    const res = await request(app())
      .post('/api/export')
      .send({ kind: 'agent_memories', id: 'agent-7' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(runExport).not.toHaveBeenCalled();
  });

  it('refuses an external MCP actor', async () => {
    currentActor.mockReturnValue(EXTERNAL);
    const res = await request(app())
      .post('/api/export')
      .send({ kind: 'agent_memories', id: 'agent-7' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(runExport).not.toHaveBeenCalled();
  });

  it('refuses when there is no actor at all', async () => {
    currentActor.mockReturnValue(undefined);
    const res = await request(app())
      .post('/api/export')
      .send({ kind: 'agent_memories', id: 'agent-7' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(runExport).not.toHaveBeenCalled();
  });

  it('does not constrain node kinds with an agent id', async () => {
    await request(app()).post('/api/export').send({ kind: 'doc', id: 'doc-1' });
    expect(runExport).toHaveBeenCalledWith(expect.objectContaining({ allowedAgentId: undefined }));
  });
});

describe('write response', () => {
  it('returns the path the server actually wrote', async () => {
    const res = await request(app())
      .post('/api/export')
      .send({ kind: 'doc', id: 'doc-1', destDir: '/Users/test-user/Desktop' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      path: '/Users/test-user/Desktop/Notes.md',
      fileName: 'Notes.md',
      downloaded: false,
    });
  });

  it('forwards the overwrite grant opaquely for the service to verify', async () => {
    await request(app())
      .post('/api/export')
      .send({ kind: 'doc', id: 'doc-1', destDir: '/x', options: { overwriteGrant: 'tok.en.mac' } });
    expect(runExport).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ overwriteGrant: 'tok.en.mac' }),
      })
    );
  });

  it('accepts no overwrite boolean at all — it is not authority', async () => {
    // A boolean any caller could set is not proof that the native dialog
    // asked about replacing a file.
    await request(app())
      .post('/api/export')
      .send({ kind: 'doc', id: 'doc-1', destDir: '/x', options: { overwrite: true } });

    const [args] = runExport.mock.calls[0] as [{ options?: Record<string, unknown> }];
    expect(args.options?.overwrite).toBeUndefined();
    expect(args.options?.overwriteGrant).toBeUndefined();
  });

  it('drops a non-string grant rather than passing it along', async () => {
    await request(app())
      .post('/api/export')
      .send({ kind: 'doc', id: 'doc-1', destDir: '/x', options: { overwriteGrant: { a: 1 } } });
    expect(runExport).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ overwriteGrant: undefined }) })
    );
  });
});

describe('browser download response', () => {
  beforeEach(() => runExport.mockResolvedValue(downloaded));

  it('returns bytes with a file body, not a JSON envelope naming a path', async () => {
    const res = await request(app()).post('/api/export').send({ kind: 'doc', id: 'doc-1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-length']).toBe('12');
    expect(res.text).toBe('hello world!');
    // No path is reported, because nothing was written.
    expect(res.body.path).toBeUndefined();
  });

  it('sets Content-Disposition as an attachment with the filename', async () => {
    const res = await request(app()).post('/api/export').send({ kind: 'doc', id: 'doc-1' });
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="Notes.md"; filename*=UTF-8\'\'Notes.md'
    );
  });

  it('does not pass a destDir the client did not send', async () => {
    await request(app()).post('/api/export').send({ kind: 'doc', id: 'doc-1' });
    expect(runExport).toHaveBeenCalledWith(expect.objectContaining({ destDir: undefined }));
  });
});

describe('contentDisposition', () => {
  it('keeps a plain ASCII name readable', () => {
    expect(contentDisposition('Notes.md')).toBe(
      'attachment; filename="Notes.md"; filename*=UTF-8\'\'Notes.md'
    );
  });

  it('encodes non-ASCII in the RFC 5987 form and degrades the fallback safely', () => {
    const header = contentDisposition('Café 日本.md');
    expect(header).toContain("filename*=UTF-8''Caf%C3%A9%20%E6%97%A5%E6%9C%AC.md");
    // The ASCII fallback must stay inside its quotes.
    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]*"; /);
  });

  it('cannot be broken out of by a quote in the filename', () => {
    // A header that terminated early here would let a crafted title inject
    // another header parameter.
    const header = contentDisposition('eviltitle.md');
    expect(header.match(/"/g)).toHaveLength(2);
  });
});

describe('errors', () => {
  it('surfaces a service rejection as its own status', async () => {
    const { AppError } = await import('@snaglet/shared/utils');
    const { ErrorCode, HTTP_STATUS } = await import('@snaglet/shared/types');
    runExport.mockRejectedValue(
      new AppError(
        'Destination folder does not exist: /nope',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      )
    );

    const res = await request(app())
      .post('/api/export')
      .send({ kind: 'doc', id: 'doc-1', destDir: '/nope' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('does not exist');
  });

  it('does not leak a half-written response when the service throws', async () => {
    runExport.mockRejectedValue(new Error('disk full'));

    const res = await request(app())
      .post('/api/export')
      .send({ kind: 'doc', id: 'doc-1', destDir: '/x' });

    expect(res.status).toBeGreaterThanOrEqual(500);
    // A download header here would mean the route had started answering as a
    // file body before the failure — the client would save an error page.
    expect(res.headers['content-disposition']).toBeUndefined();
    // The logger is mocked to keep this deliberate failure off stdout; assert
    // it still received the error, so silencing the output cannot quietly
    // become swallowing the failure.
    expect(logger.error).toHaveBeenCalled();
  });
});
