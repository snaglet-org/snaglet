/**
 * files.routes raw-bytes endpoints — GET /api/files/:id/raw (by node id) and
 * GET /api/files/raw?path= (by absolute path), which feed the in-app PDF viewer
 * and audio player.
 *
 * Only the DB layer (Files/Projects) and the fileIndexing barrel are mocked;
 * the express wiring, error envelope, folder containment and on-disk reads
 * from a per-test temp folder are real. Covers Content-Type per extension,
 * `../` escapes (404, never read), missing files (404), the size cap (413),
 * archived projects reading like a missing body, and the /api token auth.
 */
import { mkdtempSync, writeFileSync, rmSync, truncateSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import express from 'express';

const mockFindFileById = jest.fn();
const mockFindProjectById = jest.fn();
const mockListAllProjects = jest.fn();

jest.mock('@snaglet/db', () => ({
  Files: { findById: (id: string) => mockFindFileById(id) },
  Projects: {
    findById: (id: string) => mockFindProjectById(id),
    listAll: () => mockListAllProjects(),
  },
}));

// The real fileIndexing barrel pulls chokidar + the embedding/watcher graph,
// none of which the raw routes touch. Only getFileSearchScope is imported by
// files.routes (used by the list route); stub it so the import stays light.
jest.mock('@server/services/fileIndexing', () => ({
  getFileSearchScope: jest.fn(() => null),
}));

async function buildApp(): Promise<express.Application> {
  const filesRoutes = (await import('@server/domains/files/files.routes')).default;
  const { errorHandler } = await import('@server/middleware');
  const app = express();
  app.use('/api/files', filesRoutes);
  app.use(errorHandler);
  return app;
}

let tmpDir: string;
const PDF_BYTES = Buffer.from('%PDF-1.7\n\x00binary\x00bytes\n%%EOF');
/** An MPEG frame-sync header and padding: binary to the text route (NUL bytes). */
const AUDIO_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);

beforeEach(() => {
  jest.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'snaglet-files-raw-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/files/:id/raw', () => {
  test('streams the raw bytes with Content-Type application/pdf', async () => {
    writeFileSync(path.join(tmpDir, 'doc.pdf'), PDF_BYTES);
    mockFindFileById.mockResolvedValue({
      id: 'file-1',
      projectId: 'proj-1',
      relativePath: 'doc.pdf',
    });
    mockFindProjectById.mockResolvedValue({ id: 'proj-1', folderPath: tmpDir });

    const app = await buildApp();
    const res = await request(app).get('/api/files/file-1/raw');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(PDF_BYTES.length));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.body).equals(PDF_BYTES)).toBe(true);
  });

  test.each([
    ['show.mp3', 'audio/mpeg'],
    ['show.wav', 'audio/wav'],
    ['show.m4a', 'audio/mp4'],
    ['show.ogg', 'audio/ogg'],
    ['SHOW.MP3', 'audio/mpeg'],
  ])('labels %s as %s for the audio player', async (name, type) => {
    writeFileSync(path.join(tmpDir, name), AUDIO_BYTES);
    mockFindFileById.mockResolvedValue({ id: 'file-a', projectId: 'proj-1', relativePath: name });
    mockFindProjectById.mockResolvedValue({ id: 'proj-1', folderPath: tmpDir });

    const res = await request(await buildApp()).get('/api/files/file-a/raw');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(type);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.body).equals(AUDIO_BYTES)).toBe(true);
  });

  test('derives a generic Content-Type (octet-stream) for an unknown extension', async () => {
    writeFileSync(path.join(tmpDir, 'blob.bin'), PDF_BYTES);
    mockFindFileById.mockResolvedValue({
      id: 'file-2',
      projectId: 'proj-1',
      relativePath: 'blob.bin',
    });
    mockFindProjectById.mockResolvedValue({ id: 'proj-1', folderPath: tmpDir });

    const res = await request(await buildApp()).get('/api/files/file-2/raw');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
  });

  test('rejects a relative_path that escapes the project folder (traversal) with 404', async () => {
    // A secret one level above the project root must never be served.
    const parent = path.dirname(tmpDir);
    const secret = path.join(parent, `snaglet-secret-${process.pid}.txt`);
    writeFileSync(secret, Buffer.from('top secret'));
    try {
      mockFindFileById.mockResolvedValue({
        id: 'file-evil',
        projectId: 'proj-1',
        relativePath: `../${path.basename(secret)}`,
      });
      mockFindProjectById.mockResolvedValue({ id: 'proj-1', folderPath: tmpDir });

      const res = await request(await buildApp()).get('/api/files/file-evil/raw');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    } finally {
      rmSync(secret, { force: true });
    }
  });

  test('unknown file id → 404', async () => {
    mockFindFileById.mockResolvedValue(null);
    const res = await request(await buildApp()).get('/api/files/nope/raw');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('file row exists but the body is missing on disk → 404', async () => {
    mockFindFileById.mockResolvedValue({
      id: 'file-3',
      projectId: 'proj-1',
      relativePath: 'gone.pdf',
    });
    mockFindProjectById.mockResolvedValue({ id: 'proj-1', folderPath: tmpDir });

    const res = await request(await buildApp()).get('/api/files/file-3/raw');
    expect(res.status).toBe(404);
  });

  test('project has no folder_path → 404 (nothing to resolve against)', async () => {
    mockFindFileById.mockResolvedValue({
      id: 'file-4',
      projectId: 'proj-1',
      relativePath: 'doc.pdf',
    });
    mockFindProjectById.mockResolvedValue({ id: 'proj-1', folderPath: null });

    const res = await request(await buildApp()).get('/api/files/file-4/raw');
    expect(res.status).toBe(404);
  });

  test('over the size cap → 413', async () => {
    // The raw route caps at MAX_EXTRACT_PDF_SOURCE_BYTES (the same source-size
    // bound the PDF text path accepts); reference it rather than a magic number.
    const { MAX_EXTRACT_PDF_SOURCE_BYTES } = await import('@server/services/embedding/fileSource');
    const big = path.join(tmpDir, 'big.pdf');
    writeFileSync(big, PDF_BYTES);
    // Sparse-grow past the cap so the test does no multi-MB write; the route's
    // size check runs off stat() before any read, so zero-fill content is fine.
    truncateSync(big, MAX_EXTRACT_PDF_SOURCE_BYTES + 1);
    mockFindFileById.mockResolvedValue({
      id: 'file-5',
      projectId: 'proj-1',
      relativePath: 'big.pdf',
    });
    mockFindProjectById.mockResolvedValue({ id: 'proj-1', folderPath: tmpDir });

    const res = await request(await buildApp()).get('/api/files/file-5/raw');
    expect(res.status).toBe(413);
  });
});

