/**
 * `snaglet create-script`, against the real CLI and a real filesystem.
 *
 * The command is spawned as a child process with `SNAGLET_SCRIPTS_DIR` pointed at a
 * temp directory, rather than importing anything: `bin/snaglet.mjs` is a top-level
 * script that calls `process.exit`, and the exit codes and stderr copy are
 * part of what is being tested. A unit test that reached inside it would not
 * be testing the command a user actually runs.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

const run = promisify(execFile);

// Resolved from the jest rootDir (the repo root) rather than `import.meta`,
// which is not available under this project's CommonJS transform.
const CLI = resolve(process.cwd(), 'packages/snaglet-cli/bin/snaglet.mjs');

let scriptsDir: string;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Invoke the CLI. Never throws — a nonzero exit is a result, not an error. */
async function snaglet(...args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, SNAGLET_SCRIPTS_DIR: scriptsDir },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeEach(async () => {
  scriptsDir = join(await mkdtemp(join(tmpdir(), 'snaglet-cli-')), 'scripts');
});

afterEach(async () => {
  await rm(dirname(scriptsDir), { recursive: true, force: true });
});

describe('first run — bootstrap is preserved', () => {
  it('creates the dir, the manifest, and a runnable hello.mjs with no name given', async () => {
    const res = await snaglet('create-script');

    expect(res.code).toBe(0);
    expect(await readdir(scriptsDir)).toEqual(
      expect.arrayContaining(['package.json', 'hello.mjs'])
    );

    // The manifest is what lets .ts/.js scripts use top-level await.
    const manifest = JSON.parse(await readFile(join(scriptsDir, 'package.json'), 'utf8'));
    expect(manifest).toEqual({ name: 'snaglet-scripts', type: 'module' });

    const starter = await readFile(join(scriptsDir, 'hello.mjs'), 'utf8');
    expect(starter).toContain("import { tools, snaglet } from '@snaglet/sdk'");
    expect(starter).toContain('get_current_datetime');
    expect(res.stdout).toContain('Scripts directory ready');
  });

  it('preserves the hello.mjs bootstrap even when a name is supplied', async () => {
    const res = await snaglet('create-script', 'daily-report');

    expect(res.code).toBe(0);
    const entries = await readdir(scriptsDir);
    expect(entries).toContain('hello.mjs');
    expect(entries).toContain('package.json');
    expect(entries).not.toContain('daily-report.mjs');
  });

  it('treats a dir containing only a manifest as still empty', async () => {
    // package.json is a prerequisite, not a script — its presence must not
    // flip the command into "name required" mode.
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'package.json'), '{}');

    const res = await snaglet('create-script');

    expect(res.code).toBe(0);
    expect(await readdir(scriptsDir)).toContain('hello.mjs');
  });
});

describe('once scripts exist, the name is required', () => {
  beforeEach(async () => {
    await snaglet('create-script');
  });

  it('exits nonzero with targeted usage when the name is omitted', async () => {
    const res = await snaglet('create-script');

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('needs a name');
    expect(res.stderr).toContain('Usage: snaglet create-script <name>');
    // Targeted usage, not the whole CLI help dump.
    expect(res.stderr).not.toContain('snaglet hook list');
    expect(res.stderr).not.toContain('snaglet mcp bridges');
  });

  it('creates nothing on that failure', async () => {
    const before = (await readdir(scriptsDir)).sort();
    await snaglet('create-script');
    expect((await readdir(scriptsDir)).sort()).toEqual(before);
  });
});

