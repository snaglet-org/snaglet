/**
 * writeTarget — the overwrite policy and the no-follow write.
 *
 * Exercised against a real filesystem with real symlinks and real FIFOs. The
 * whole point of this module is what the kernel does with an open() call, and
 * a mocked fs would happily "pass" while the hole stayed open.
 */

import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  realpath,
  mkdir,
  symlink,
  lstat,
  link,
  stat,
} from 'fs/promises';
import { writeExport } from '@server/services/ExportService/writeTarget';

const run = promisify(execFile);
const onPosix = process.platform !== 'win32';

let dir: string;
let outside: string;
let snagletHome: string;

beforeEach(async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-export-write-')));
  dir = path.join(root, 'Desktop');
  outside = path.join(root, 'elsewhere');
  snagletHome = path.join(root, 'snaglet-home');
  await mkdir(dir);
  await mkdir(outside);
  await mkdir(snagletHome);
});

afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

describe('writeExport with overwrite allowed (authenticated human via save dialog)', () => {
  (process.platform === 'win32' ? it : it.skip)(
    'preserves an existing Windows access-control list',
    async () => {
      const target = path.join(dir, 'Private notes.md');
      await writeFile(target, 'original');
      const environment = { ...process.env, SNAGLET_EXPORT_TEST_FILE: target };
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$ErrorActionPreference = "Stop"; $acl = Get-Acl -LiteralPath $env:SNAGLET_EXPORT_TEST_FILE; $acl.SetAccessRuleProtection($true, $false); $rule = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, "FullControl", "Allow"); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:SNAGLET_EXPORT_TEST_FILE -AclObject $acl',
        ],
        { env: environment, windowsHide: true }
      );
      const acl = async () =>
        (
          await run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '(Get-Acl -LiteralPath $env:SNAGLET_EXPORT_TEST_FILE).Sddl',
            ],
            { env: environment, windowsHide: true }
          )
        ).stdout.trim();
      const before = await acl();
      await writeExport(dir, 'Private notes.md', 'confidential replacement', true);
      expect(await acl()).toBe(before);
      await expect(readFile(target, 'utf8')).resolves.toBe('confidential replacement');
    }
  );

  it('replaces an existing regular file, honoring the consent the dialog collected', async () => {
    await writeFile(path.join(dir, 'Notes.md'), 'old');

    const outcome = await writeExport(dir, 'Notes.md', 'new', true);

    expect(outcome.fileName).toBe('Notes.md');
    expect(outcome.overwritten).toBe(true);
    await expect(readFile(path.join(dir, 'Notes.md'), 'utf8')).resolves.toBe('new');
    // No rename happened. A " (2)" file here would mean the user said
    // "replace" and we quietly did something else.
    expect(await readdir(dir)).toEqual(['Notes.md']);
  });

  it('creates the file when it does not exist yet', async () => {
    const outcome = await writeExport(dir, 'Notes.md', 'x', true);
    expect(outcome.overwritten).toBe(false);
    await expect(readFile(outcome.path, 'utf8')).resolves.toBe('x');
  });

  it('truncates fully — no tail of the previous, longer file survives', async () => {
    await writeFile(path.join(dir, 'Notes.md'), 'a much longer previous document');
    await writeExport(dir, 'Notes.md', 'short', true);
    await expect(readFile(path.join(dir, 'Notes.md'), 'utf8')).resolves.toBe('short');
  });
});

