/**
 * POST /api/files/rename — renaming an image in a linked project folder, in
 * place. The folders and files are real temp files; only the DB layer is
 * mocked, so containment, the no-overwrite rule, case-only renames, the
 * extension rule and file-system refusals are checked against a real
 * filesystem.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import express from 'express';

const mockListAllProjects = jest.fn();

jest.mock('@snaglet/db', () => ({
  Files: { findById: jest.fn() },
  Projects: { findById: jest.fn(), listAll: () => mockListAllProjects() },
}));

jest.mock('@server/services/fileIndexing', () => ({
  getFileSearchScope: jest.fn(() => null),
}));

jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Set to an errno code to make the next file-system rename step fail with it. */
let renameFailure: string | null = null;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
  return {
    ...actual,
    link: (from: string, to: string) =>
      renameFailure ? fail(renameFailure) : actual.link(from, to),
    rename: (from: string, to: string) =>
      renameFailure ? fail(renameFailure) : actual.rename(from, to),
  };
});

import { nameToSave } from '@server/domains/files/renameProjectFile';

async function buildApp(): Promise<express.Application> {
  const filesRoutes = (await import('@server/domains/files/files.routes')).default;
  const { errorHandler } = await import('@server/middleware');
  const app = express();
  app.use(express.json());
  app.use('/api/files', filesRoutes);
  app.use(errorHandler);
  return app;
}

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
let root: string;
let folder: string;
let outside: string;

function rename(body: Record<string, unknown>) {
  return buildApp().then((app) => request(app).post('/api/files/rename').send(body));
}