describe('language templates', () => {
  beforeEach(async () => {
    await snaglet('create-script');
  });

  it.each([
    ['second.mjs', 'second.mjs'],
    ['third.js', 'third.js'],
    ['fourth.ts', 'fourth.ts'],
    ['no-extension', 'no-extension.mjs'],
  ])('%s produces a Node starter at %s', async (given, expected) => {
    const res = await snaglet('create-script', given);

    expect(res.code).toBe(0);
    const body = await readFile(join(scriptsDir, expected), 'utf8');
    expect(body).toContain("import { tools, snaglet } from '@snaglet/sdk'");
    // The run hint must name the file that was actually created.
    expect(body).toContain(`snaglet run ${expected}`);
  });

  it('.py produces a Python starter, not a Node one', async () => {
    const res = await snaglet('create-script', 'cleanup.py');

    expect(res.code).toBe(0);
    const body = await readFile(join(scriptsDir, 'cleanup.py'), 'utf8');
    // `snaglet run` puts packages/snaglet-cli/src/pylib on PYTHONPATH, so this import
    // resolves against the shipped snaglet_sdk module.
    expect(body).toContain('from snaglet_sdk import tools');
    expect(body).not.toContain('@snaglet/sdk');
    expect(body).not.toContain('await');
  });
});

describe('never clobbers', () => {
  it('refuses an existing file and leaves its contents untouched', async () => {
    await snaglet('create-script');
    const target = join(scriptsDir, 'hello.mjs');
    await writeFile(target, '// my own work\n');

    const res = await snaglet('create-script', 'hello.mjs');

    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/already exists/i);
    // The real assertion: overwriting a script is the one unrecoverable
    // thing this command could do.
    await expect(readFile(target, 'utf8')).resolves.toBe('// my own work\n');
  });

  it('refuses a collision reached via the default extension', async () => {
    await snaglet('create-script');
    await writeFile(join(scriptsDir, 'report.mjs'), 'mine');

    // `report` resolves to `report.mjs`, which exists.
    const res = await snaglet('create-script', 'report');

    expect(res.code).toBe(1);
    await expect(readFile(join(scriptsDir, 'report.mjs'), 'utf8')).resolves.toBe('mine');
  });
});

describe('creation is atomic, not check-then-write', () => {
  it('lets exactly one of many concurrent creators win', async () => {
    await snaglet('create-script');
    const target = join(scriptsDir, 'contended.mjs');

    // A check-then-write has two syscalls with a gap between them: every
    // racer would see "absent", and the last writer would silently destroy
    // the others' file. `wx` makes the kernel pick one.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => snaglet('create-script', 'contended.mjs'))
    );

    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code === 1)).toHaveLength(7);
    for (const loser of results.filter((r) => r.code === 1)) {
      expect(loser.stderr).toMatch(/already exists/i);
    }

    // One winner means one intact template — not a torn or doubled file.
    const body = await readFile(target, 'utf8');
    expect(body.match(/@snaglet\/sdk/g)).toHaveLength(1);
  });

  it('does not overwrite a manifest that already exists', async () => {
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'package.json'), '{"name":"mine","type":"module"}');

    const res = await snaglet('create-script');

    expect(res.code).toBe(0);
    // A hand-edited manifest is the user's own; the command needs it to
    // exist, not to be its own.
    await expect(readFile(join(scriptsDir, 'package.json'), 'utf8')).resolves.toBe(
      '{"name":"mine","type":"module"}'
    );
  });
});

describe('a directory named like a script is not a script', () => {
  it('still treats the scripts dir as empty', async () => {
    await mkdir(join(scriptsDir, 'notreally.js'), { recursive: true });

    // Counting it would flip the command into "name required" mode on what
    // is really an empty scripts dir, blocking the bootstrap.
    const res = await snaglet('create-script');

    expect(res.code).toBe(0);
    expect(await readdir(scriptsDir)).toContain('hello.mjs');
  });

  it('requires a name once a real script file exists', async () => {
    await mkdir(join(scriptsDir, 'notreally.js'), { recursive: true });
    await writeFile(join(scriptsDir, 'real.mjs'), '// real');

    const res = await snaglet('create-script');

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('needs a name');
  });
});

