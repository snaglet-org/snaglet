/**
 * Install-once for `npx <pkg>` MCP servers (mcpNpx + mcpInstaller): which
 * commands qualify, how the bin is chosen, what the install folder holds, and
 * every fallback to running the configured command as written. npm is a fake
 * runner that writes a fixture package into the prefix it is given, so no
 * test reaches a registry; the install root is a temp folder.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

jest.mock('@server/services/ToolService/lib/loginShellPath', () => ({
  shellPath: () => '/test/login/bin:/usr/bin:/bin',
}));

const logLines: string[] = [];
jest.mock('@server/config/logger', () => {
  const record = (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return { logger: { info: record, debug: record, warn: record, error: record } };
});

import { McpInstaller, type McpLaunchPlan } from '@server/services/McpService/mcpInstaller';
import { parseNpxCommand, resolveInstalledBin } from '@server/services/McpService/mcpNpx';
import type { McpServerConfig } from '@server/services/McpService/mcpTypes';

type InstallerOptions = NonNullable<ConstructorParameters<typeof McpInstaller>[0]>;
type NpmRunner = NonNullable<InstallerOptions['runNpm']>;

const SECRET = 'test-secret-placeholder-7f3a';

interface NpmCall {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

interface FakePackage {
  /** Version installed for `@latest`. */
  latest: string;
  /** Overrides the version npm reports (e.g. to simulate a registry surprise). */
  forceVersion?: string;
  bin?: unknown;
  files?: Record<string, string>;
}

let root: string;
let calls: NpmCall[];
let fakePackage: FakePackage;
let npmResult: Awaited<ReturnType<NpmRunner>> | null;
let clock: number;

function unscoped(name: string): string {
  return name.replace(/^@[^/]+\//, '');
}

function writePackage(prefix: string, name: string, version: string, pkg: FakePackage): void {
  const dir = path.join(prefix, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version, bin: pkg.bin ?? { [unscoped(name)]: 'server.js' } })
  );
  const files = pkg.files ?? { 'server.js': '#!/usr/bin/env node\nprocess.stdin.resume();\n' };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

const fakeNpm: NpmRunner = async (command, args, opts) => {
  calls.push({ command, args, env: opts.env, cwd: opts.cwd });
  if (npmResult) return npmResult;
  const prefix = args[args.indexOf('--prefix') + 1] ?? '';
  const spec = args[3] ?? '';
  const at = spec.indexOf('@', 1);
  const name = spec.slice(0, at);
  const requested = spec.slice(at + 1);
  const version =
    fakePackage.forceVersion ?? (requested === 'latest' ? fakePackage.latest : requested);
  writePackage(prefix, name, version, fakePackage);
  return { ok: true };
};

function makeInstaller(overrides: Partial<InstallerOptions> = {}): McpInstaller {
  return new McpInstaller({
    root,
    runNpm: fakeNpm,
    platform: 'darwin',
    now: () => clock,
    ...overrides,
  });
}

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'test-server-a',
    name: 'Test Server A',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'test-mcp-pkg@1.2.3', '--flag'],
    url: null,
    headers: {},
    env: {},
    scope: 'shared',
    enabled: true,
    requiresConfirmation: false,
    providerId: null,
    source: 'user',
    ...overrides,
  };
}

function direct(plan: McpLaunchPlan): Extract<McpLaunchPlan, { mode: 'direct' }> {
  if (plan.mode !== 'direct')
    throw new Error(`expected a direct launch, got ${JSON.stringify(plan)}`);
  return plan;
}