describe('GET /api/files/raw?path=', () => {
  test('streams raw bytes for a path inside an indexed project folder', async () => {
    const abs = path.join(tmpDir, 'chip.pdf');
    writeFileSync(abs, PDF_BYTES);
    mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir }]);

    const res = await request(await buildApp())
      .get('/api/files/raw')
      .query({ path: abs });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(res.body).equals(PDF_BYTES)).toBe(true);
  });

  test('a path outside every indexed project folder → 404 (never read)', async () => {
    const outside = path.join(tmpdir(), `snaglet-outside-${process.pid}.pdf`);
    writeFileSync(outside, PDF_BYTES);
    try {
      mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir }]);

      const res = await request(await buildApp())
        .get('/api/files/raw')
        .query({ path: outside });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test('streams a not-indexed audio file nested inside a linked project folder', async () => {
    // Media is never indexed, so no file row exists: the by-path route needs
    // only containment in a live project's folder, never the index.
    const episode = path.join(tmpDir, 'episodes', '2026-01-01');
    mkdirSync(episode, { recursive: true });
    const abs = path.join(episode, 'show.mp3');
    writeFileSync(abs, AUDIO_BYTES);
    mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir }]);

    const res = await request(await buildApp())
      .get('/api/files/raw')
      .query({ path: abs });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(Buffer.from(res.body).equals(AUDIO_BYTES)).toBe(true);
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  test('an audio file over the size cap → 413, so the player can say it is too large', async () => {
    const { MAX_EXTRACT_PDF_SOURCE_BYTES } = await import('@server/services/embedding/fileSource');
    const abs = path.join(tmpDir, 'long.wav');
    writeFileSync(abs, AUDIO_BYTES);
    truncateSync(abs, MAX_EXTRACT_PDF_SOURCE_BYTES + 1);
    mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir }]);

    const res = await request(await buildApp())
      .get('/api/files/raw')
      .query({ path: abs });

    expect(res.status).toBe(413);
  });

  test('an audio file outside every linked project folder → 404 (never read)', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'snaglet-outside-audio-'));
    try {
      const abs = path.join(outside, 'show.mp3');
      writeFileSync(abs, AUDIO_BYTES);
      mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir }]);

      const res = await request(await buildApp())
        .get('/api/files/raw')
        .query({ path: abs });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('/preview reports a small binary file as binary with its real size', async () => {
    const abs = path.join(tmpDir, 'clip.mp3');
    writeFileSync(abs, AUDIO_BYTES);
    mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir }]);

    const res = await request(await buildApp())
      .get('/api/files/preview')
      .query({ path: abs });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      content: null,
      previewable: false,
      reason: 'binary',
      sizeBytes: AUDIO_BYTES.length,
    });
  });

  test('missing path query param → 400', async () => {
    const res = await request(await buildApp()).get('/api/files/raw');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('path-addressed reads skip archived projects, as /relative does', () => {
  test('/raw refuses a file whose only project is archived (404)', async () => {
    const abs = path.join(tmpDir, 'notes.md');
    writeFileSync(abs, '# Notes');
    mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir, archived: true }]);

    const raw = await request(await buildApp())
      .get('/api/files/raw')
      .query({ path: abs });
    expect(raw.status).toBe(404);
    expect(raw.body.error.code).toBe('NOT_FOUND');
  });

  test('/preview reports a file whose only project is archived as missing, unread', async () => {
    const abs = path.join(tmpDir, 'notes.md');
    writeFileSync(abs, '# Notes');
    mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir, archived: true }]);

    const preview = await request(await buildApp())
      .get('/api/files/preview')
      .query({ path: abs });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      content: null,
      previewable: false,
      reason: 'missing',
    });
  });

  test('the same file reads once its project is live again', async () => {
    const abs = path.join(tmpDir, 'notes.md');
    writeFileSync(abs, '# Notes');
    mockListAllProjects.mockResolvedValue([{ id: 'proj-1', folderPath: tmpDir, archived: false }]);
    const app = await buildApp();

    const raw = await request(app).get('/api/files/raw').query({ path: abs });
    expect(raw.status).toBe(200);

    const preview = await request(app).get('/api/files/preview').query({ path: abs });
    expect(preview.body.data).toMatchObject({ content: '# Notes', previewable: true });
  });
});