describe('extra positional arguments are refused, never ignored', () => {
  beforeEach(async () => {
    await snaglet('create-script');
  });

  it('refuses two names instead of silently creating the first', async () => {
    const before = (await readdir(scriptsDir)).sort();

    const res = await snaglet('create-script', 'one.mjs', 'two.mjs');

    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/takes ONE name/i);
    expect(res.stderr).toContain('Usage: snaglet create-script <name>');
    expect((await readdir(scriptsDir)).sort()).toEqual(before);
  });

  it('refuses an unquoted name with a space, which arrives as two operands', async () => {
    // `snaglet create-script daily report` is the realistic way this happens.
    const res = await snaglet('create-script', 'daily', 'report');

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('cannot contain spaces');
    expect(await readdir(scriptsDir)).not.toContain('daily.mjs');
  });
});

describe('rejects names that are not names', () => {
  beforeEach(async () => {
    await snaglet('create-script');
  });

  it.each([
    ['a path separator', 'sub/dir.mjs'],
    ['a backslash', 'sub\\dir.mjs'],
    ['traversal', '../escape.mjs'],
    ['an absolute path', '/tmp/evil.mjs'],
    ['a hidden name', '.secret.mjs'],
    ['bare dot', '.'],
    ['bare dotdot', '..'],
    ['an unsupported extension', 'script.sh'],
    ['a bare extension', '.mjs'],
    ['a reserved device name', 'con.mjs'],
    ['a BARE reserved name that would take the default extension', 'con'],
    ['a bare reserved name in another case', 'PRN'],
    ['a reserved COM port', 'com1'],
    ['a reserved LPT port with an extension', 'lpt9.py'],
  ])('refuses %s', async (_label, name) => {
    const before = (await readdir(scriptsDir)).sort();

    const res = await snaglet('create-script', name);

    expect(res.code).toBe(1);
    expect(res.stderr.trim()).not.toBe('');
    // Refusal, never repair: a name that needs fixing is not the name the
    // user meant, and a silently-renamed file lands where they will not look.
    expect((await readdir(scriptsDir)).sort()).toEqual(before);
  });

  it('names the supported extensions when refusing an unsupported one', async () => {
    const res = await snaglet('create-script', 'script.sh');
    expect(res.stderr).toContain('.mjs');
    expect(res.stderr).toContain('.py');
  });

  it('does not escape the scripts dir even when asked to', async () => {
    const parent = dirname(scriptsDir);
    await snaglet('create-script', '../escape.mjs');
    expect(await readdir(parent)).not.toContain('escape.mjs');
  });
});

describe('init is not a command', () => {
  it('is refused as unknown and creates nothing', async () => {
    const res = await snaglet('init');

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Unknown command: init');
    await expect(stat(scriptsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('help and hints name create-script', () => {
  it('the empty-scripts hint points at create-script', async () => {
    const res = await snaglet('scripts');

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('snaglet create-script');
    expect(res.stdout).not.toContain(`snaglet ${'in' + 'it'}`);
  });

  it('help mentions create-script and not init', async () => {
    const res = await snaglet('--help');
    expect(res.stdout).toContain('create-script');
    expect(res.stdout).not.toContain(`snaglet ${'in' + 'it'}`);
  });
});

describe('SNAGLET_SCRIPTS_DIR behavior is preserved', () => {
  it('writes into the overridden dir, creating it if absent', async () => {
    // scriptsDir intentionally does not exist yet in beforeEach.
    await expect(stat(scriptsDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const res = await snaglet('create-script');

    expect(res.code).toBe(0);
    expect((await stat(scriptsDir)).isDirectory()).toBe(true);
    expect(res.stdout).toContain(scriptsDir);
  });
});

describe('Windows-portable names', () => {
  beforeEach(async () => {
    await snaglet('create-script');
  });

  it('keeps quoted spaces and Unicode intact', async () => {
    const res = await snaglet('create-script', 'daily report-å.mjs');
    expect(res.code).toBe(0);
    await expect(readFile(join(scriptsDir, 'daily report-å.mjs'), 'utf8')).resolves.toContain(
      '@snaglet/sdk'
    );
  });

  it.each(['report:.mjs', 'report.mjs '])('rejects %s', async (name) => {
    const res = await snaglet('create-script', name);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('not portable to Windows');
  });
});
