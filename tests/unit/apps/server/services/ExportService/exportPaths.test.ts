/**
 * exportPaths — the destination guard.
 *
 * These are the only controls on a write-anywhere primitive: `POST /export` is
 * callable by the UI, by agents, and by external MCP clients, and only the
 * first of those involves a file picker. So the guard is exercised against a
 * real filesystem with real symlinks — a string-comparison test would pass
 * happily while the thing it is meant to stop still works.
 */

import path from 'path';
import os from 'os';
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from 'fs/promises';
import {
  isFilesystemRoot,
  isWithinSnagletHome,
  resolveExportDir,
  resolveExportTarget,
} from '@server/services/ExportService/exportPaths';

let root: string;
let snagletHome: string;
let outside: string;

beforeEach(async () => {
  // realpath the temp root: on macOS /var is itself a symlink to /private/var,
  // so an unresolved base would make every comparison below accidentally true.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-export-guard-')));
  snagletHome = path.join(root, 'snaglet-home');
  outside = path.join(root, 'Desktop');
  await mkdir(path.join(snagletHome, 'tools'), { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('isWithinSnagletHome', () => {
  it('rejects SNAGLET_HOME itself, not just its descendants', () => {
    // The containment idiom used elsewhere in the server (startsWith(root+sep))
    // deliberately excludes the root. Inverted into a deny check that would
    // permit writing directly into ~/.snaglet — the directory most in need of it.
    expect(isWithinSnagletHome(snagletHome, snagletHome)).toBe(true);
    expect(isWithinSnagletHome(path.join(snagletHome, 'tools'), snagletHome)).toBe(true);
  });

  it('allows unrelated folders', () => {
    expect(isWithinSnagletHome(outside, snagletHome)).toBe(false);
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    // "/x/snaglet-home-backup" must not match "/x/snaglet-home".
    expect(isWithinSnagletHome(`${snagletHome}-backup`, snagletHome)).toBe(false);
  });
});

describe('isFilesystemRoot', () => {
  it('identifies the filesystem root', () => {
    expect(isFilesystemRoot(path.parse(process.cwd()).root)).toBe(true);
  });

  it('does not flag ordinary folders', () => {
    expect(isFilesystemRoot(outside)).toBe(false);
  });
});

describe('resolveExportDir', () => {
  it('accepts an ordinary existing folder and returns its canonical form', async () => {
    await expect(resolveExportDir(outside, snagletHome)).resolves.toBe(outside);
  });

  it('requires the folder to already exist', async () => {
    // A save dialog returns a path to a file that does not exist yet, which is
    // exactly why the contract guards the directory and never the file.
    await expect(resolveExportDir(path.join(root, 'nope'), snagletHome)).rejects.toThrow(
      /does not exist/i
    );
  });

  it('rejects a file masquerading as a destination', async () => {
    const file = path.join(outside, 'notes.md');
    await writeFile(file, 'x');
    await expect(resolveExportDir(file, snagletHome)).rejects.toThrow(/not a folder/i);
  });

  it('rejects a relative path', async () => {
    await expect(resolveExportDir('./Desktop', snagletHome)).rejects.toThrow(/absolute/i);
  });

  it('rejects an empty destination', async () => {
    await expect(resolveExportDir('   ', snagletHome)).rejects.toThrow(/required/i);
  });

  it('rejects the filesystem root', async () => {
    await expect(resolveExportDir(path.parse(root).root, snagletHome)).rejects.toThrow(
      /filesystem root/i
    );
  });

  it('rejects SNAGLET_HOME itself', async () => {
    await expect(resolveExportDir(snagletHome, snagletHome)).rejects.toThrow(
      /Snaglet's own storage/i
    );
  });

  it('rejects a folder inside SNAGLET_HOME', async () => {
    await expect(resolveExportDir(path.join(snagletHome, 'tools'), snagletHome)).rejects.toThrow(
      /Snaglet's own storage/i
    );
  });

  it('rejects a symlink that points into SNAGLET_HOME', async () => {
    // The reason resolution happens before comparison. A link named
    // innocuously in the user's Desktop resolves into app storage; comparing
    // the link's own path would wave it straight through.
    const link = path.join(outside, 'looks-harmless');
    await symlink(
      path.join(snagletHome, 'tools'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    await expect(resolveExportDir(link, snagletHome)).rejects.toThrow(/Snaglet's own storage/i);
  });

  it('follows a symlink that points somewhere legitimate', async () => {
    const real = path.join(root, 'Documents');
    await mkdir(real);
    const link = path.join(outside, 'docs-link');
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');

    // Returns the resolved path, so the write lands where the guard looked.
    await expect(resolveExportDir(link, snagletHome)).resolves.toBe(real);
  });

  it('resolves .. segments before checking, so traversal cannot re-enter SNAGLET_HOME', async () => {
    const traversal = path.join(outside, '..', 'snaglet-home', 'tools');
    await expect(resolveExportDir(traversal, snagletHome)).rejects.toThrow(
      /Snaglet's own storage/i
    );
  });
});

describe('resolveExportTarget', () => {
  it('joins a guarded directory with a single-segment name', () => {
    expect(resolveExportTarget('/tmp/out', 'Notes.md')).toBe(path.join('/tmp/out', 'Notes.md'));
  });

  it('refuses a filename that is not a single segment', () => {
    // Defense in depth: callers are required to pass safeFilename output, and
    // one that forgets must fail loudly here rather than escape the directory.
    for (const bad of ['../evil.md', 'a/b.md', '/etc/passwd', '']) {
      expect(() => resolveExportTarget('/tmp/out', bad)).toThrow(/single path segment/i);
    }
  });
});