describe('id-addressed reads skip archived projects, as the path routes do', () => {
  const notes = () => path.join(tmpDir, 'notes.md');
  const project = (archived: boolean) => ({ id: 'proj-1', folderPath: tmpDir, archived });

  beforeEach(() => {
    writeFileSync(notes(), '# Notes');
    mockFindFileById.mockResolvedValue({
      id: 'file-1',
      projectId: 'proj-1',
      relativePath: 'notes.md',
      sizeBytes: 7,
    });
  });

  test.each(['content', 'raw'])(
    "/:id/%s answers an archived project's file exactly like a missing body",
    async (route) => {
      const app = await buildApp();
      // The body is on disk, but its project is archived: refused, never read.
      mockFindProjectById.mockResolvedValue(project(true));
      const archived = await request(app).get(`/api/files/file-1/${route}`);

      // The baseline: a live project whose body is gone from disk.
      rmSync(notes());
      mockFindProjectById.mockResolvedValue(project(false));
      const missing = await request(app).get(`/api/files/file-1/${route}`);

      expect(missing.status).toBe(route === 'raw' ? 404 : 200);
      expect(archived.status).toBe(missing.status);
      // Envelopes match field for field; only the response timestamp differs.
      const envelope = (body: Record<string, unknown>) => ({ ...body, timestamp: undefined });
      expect(envelope(archived.body)).toEqual(envelope(missing.body));
    }
  );

  test('/:id/content reports the archived case as missing, with no content', async () => {
    mockFindProjectById.mockResolvedValue(project(true));
    const res = await request(await buildApp()).get('/api/files/file-1/content');
    expect(res.body.data).toMatchObject({ content: null, previewable: false, reason: 'missing' });
  });

  test("a live project's file still reads on both routes", async () => {
    mockFindProjectById.mockResolvedValue(project(false));
    const app = await buildApp();

    const content = await request(app).get('/api/files/file-1/content');
    expect(content.status).toBe(200);
    expect(content.body.data).toMatchObject({ content: '# Notes', previewable: true });

    const raw = await request(app).get('/api/files/file-1/raw');
    expect(raw.status).toBe(200);
    expect(Buffer.from(raw.body).toString('utf8')).toBe('# Notes');
  });
});

describe('raw routes sit under the shared /api sidecar-token auth', () => {
  const saved = process.env.SNAGLET_AUTH_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.SNAGLET_AUTH_TOKEN;
    else process.env.SNAGLET_AUTH_TOKEN = saved;
  });

  async function buildAuthedApp(): Promise<express.Application> {
    const filesRoutes = (await import('@server/domains/files/files.routes')).default;
    const { errorHandler } = await import('@server/middleware');
    const { sidecarAuthMiddleware } = await import('@server/middleware/sidecarAuth');
    const app = express();
    app.use(sidecarAuthMiddleware);
    app.use('/api/files', filesRoutes);
    app.use(errorHandler);
    return app;
  }

  test('no x-snaglet-token when a session token is set → 401, route never runs', async () => {
    process.env.SNAGLET_AUTH_TOKEN = 'sekret';
    const app = await buildAuthedApp();
    const res = await request(app).get('/api/files/file-1/raw');
    expect(res.status).toBe(401);
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  test('correct x-snaglet-token → passes the auth gate and reaches the route', async () => {
    process.env.SNAGLET_AUTH_TOKEN = 'sekret';
    mockFindFileById.mockResolvedValue(null); // reaches the route → its own 404
    const app = await buildAuthedApp();
    const res = await request(app).get('/api/files/file-1/raw').set('x-snaglet-token', 'sekret');
    expect(res.status).toBe(404);
    expect(mockFindFileById).toHaveBeenCalledWith('file-1');
  });
});