describe('writeExport never follows a symlink at the final component', () => {
  const maybe = onPosix ? it : it.skip;

  maybe('refuses a target symlinked OUTSIDE the chosen folder', async () => {
    const victim = path.join(outside, 'important.txt');
    await writeFile(victim, 'do not touch');
    await symlink(victim, path.join(dir, 'Notes.md'));

    await expect(writeExport(dir, 'Notes.md', 'payload', true)).rejects.toThrow(/symlink/i);

    // The guard is only real if the target is genuinely untouched.
    await expect(readFile(victim, 'utf8')).resolves.toBe('do not touch');
  });

  maybe('refuses a target symlinked INTO SNAGLET_HOME', async () => {
    // resolveExportDir guards the directory; this is the same escape one
    // level down, via the file name the caller supplied.
    const appData = path.join(snagletHome, 'home.json');
    await writeFile(appData, '{"real":true}');
    await symlink(appData, path.join(dir, 'Notes.md'));

    await expect(writeExport(dir, 'Notes.md', 'payload', true)).rejects.toThrow(/symlink/i);
    await expect(readFile(appData, 'utf8')).resolves.toBe('{"real":true}');
  });

  maybe('refuses a dangling symlink rather than creating the file it points at', async () => {
    const never = path.join(outside, 'not-created-yet.txt');
    await symlink(never, path.join(dir, 'Notes.md'));

    await expect(writeExport(dir, 'Notes.md', 'payload', true)).rejects.toThrow(/symlink/i);
    await expect(lstat(never)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  maybe('refuses a symlinked target on the no-clobber path too', async () => {
    const victim = path.join(outside, 'important.txt');
    await writeFile(victim, 'do not touch');
    await symlink(victim, path.join(dir, 'Notes.md'));

    // O_EXCL rejects an existing path of any type, so this dedupes past it.
    const outcome = await writeExport(dir, 'Notes.md', 'payload', false);

    expect(outcome.fileName).toBe('Notes (2).md');
    await expect(readFile(victim, 'utf8')).resolves.toBe('do not touch');
  });
});

describe('writeExport never writes through a hard link', () => {
  const maybe = it;

  maybe('refuses a hard-linked target and destroys nothing', async () => {
    // A hard link has no link to "not follow" — it is a regular file, sharing
    // an inode with something outside the chosen folder. O_NOFOLLOW is blind
    // to it; nlink is the only signal.
    const victim = path.join(outside, 'sensitive.conf');
    await writeFile(victim, 'original contents');
    await link(victim, path.join(dir, 'Notes.md'));

    await expect(writeExport(dir, 'Notes.md', 'payload', true)).rejects.toThrow(/hard link/i);

    // Byte-identical: proves nothing was truncated before the check ran.
    await expect(readFile(victim, 'utf8')).resolves.toBe('original contents');
    expect((await stat(victim)).size).toBe('original contents'.length);
  });

  maybe('refuses a hard link into SNAGLET_HOME', async () => {
    const appData = path.join(snagletHome, 'home.json');
    await writeFile(appData, '{"real":true}');
    await link(appData, path.join(dir, 'Notes.md'));

    await expect(writeExport(dir, 'Notes.md', 'payload', true)).rejects.toThrow(/hard link/i);
    await expect(readFile(appData, 'utf8')).resolves.toBe('{"real":true}');
  });

  maybe('still allows an ordinary single-link file', async () => {
    await writeFile(path.join(dir, 'Notes.md'), 'mine');
    await expect(writeExport(dir, 'Notes.md', 'replaced', true)).resolves.toMatchObject({
      overwritten: true,
    });
    await expect(readFile(path.join(dir, 'Notes.md'), 'utf8')).resolves.toBe('replaced');
  });

  maybe('dedupes past a hard link on the no-clobber path', async () => {
    const victim = path.join(outside, 'sensitive.conf');
    await writeFile(victim, 'original contents');
    await link(victim, path.join(dir, 'Notes.md'));

    const outcome = await writeExport(dir, 'Notes.md', 'payload', false);

    expect(outcome.fileName).toBe('Notes (2).md');
    await expect(readFile(victim, 'utf8')).resolves.toBe('original contents');
  });
});

describe('writeExport refuses non-regular targets', () => {
  it('refuses a directory', async () => {
    await mkdir(path.join(dir, 'Notes.md'));
    await expect(writeExport(dir, 'Notes.md', 'x', true)).rejects.toThrow(/folder|regular file/i);
  });

  (onPosix ? it : it.skip)('refuses a FIFO', async () => {
    // A FIFO would accept the write and hand the bytes to whoever is reading.
    await run('mkfifo', [path.join(dir, 'Notes.md')]);
    await expect(writeExport(dir, 'Notes.md', 'x', true)).rejects.toThrow(
      /regular file|symlink|folder|ENXIO/i
    );
  });
});

describe('writeExport with overwrite denied (agents, MCP, server-derived names)', () => {
  it('never clobbers — it suffixes deterministically', async () => {
    await writeFile(path.join(dir, 'Notes.md'), 'original');

    const outcome = await writeExport(dir, 'Notes.md', 'from agent', false);

    expect(outcome.fileName).toBe('Notes (2).md');
    expect(outcome.overwritten).toBe(false);
    await expect(readFile(path.join(dir, 'Notes.md'), 'utf8')).resolves.toBe('original');
    await expect(readFile(path.join(dir, 'Notes (2).md'), 'utf8')).resolves.toBe('from agent');
  });

  it('keeps counting past an existing suffix', async () => {
    await writeFile(path.join(dir, 'Notes.md'), 'a');
    await writeFile(path.join(dir, 'Notes (2).md'), 'b');
    expect((await writeExport(dir, 'Notes.md', 'c', false)).fileName).toBe('Notes (3).md');
  });

  it('is deterministic across repeated exports', async () => {
    const names: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      names.push((await writeExport(dir, 'Notes.md', String(i), false)).fileName);
    }
    expect(names).toEqual(['Notes.md', 'Notes (2).md', 'Notes (3).md']);
  });

  it('writes binary payloads unchanged', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const outcome = await writeExport(dir, 'shot.png', bytes, false);
    await expect(readFile(outcome.path)).resolves.toEqual(bytes);
  });
});

describe('writeExport filename discipline', () => {
  it('refuses a filename that is not a single segment', async () => {
    await expect(writeExport(dir, '../escape.md', 'x', true)).rejects.toThrow(
      /single path segment/i
    );
    await expect(writeExport(dir, 'a/b.md', 'x', false)).rejects.toThrow(/single path segment/i);
  });
});