beforeEach(() => {
  jest.clearAllMocks();
  renameFailure = null;
  root = mkdtempSync(path.join(tmpdir(), 'snaglet-files-rename-'));
  folder = path.join(root, 'project');
  outside = path.join(root, 'outside');
  mkdirSync(path.join(folder, 'img'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(folder, 'img', 'a.png'), 'A-bytes');
  writeFileSync(path.join(folder, 'img', 'b.png'), 'B-bytes');
  writeFileSync(path.join(folder, 'notes.md'), '# notes');
  writeFileSync(path.join(outside, 'secret.png'), 'outside');
  mockListAllProjects.mockResolvedValue([
    { id: PROJECT_ID, folderPath: folder, archived: false },
    { id: 'container-2222222222222-bbbbbbbbb', folderPath: null, archived: false },
  ]);
});

afterEach(() => {
  chmodSync(path.join(folder, 'img'), 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe('POST /api/files/rename', () => {
  it('renames an image in its folder and keeps the bytes', async () => {
    const res = await rename({ path: path.join(folder, 'img', 'a.png'), name: 'Sunset.png' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      path: path.join(folder, 'img', 'Sunset.png'),
      name: 'Sunset.png',
    });
    expect(readdirSync(path.join(folder, 'img')).sort()).toEqual(['Sunset.png', 'b.png']);
    expect(readFileSync(path.join(folder, 'img', 'Sunset.png'), 'utf8')).toBe('A-bytes');
  });

  it('keeps the old extension when the new name leaves it off', async () => {
    const res = await rename({ path: path.join(folder, 'img', 'a.png'), name: ' Sunset ' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Sunset.png');
    expect(readdirSync(path.join(folder, 'img')).sort()).toEqual(['Sunset.png', 'b.png']);
  });

  it.each([
    ['v1.2 final', 'v1.2 final.png'],
    ['Screenshot at 10.15.32', 'Screenshot at 10.15.32.png'],
    ['Fig.1', 'Fig.1.png'],
    ['Mr. Smith', 'Mr. Smith.png'],
    ['photo', 'photo.png'],
    ['notes.txt', 'notes.txt.png'],
    ['Report.final', 'Report.final.png'],
    ['v2.draft', 'v2.draft.png'],
    ['St.Louis', 'St.Louis.png'],
    ['Photo.Jan', 'Photo.Jan.png'],
    ['final.v2', 'final.v2.png'],
    ['e.g', 'e.g.png'],
    ['photo.jpg', 'photo.jpg.png'],
    ['Sunset.png', 'Sunset.png'],
    ['Sunset.PNG', 'Sunset.PNG'],
  ])('saves %j over a .png as %j', (typed, saved) => {
    expect(nameToSave('a.png', typed)).toBe(saved);
  });

  it.each([
    ['a.jpg', 'Sunset.jpeg', 'Sunset.jpeg'],
    ['a.jpeg', 'Sunset.jpg', 'Sunset.jpg'],
    ['a.JPG', 'Sunset.Jpeg', 'Sunset.Jpeg'],
    ['a.tif', 'Scan.tiff', 'Scan.tiff'],
    ['a.TIFF', 'Scan.TIF', 'Scan.TIF'],
    ['a.jpg', 'Sunset.png', 'Sunset.png.jpg'],
  ])('over %j saves %j as %j, treating spellings of one format alike', (old, typed, saved) => {
    expect(nameToSave(old, typed)).toBe(saved);
  });

  it('keeps the image a .png when a different extension is typed', async () => {
    const res = await rename({ path: path.join(folder, 'img', 'a.png'), name: 'notes.txt' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('notes.txt.png');
    expect(readdirSync(path.join(folder, 'img')).sort()).toEqual(['b.png', 'notes.txt.png']);
  });

  it('never overwrites an existing file', async () => {
    const res = await rename({ path: path.join(folder, 'img', 'a.png'), name: 'b.png' });
    expect(res.status).toBe(409);
    expect(res.body.error?.message ?? JSON.stringify(res.body)).toMatch(/already exists/);
    expect(readFileSync(path.join(folder, 'img', 'a.png'), 'utf8')).toBe('A-bytes');
    expect(readFileSync(path.join(folder, 'img', 'b.png'), 'utf8')).toBe('B-bytes');
  });

  it('allows a case-only rename', async () => {
    const res = await rename({ path: path.join(folder, 'img', 'a.png'), name: 'A.png' });
    expect(res.status).toBe(200);
    expect(readdirSync(path.join(folder, 'img')).sort()).toEqual(['A.png', 'b.png']);
    expect(readFileSync(path.join(folder, 'img', 'A.png'), 'utf8')).toBe('A-bytes');
  });

  it.each([
    ['', /Enter a file name/],
    ['..', /cannot be a file name/],
    ['../escape.png', /cannot contain/],
    ['sub/dir.png', /cannot contain/],
    ['a:b.png', /cannot contain/],
    ['.hidden.png', /start with a dot/],
    [`${'x'.repeat(300)}.png`, /too long/],
  ])('refuses the name %j', async (name, message) => {
    const res = await rename({ path: path.join(folder, 'img', 'a.png'), name });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(message);
    expect(readdirSync(path.join(folder, 'img')).sort()).toEqual(['a.png', 'b.png']);
  });

  it('refuses a file outside every linked project folder', async () => {
    const res = await rename({ path: path.join(outside, 'secret.png'), name: 'renamed.png' });
    expect(res.status).toBe(404);
    expect(readdirSync(outside)).toEqual(['secret.png']);
  });

  it('refuses a path that leaves the folder through a symlink', async () => {
    symlinkSync(outside, path.join(folder, 'link'));
    const res = await rename({ path: path.join(folder, 'link', 'secret.png'), name: 'x.png' });
    expect(res.status).toBe(404);
    expect(readdirSync(outside)).toEqual(['secret.png']);
  });

  it('refuses a `..` path that resolves outside the folder', async () => {
    const res = await rename({
      path: `${folder}/img/../../outside/secret.png`,
      name: 'x.png',
    });
    expect(res.status).toBe(404);
    expect(readdirSync(outside)).toEqual(['secret.png']);
  });

  it('refuses files that are not images', async () => {
    const res = await rename({ path: path.join(folder, 'notes.md'), name: 'plan.md' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Only image files/);
    expect(readdirSync(folder)).toContain('notes.md');
  });

  it('refuses a missing file and a relative path', async () => {
    expect((await rename({ path: path.join(folder, 'img', 'nope.png'), name: 'x' })).status).toBe(
      404
    );
    expect((await rename({ path: 'img/a.png', name: 'x' })).status).toBe(400);
  });

  it('reports a folder Snaglet may not write as a 403 without the full path', async () => {
    if (process.getuid?.() === 0) return;
    chmodSync(path.join(folder, 'img'), 0o555);
    const res = await rename({ path: path.join(folder, 'img', 'a.png'), name: 'Sunset' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/not allowed to rename \\"a\.png\\"/);
    expect(JSON.stringify(res.body)).not.toContain(folder);
    expect(readdirSync(path.join(folder, 'img')).sort()).toEqual(['a.png', 'b.png']);
  });

  it.each([
    ['EPERM', 403, /may be locked/],
    ['EROFS', 403, /read-only disk/],
    ['EBUSY', 409, /in use/],
  ])('maps %s to a %i with a clear message', async (code, status, message) => {
    renameFailure = code;
    const res = await rename({ path: path.join(folder, 'img', 'a.png'), name: 'Sunset' });
    expect(res.status).toBe(status);
    expect(JSON.stringify(res.body)).toMatch(message);
    expect(JSON.stringify(res.body)).not.toContain(folder);
    expect(readdirSync(path.join(folder, 'img')).sort()).toEqual(['a.png', 'b.png']);
  });
});