describe('relative Markdown resources', () => {
  beforeEach(() => {
    writeFileSync(path.join(tmpDir, 'readme.md'), '# Readme');
    writeFileSync(path.join(tmpDir, 'other.md'), '# Other');
    writeFileSync(path.join(tmpDir, 'image.png'), Buffer.from([137, 80, 78, 71]));
    mockFindFileById.mockResolvedValue({
      id: 'file-source',
      projectId: 'project',
      relativePath: 'readme.md',
    });
    mockFindProjectById.mockResolvedValue({ folderPath: tmpDir });
    mockListAllProjects.mockResolvedValue([{ folderPath: tmpDir }]);
  });
  test('navigates a sibling Markdown file from an indexed id with root context', async () => {
    const res = await request(await buildApp())
      .get('/api/files/relative')
      .query({ source: 'file-source', href: 'other.md#other' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      content: '# Other',
      projectRoot: tmpDir,
      id: path.join(tmpDir, 'other.md'),
    });
  });
  test('fetches an image through the same guarded route from a path source', async () => {
    const res = await request(await buildApp())
      .get('/api/files/relative')
      .query({ source: path.join(tmpDir, 'readme.md'), href: 'image.png', raw: '1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
  test('retains a registered parent root through a nested linked project', async () => {
    const nested = path.join(tmpDir, 'nested');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'page.md'), '# Nested');
    mockListAllProjects.mockResolvedValue([{ folderPath: tmpDir }, { folderPath: nested }]);
    const app = await buildApp();
    const first = await request(app)
      .get('/api/files/relative')
      .query({ source: 'file-source', href: 'nested/page.md' });
    expect(first.status).toBe(200);
    const source = first.body.data.id;
    const root = first.body.data.projectRoot;
    const onward = await request(app)
      .get('/api/files/relative')
      .query({ source, root, href: '../other.md' });
    expect(onward.status).toBe(200);
    expect(onward.body.data.content).toBe('# Other');
    // A fresh path preview defaults to the deepest project boundary.
    const fresh = await request(app)
      .get('/api/files/relative')
      .query({ source, href: '../other.md' });
    expect(fresh.status).toBe(404);
  });
  test('rejects unregistered ancestor roots and archived registered roots', async () => {
    const app = await buildApp();
    const fake = await request(app)
      .get('/api/files/relative')
      .query({ source: 'file-source', root: path.dirname(tmpDir), href: 'other.md' });
    expect(fake.status).toBe(404);
    mockListAllProjects.mockResolvedValue([{ folderPath: tmpDir, archived: true }]);
    const archived = await request(app)
      .get('/api/files/relative')
      .query({ source: 'file-source', root: tmpDir, href: 'other.md' });
    expect(archived.status).toBe(404);
  });
  test.each(['missing.md', '../outside.md', '%2fetc/passwd'])(
    'refuses unavailable target %s',
    async (href) => {
      const res = await request(await buildApp())
        .get('/api/files/relative')
        .query({ source: 'file-source', href });
      expect(res.status).toBe(404);
    }
  );
});

test('all preview routes reject a symlink to an external file', async () => {
  const external = mkdtempSync(path.join(tmpdir(), 'snaglet-preview-external-'));
  try {
    writeFileSync(path.join(external, 'secret.md'), 'DO NOT EXPOSE');
    symlinkSync(path.join(external, 'secret.md'), path.join(tmpDir, 'escape.md'));
    writeFileSync(path.join(tmpDir, 'readme.md'), '# Readme');
    mockListAllProjects.mockResolvedValue([{ folderPath: tmpDir }]);
    mockFindFileById.mockResolvedValue({
      id: 'file-symlink',
      projectId: 'project',
      relativePath: 'escape.md',
    });
    mockFindProjectById.mockResolvedValue({ folderPath: tmpDir });
    const app = await buildApp();
    const raw = await request(app)
      .get('/api/files/raw')
      .query({ path: path.join(tmpDir, 'escape.md') });
    expect(raw.status).toBe(404);
    const indexed = await request(app).get('/api/files/file-symlink/raw');
    expect(indexed.status).toBe(404);
    const preview = await request(app)
      .get('/api/files/preview')
      .query({ path: path.join(tmpDir, 'escape.md') });
    expect(preview.body.data).toMatchObject({ previewable: false, content: null });
    const relative = await request(app)
      .get('/api/files/relative')
      .query({ source: path.join(tmpDir, 'readme.md'), href: 'escape.md' });
    expect(relative.status).toBe(404);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});
