/**
 * /api/skills — read-only Skills sidebar surface.
 * Real router + real skillBrowse against a temp skills folder; only the
 * registry model is mocked.
 */
import request from 'supertest';
import express from 'express';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { SkillRegistryRow } from '@snaglet/db/tables/skill_registry';

const rows = new Map<string, SkillRegistryRow>();

jest.mock('@snaglet/db/tables/skill_registry', () => ({
  SkillRegistry: {
    listAll: async () => [...rows.values()],
    findById: async (id: string) => rows.get(id) ?? null,
  },
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(() => ({ on: jest.fn(), unref: jest.fn() })),
}));

import skillsRouter, { revealCommand } from '@server/routes/skills';
import { errorHandler } from '@server/middleware';
import { getPanelToken } from '@server/middleware/panelAuth';
import { spawn } from 'child_process';

let root: string;
let outside: string;

function row(slug: string, over: Partial<SkillRegistryRow> = {}): SkillRegistryRow {
  return {
    id: `skill-${slug}`,
    scope: 'personal',
    projectId: null,
    slug,
    name: slug,
    description: `${slug} description`,
    sourcePath: path.join(root, slug, 'SKILL.md'),
    contentHash: 'abcdef0123456789',
    status: 'valid',
    error: null,
    indexedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function app(): express.Application {
  const a = express();
  a.use(express.json());
  a.use('/api/skills', skillsRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(async () => {
  rows.clear();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snaglet-skills-route-')));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snaglet-skills-outside-')));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
  const rel = path.join(root, 'release');
  await fs.mkdir(path.join(rel, 'templates'), { recursive: true });
  await fs.writeFile(path.join(rel, 'SKILL.md'), '---\nname: Release\ndescription: d\n---\nBody');
  await fs.writeFile(path.join(rel, 'templates', 'pr.md'), 'PR template');
  await fs.writeFile(path.join(rel, 'blob.bin'), Buffer.from([1, 0, 2]));
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(rel, 'escape.txt'));
  rows.set('skill-release', row('release'));
  rows.set('skill-zeta', row('zeta', { status: 'invalid', error: 'bad frontmatter' }));
  // A row whose folder is already gone (the scanner has not deleted it yet).
  rows.set('skill-alpha', row('alpha'));
  (spawn as jest.Mock).mockClear();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('GET /api/skills', () => {
  it('lists every row sorted by slug with folder path and an 8-char version', async () => {
    const res = await request(app()).get('/api/skills').expect(200);
    const list = res.body.data as Array<Record<string, unknown>>;
    expect(list.map((s) => s.slug)).toEqual(['alpha', 'release', 'zeta']);
    const release = list[1];
    expect(release.folderPath).toBe(path.join(root, 'release'));
    expect(release.version).toBe('abcdef01');
    expect(list[0]).toMatchObject({ status: 'valid' });
    expect(list[2]).toMatchObject({ status: 'invalid', error: 'bad frontmatter' });
  });
});

describe('built-in skills are not part of the UI surface', () => {
  // A built-in folder beside the personal root, with one skill that a personal
  // skill overrides by slug and one that only exists as a built-in.
  let builtinDir: string;
  beforeEach(async () => {
    builtinDir = path.join(root, '..', `${path.basename(root)}-builtin`);
    for (const slug of ['release', 'snaglet-search']) {
      await fs.mkdir(path.join(builtinDir, slug), { recursive: true });
      await fs.writeFile(
        path.join(builtinDir, slug, 'SKILL.md'),
        '---\nname: b\ndescription: d\n---\n'
      );
    }
    const builtin = (slug: string) =>
      row(slug, {
        id: `builtin-${slug}`,
        scope: 'builtin',
        sourcePath: path.join(builtinDir, slug, 'SKILL.md'),
      });
    rows.set('builtin-release', builtin('release'));
    rows.set('builtin-snaglet-search', builtin('snaglet-search'));
  });
  afterEach(async () => {
    await fs.rm(builtinDir, { recursive: true, force: true });
  });

  it('GET /api/skills lists only the user’s own skills, keeping a personal override', async () => {
    const res = await request(app()).get('/api/skills').expect(200);
    const list = res.body.data as Array<{ id: string; slug: string }>;
    expect(list.map((s) => s.id)).toEqual(['skill-alpha', 'skill-release', 'skill-zeta']);
    expect(list.some((s) => s.slug === 'snaglet-search')).toBe(false);
  });

  it('the file routes and reveal answer 404 for a built-in id, as for an unknown one', async () => {
    const r = request(app());
    await r.get('/api/skills/builtin-snaglet-search/files').expect(404);
    await r.get('/api/skills/builtin-snaglet-search/file').query({ path: 'SKILL.md' }).expect(404);
    await r
      .post('/api/skills/builtin-snaglet-search/reveal')
      .set('x-snaglet-panel-token', getPanelToken())
      .expect(404);
    expect(spawn).not.toHaveBeenCalled();
    // The personal skill with a built-in's slug is still browsable.
    await r.get('/api/skills/skill-release/files').expect(200);
  });
});

describe('GET /api/skills/:id/files', () => {
  it('lists files with SKILL.md first and skips symlinks that escape the folder', async () => {
    const res = await request(app()).get('/api/skills/skill-release/files').expect(200);
    const paths = (res.body.data.files as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toEqual(['SKILL.md', 'blob.bin', 'templates/pr.md']);
    expect(res.body.data.truncated).toBe(false);
  });

  it('404s for an unknown id and for a skill whose folder is gone', async () => {
    await request(app()).get('/api/skills/nope/files').expect(404);
    await request(app()).get('/api/skills/skill-alpha/files').expect(404);
  });
});

describe('GET /api/skills/:id/file', () => {
  it('returns a text file with its absolute path', async () => {
    const res = await request(app())
      .get('/api/skills/skill-release/file')
      .query({ path: 'templates/pr.md' })
      .expect(200);
    expect(res.body.data).toEqual({
      path: 'templates/pr.md',
      absolutePath: path.join(root, 'release', 'templates', 'pr.md'),
      content: 'PR template',
    });
  });

  it('refuses traversal, absolute paths, and symlink escapes', async () => {
    const r = request(app());
    await r.get('/api/skills/skill-release/file').query({ path: '../zeta/SKILL.md' }).expect(404);
    await r.get('/api/skills/skill-release/file').query({ path: '/etc/hosts' }).expect(400);
    const esc = await r
      .get('/api/skills/skill-release/file')
      .query({ path: 'escape.txt' })
      .expect(400);
    expect(JSON.stringify(esc.body)).not.toContain('nope');
  });

  it('refuses binary files, directories, and an empty path', async () => {
    const r = request(app());
    await r.get('/api/skills/skill-release/file').query({ path: 'blob.bin' }).expect(415);
    await r.get('/api/skills/skill-release/file').query({ path: 'templates' }).expect(400);
    await r.get('/api/skills/skill-release/file').expect(400);
  });
});

describe('a skill folder that is itself a symlink out of the root', () => {
  // `<root>/linked -> <outside>`: the scanner marks such a row invalid but keeps
  // the unresolved sourcePath, so browse must not follow it.
  beforeEach(async () => {
    await fs.writeFile(path.join(outside, 'SKILL.md'), '---\nname: x\ndescription: d\n---\n');
    await fs.symlink(outside, path.join(root, 'linked'));
    rows.set('skill-linked', row('linked', { status: 'invalid', error: 'symlink escape' }));
  });

  it('refuses to list its files', async () => {
    const res = await request(app()).get('/api/skills/skill-linked/files').expect(400);
    expect(JSON.stringify(res.body)).not.toContain('secret.txt');
  });

  it('refuses to read a file through it', async () => {
    const res = await request(app())
      .get('/api/skills/skill-linked/file')
      .query({ path: 'secret.txt' })
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain('nope');
  });

  it('refuses to reveal it', async () => {
    await request(app())
      .post('/api/skills/skill-linked/reveal')
      .set('x-snaglet-panel-token', getPanelToken())
      .expect(400);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still serves a normal skill next to it', async () => {
    await request(app()).get('/api/skills/skill-release/files').expect(200);
  });
});

describe('POST /api/skills/:id/reveal', () => {
  it('requires the panel token', async () => {
    await request(app()).post('/api/skills/skill-release/reveal').expect(403);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reveals the registry folder (never a request-supplied path)', async () => {
    await request(app())
      .post('/api/skills/skill-release/reveal')
      .set('x-snaglet-panel-token', getPanelToken())
      .send({ path: '/etc' })
      .expect(200);
    const { cmd, args } = revealCommand(path.join(root, 'release'));
    expect(spawn).toHaveBeenCalledWith(cmd, args, expect.anything());
  });

  it('404s for a skill whose folder is gone', async () => {
    await request(app())
      .post('/api/skills/skill-alpha/reveal')
      .set('x-snaglet-panel-token', getPanelToken())
      .expect(404);
  });

  it('404s for an unknown id', async () => {
    await request(app())
      .post('/api/skills/skill-nope/reveal')
      .set('x-snaglet-panel-token', getPanelToken())
      .expect(404);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('builds argv-only commands per platform', () => {
    expect(revealCommand('/a/b', 'darwin')).toEqual({ cmd: 'open', args: ['-R', '/a/b'] });
    expect(revealCommand('/a/b', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/a'] });
  });
});