function readRecord(serverId = 'test-server-a'): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, serverId, 'install.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Every file under a folder, as text. */
function allFileText(dir: string): string {
  if (!existsSync(dir)) return '';
  let out = '';
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    out += statSync(full).isDirectory() ? allFileText(full) : `${readFileSync(full, 'utf8')}\n`;
  }
  return out;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'snaglet-mcp-install-'));
  calls = [];
  fakePackage = { latest: '2.0.0' };
  npmResult = null;
  clock = 1_000_000_000_000;
  logLines.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseNpxCommand', () => {
  it.each([
    [['-y', 'pkg'], { packageName: 'pkg', requested: null, exact: false, serverArgs: [] }],
    [
      ['pkg@1.2.3', 'a', 'b'],
      { packageName: 'pkg', requested: '1.2.3', exact: true, serverArgs: ['a', 'b'] },
    ],
    [
      ['--yes', '@scope/pkg@^1.2'],
      { packageName: '@scope/pkg', requested: '^1.2', exact: false, serverArgs: [] },
    ],
    [
      ['-y', 'pkg@latest', '--isolated'],
      { packageName: 'pkg', requested: null, exact: false, serverArgs: ['--isolated'] },
    ],
    [
      ['-q', '--', 'pkg', '--x'],
      { packageName: 'pkg', requested: null, exact: false, serverArgs: ['--x'] },
    ],
  ])('installs %j', (args, launch) => {
    expect(parseNpxCommand('npx', args)).toEqual({ kind: 'npx', launch });
  });

  it('recognizes npx by its absolute path too', () => {
    expect(parseNpxCommand('/test/bin/npx', ['-y', 'pkg']).kind).toBe('npx');
  });

  it('leaves other commands alone', () => {
    expect(parseNpxCommand('uvx', ['pkg'])).toEqual({ kind: 'not-npx' });
    expect(parseNpxCommand('docker', ['run', 'x'])).toEqual({ kind: 'not-npx' });
    expect(parseNpxCommand(null, [])).toEqual({ kind: 'not-npx' });
  });

  it.each([
    'github:user/repo',
    'user/repo',
    'https://example.com/pkg.tgz',
    'git+ssh://git@example.com/pkg.git',
    'file:../pkg',
    './local-pkg',
    '../x',
    '/abs/path',
    'pkg.tgz',
    'pkg@npm:other@1.0.0',
    'pkg@',
    'Pkg-Upper',
  ])('runs %s through npx as an unsupported package spec', (spec) => {
    expect(parseNpxCommand('npx', ['-y', spec])).toEqual({
      kind: 'unsupported',
      reason: 'unsupported package spec',
    });
  });

  it('names an npx option it does not install, never its value', () => {
    expect(parseNpxCommand('npx', ['--package=secret-thing', 'cmd'])).toEqual({
      kind: 'unsupported',
      reason: 'it uses the npx option --package',
    });
    expect(parseNpxCommand('npx', ['-p', 'pkg', 'cmd']).kind).toBe('unsupported');
    expect(parseNpxCommand('npx', ['-y'])).toEqual({
      kind: 'unsupported',
      reason: 'no package is named',
    });
  });
});

describe('resolveInstalledBin', () => {
  const pkgDir = () => path.join(root, 'prefix', 'node_modules', 'test-mcp-pkg');

  it('takes a string bin', async () => {
    writePackage(path.join(root, 'prefix'), 'test-mcp-pkg', '1.0.0', {
      latest: '1.0.0',
      bin: 'cli.js',
      files: { 'cli.js': '#!/usr/bin/env node\n' },
    });
    const result = await resolveInstalledBin(pkgDir(), 'test-mcp-pkg');
    expect(result).toMatchObject({
      ok: true,
      bin: { binName: 'test-mcp-pkg', nodeArgs: [], version: '1.0.0' },
    });
  });

  it("takes a map's only program, whatever its name", async () => {
    writePackage(path.join(root, 'prefix'), 'test-mcp-pkg', '1.0.0', {
      latest: '1.0.0',
      bin: { 'mcp-server-test': 'dist/index.js', alias: './dist/index.js' },
      files: { 'dist/index.js': 'module.exports = 1;\n' },
    });
    const result = await resolveInstalledBin(pkgDir(), 'test-mcp-pkg');
    expect(result).toMatchObject({ ok: true, bin: { binName: 'mcp-server-test' } });
  });

  it('takes the program named after the package when there are several', async () => {
    writePackage(path.join(root, 'prefix'), 'test-mcp-pkg', '1.0.0', {
      latest: '1.0.0',
      bin: { other: 'other.js', 'test-mcp-pkg': 'main.js' },
      files: {
        'other.js': '#!/usr/bin/env node\n',
        'main.js': '#!/usr/bin/env -S node --no-warnings\n',
      },
    });
    const result = await resolveInstalledBin(pkgDir(), 'test-mcp-pkg');
    expect(result).toMatchObject({
      ok: true,
      bin: { binName: 'test-mcp-pkg', nodeArgs: ['--no-warnings'] },
    });
  });

  it('refuses an ambiguous map', async () => {
    writePackage(path.join(root, 'prefix'), 'test-mcp-pkg', '1.0.0', {
      latest: '1.0.0',
      bin: { one: 'one.js', two: 'two.js' },
      files: { 'one.js': '', 'two.js': '' },
    });
    expect(await resolveInstalledBin(pkgDir(), 'test-mcp-pkg')).toEqual({
      ok: false,
      reason: 'the package has several programs (one, two) and none is named test-mcp-pkg',
    });
  });

  it('refuses a bin outside the package or one that is not a Node program', async () => {
    writePackage(path.join(root, 'prefix'), 'test-mcp-pkg', '1.0.0', {
      latest: '1.0.0',
      bin: '../../outside.js',
      files: {},
    });
    writeFileSync(path.join(root, 'prefix', 'outside.js'), '#!/usr/bin/env node\n');
    expect(await resolveInstalledBin(pkgDir(), 'test-mcp-pkg')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('points outside the package'),
    });

    writePackage(path.join(root, 'prefix'), 'test-mcp-pkg', '1.0.0', {
      latest: '1.0.0',
      bin: 'run.sh',
      files: { 'run.sh': '#!/bin/sh\nexec python3 server.py\n' },
    });
    expect(await resolveInstalledBin(pkgDir(), 'test-mcp-pkg')).toMatchObject({
      ok: false,
      reason: "its program test-mcp-pkg isn't a Node.js script",
    });
  });
});

