import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realFileWithin, relativeFileTarget } from '@server/domains/files/previewPaths';

describe('relative preview boundaries', () => {
  let temp: string;
  let root: string;
  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'snaglet-preview-'));
    root = path.join(temp, 'project');
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'image space.png'), 'image');
    await writeFile(path.join(temp, 'private.txt'), 'secret');
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  it('resolves encoded sibling names and strips URL query/fragment', async () => {
    const target = relativeFileTarget(
      path.join(root, 'docs', 'readme.md'),
      '../image%20space.png?raw=1#x'
    );
    expect(target).toBe(path.join(root, 'image space.png'));
    expect(await realFileWithin(root, target!)).toBeTruthy();
  });
  it('refuses traversal and missing files', async () => {
    expect(await realFileWithin(root, path.join(root, '..', 'private.txt'))).toBeNull();
    expect(await realFileWithin(root, path.join(root, 'missing'))).toBeNull();
  });
  it('refuses symlink escapes but permits an internal alias', async () => {
    await symlink(path.join(temp, 'private.txt'), path.join(root, 'escape.txt'));
    await symlink(path.join(root, 'image space.png'), path.join(root, 'alias.png'));
    expect(await realFileWithin(root, path.join(root, 'escape.txt'))).toBeNull();
    expect(await realFileWithin(root, path.join(root, 'alias.png'))).toBeTruthy();
  });
  it.each([
    '/etc/passwd',
    '%2fetc/passwd',
    'file:secret',
    'https://example.com',
    '//host/x',
    'bad%XX',
    'a%00b',
    'a%5cb',
  ])('rejects non-relative or malformed %s', (value) => {
    expect(relativeFileTarget(path.join(root, 'readme.md'), value)).toBeNull();
  });
});