describe('McpInstaller — install once', () => {
  it('installs a pinned package once and starts its bin with node', async () => {
    const installer = makeInstaller();

    const plan = direct(await installer.launchFor(config(), { install: true }));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const prefix = call.args[2]!;
    expect(call.command).toBe('npm');
    expect(call.args).toEqual([
      'install',
      '--prefix',
      prefix,
      'test-mcp-pkg@1.2.3',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
    ]);
    expect(path.dirname(prefix)).toBe(path.join(root, 'test-server-a'));
    expect(call.cwd).toBe(prefix);
    expect(call.env.PATH).toBe('/test/login/bin:/usr/bin:/bin');

    const binFile = path.join(prefix, 'node_modules', 'test-mcp-pkg', 'server.js');
    expect(plan).toEqual({
      mode: 'direct',
      command: 'node',
      args: [expect.stringMatching(/server\.js$/), '--flag'],
      binDir: path.join(prefix, 'node_modules', '.bin'),
      version: '1.2.3',
    });
    expect(path.basename(plan.args[0]!)).toBe(path.basename(binFile));

    expect(readRecord()).toMatchObject({
      schema: 1,
      packageName: 'test-mcp-pkg',
      requested: '1.2.3',
      installedVersion: '1.2.3',
      installedAt: new Date(clock).toISOString(),
      dir: path.basename(prefix),
      lastError: null,
    });

    // Later starts reuse the copy.
    await installer.launchFor(config(), { install: true });
    expect(calls).toHaveLength(1);
  });

  it('resolves an unpinned package to the latest and records the exact version', async () => {
    const installer = makeInstaller();
    const plan = direct(
      await installer.launchFor(config({ args: ['-y', 'test-mcp-pkg'] }), { install: true })
    );

    expect(calls[0]!.args[3]).toBe('test-mcp-pkg@latest');
    expect(plan.version).toBe('2.0.0');
    expect(readRecord()).toMatchObject({ requested: null, installedVersion: '2.0.0' });
  });

  it('uses the npm next to an absolute npx', async () => {
    const binDir = path.join(root, 'node-bin');
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, 'npm'), '');
    const installer = makeInstaller();
    await installer.launchFor(config({ command: path.join(binDir, 'npx') }), { install: true });
    expect(calls[0]!.command).toBe(path.join(binDir, 'npm'));
  });

  it('shares one install between concurrent starts', async () => {
    const installer = makeInstaller();
    const plans = await Promise.all([
      installer.launchFor(config(), { install: true }),
      installer.launchFor(config(), { install: true }),
      installer.ensureInstalled(config()),
    ]);
    expect(calls).toHaveLength(1);
    expect(plans[0]).toEqual(plans[1]);
  });

  it('reinstalls when the package.json on disk disagrees with the recorded version', async () => {
    const installer = makeInstaller();
    const first = direct(await installer.launchFor(config(), { install: true }));
    const pkgJson = path.join(path.dirname(first.args[0]!), 'package.json');
    writeFileSync(
      pkgJson,
      JSON.stringify({ name: 'test-mcp-pkg', version: '9.9.9', bin: 'server.js' })
    );

    const second = direct(await installer.launchFor(config(), { install: true }));

    expect(calls).toHaveLength(2);
    expect(second.version).toBe('1.2.3');
    expect(second.args[0]).not.toBe(first.args[0]);
    expect(existsSync(first.args[0]!)).toBe(false);
  });

  it('reinstalls when the command now asks for another version', async () => {
    const installer = makeInstaller();
    await installer.launchFor(config(), { install: true });
    const plan = direct(
      await installer.launchFor(config({ args: ['-y', 'test-mcp-pkg@1.3.0'] }), { install: true })
    );
    expect(calls.map((c) => c.args[3])).toEqual(['test-mcp-pkg@1.2.3', 'test-mcp-pkg@1.3.0']);
    expect(plan.version).toBe('1.3.0');
  });

  it('does not install without `install` (Test Connection) and says why', async () => {
    const installer = makeInstaller();
    expect(await installer.launchFor(config(), { install: false })).toEqual({
      mode: 'npx',
      reason: 'not installed yet',
    });
    expect(calls).toHaveLength(0);
  });

  it('leaves non-npx commands to run as configured', async () => {
    const installer = makeInstaller();
    expect(
      await installer.launchFor(config({ command: 'uvx', args: ['pkg'] }), { install: true })
    ).toEqual({
      mode: 'configured',
    });
    expect(await installer.describe(config({ command: 'uvx', args: ['pkg'] }))).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('McpInstaller — fallback to npx as configured', () => {
  it('falls back when npm is missing, records why, and waits before retrying', async () => {
    npmResult = { ok: false, notFound: true, message: "npm wasn't found on PATH" };
    const installer = makeInstaller();

    expect(await installer.launchFor(config(), { install: true })).toEqual({
      mode: 'npx',
      reason: "npm wasn't found on PATH",
    });
    expect(readRecord()).toMatchObject({
      installedVersion: null,
      lastError: "npm wasn't found on PATH",
      lastErrorSpec: 'test-mcp-pkg@1.2.3',
    });
    expect(await installer.describe(config())).toMatchObject({
      state: 'npx',
      reason: "npm wasn't found on PATH",
      updatable: true,
    });
    // No staging folder is left behind.
    expect(readdirSync(path.join(root, 'test-server-a'))).toEqual(['install.json']);

    await installer.launchFor(config(), { install: true });
    expect(calls).toHaveLength(1);

    npmResult = null;
    clock += 61 * 60_000;
    direct(await installer.launchFor(config(), { install: true }));
    expect(calls).toHaveLength(2);
  });

  it('falls back when the install fails', async () => {
    npmResult = {
      ok: false,
      notFound: false,
      message: 'E404 Not Found - GET https://registry.example/test-mcp-pkg',
    };
    const installer = makeInstaller();
    expect(await installer.launchFor(config(), { install: true })).toEqual({
      mode: 'npx',
      reason: 'install failed: E404 Not Found - GET https://registry.example/test-mcp-pkg',
    });
  });

  it('falls back when the bin is ambiguous', async () => {
    fakePackage = {
      latest: '1.2.3',
      bin: { one: 'one.js', two: 'two.js' },
      files: { 'one.js': '', 'two.js': '' },
    };
    const installer = makeInstaller();
    expect(await installer.launchFor(config(), { install: true })).toEqual({
      mode: 'npx',
      reason: 'the package has several programs (one, two) and none is named test-mcp-pkg',
    });
    expect(readdirSync(path.join(root, 'test-server-a'))).toEqual(['install.json']);
  });

  it('never starts a version other than the pinned one', async () => {
    fakePackage = { latest: '1.2.3', forceVersion: '1.2.4' };
    const installer = makeInstaller();
    expect(await installer.launchFor(config(), { install: true })).toEqual({
      mode: 'npx',
      reason: 'npm installed 1.2.4, not the pinned 1.2.3',
    });
  });

  it('falls back for an unsupported spec without touching npm or disk', async () => {
    const installer = makeInstaller();
    const hostile = config({ args: ['-y', '../x'] });
    expect(await installer.launchFor(hostile, { install: true })).toEqual({
      mode: 'npx',
      reason: 'unsupported package spec',
    });
    expect(await installer.describe(hostile)).toMatchObject({ state: 'npx', updatable: false });
    expect(calls).toHaveLength(0);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses an install folder for a hostile server id', async () => {
    const installer = makeInstaller();
    for (const id of ['../x', 'a/b', '..', '.', '']) {
      await expect(installer.serverDir(id)).rejects.toThrow('unsafe server id');
      const plan = await installer.launchFor(config({ id }), { install: true });
      expect(plan.mode).toBe('npx');
    }
    expect(calls).toHaveLength(0);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(path.join(path.dirname(root), 'x'))).toBe(false);
  });

  it('runs npx on Windows, as configured', async () => {
    const installer = makeInstaller({ platform: 'win32' });
    expect(await installer.launchFor(config(), { install: true })).toEqual({
      mode: 'npx',
      reason: "install-once isn't supported on Windows yet",
    });
    expect(calls).toHaveLength(0);
  });
});

describe('McpInstaller — the pane and the folder', () => {
  it('describes pending, installing and installed', async () => {
    const installer = makeInstaller();
    expect(await installer.describe(config())).toMatchObject({
      state: 'pending',
      packageName: 'test-mcp-pkg',
      requested: '1.2.3',
    });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = makeInstaller({
      runNpm: async (...args) => {
        await gate;
        return fakeNpm(...args);
      },
    });
    const installing = slow.launchFor(config(), { install: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await slow.describe(config())).toMatchObject({ state: 'installing' });
    release();
    await installing;
    expect(await slow.describe(config())).toMatchObject({
      state: 'installed',
      installedVersion: '1.2.3',
      installedAt: new Date(clock).toISOString(),
      lastError: null,
    });
  });

  it('keeps the old copy during an update with keepOld, then prunes it', async () => {
    const installer = makeInstaller();
    const first = direct(
      await installer.launchFor(config({ args: ['-y', 'test-mcp-pkg'] }), { install: true })
    );
    fakePackage = { latest: '2.1.0' };
    clock += 1000;
    const parsed = parseNpxCommand('npx', ['-y', 'test-mcp-pkg']);
    if (parsed.kind !== 'npx') throw new Error('expected npx');

    const outcome = await installer.install(
      config({ args: ['-y', 'test-mcp-pkg'] }),
      parsed.launch,
      { keepOld: true }
    );

    expect(outcome).toEqual({ ok: true, version: '2.1.0', previousVersion: '2.0.0' });
    expect(existsSync(first.args[0]!)).toBe(true);
    await installer.pruneOld('test-server-a');
    expect(existsSync(first.args[0]!)).toBe(false);
    expect(
      readdirSync(path.join(root, 'test-server-a')).filter((n) => n.startsWith('pkg-'))
    ).toHaveLength(1);
  });

  it('removes a server folder, and at boot only the folders of unknown servers', async () => {
    const installer = makeInstaller();
    await installer.launchFor(config(), { install: true });
    await installer.launchFor(config({ id: 'test-server-b' }), { install: true });
    mkdirSync(path.join(root, 'test-server-gone'));

    await installer.pruneOrphans(new Set(['test-server-a', 'test-server-b']));
    expect(readdirSync(root).sort()).toEqual(['test-server-a', 'test-server-b']);

    await installer.remove('test-server-b');
    expect(readdirSync(root)).toEqual(['test-server-a']);
  });

  it('never writes or logs a secret from the env, headers or args', async () => {
    const installer = makeInstaller();
    const secretConfig = config({
      args: ['-y', 'test-mcp-pkg@1.2.3', `postgres://user:${SECRET}@db.example/test`],
      env: { API_TOKEN: SECRET, OTHER: '${credential}' },
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    direct(await installer.launchFor(secretConfig, { install: true }));
    npmResult = { ok: false, notFound: false, message: 'E500' };
    const parsed = parseNpxCommand(secretConfig.command, secretConfig.args);
    if (parsed.kind !== 'npx') throw new Error('expected npx');
    await installer.install(secretConfig, parsed.launch);
    await installer.describe(secretConfig);

    expect(allFileText(root)).not.toContain(SECRET);
    expect(logLines.join('\n')).not.toContain(SECRET);
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain(SECRET);
      expect(call.env.API_TOKEN).toBeUndefined();
    }
  });
});
