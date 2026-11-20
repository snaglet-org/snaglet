/**
 * Install-once with real processes: a fake `npm` (a script on the server's
 * PATH that writes a package wrapping tests/support/fake-mcp-stdio-server.cjs)
 * and the real SDK stdio transport. Proves that an `npx <pkg>` server runs as
 * one process, a direct child of Snaglet started with node — no `npm exec`
 * wrapper — with its configured args; that Update restarts it on a fresh
 * copy; that a failed install or a missing npm runs the configured npx
 * command exactly as written (a fake `npx` records it); and that a secret in
 * the server's env or args never reaches npm, the install folder or a log.
 * No registry is ever contacted.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SECRET = 'test-secret-placeholder-9c41';

jest.mock('@server/services/ToolService/lib/loginShellPath', () => ({
  resolveLoginShellPath: async () => undefined,
  shellPath: () => process.env.PATH,
}));

jest.mock('@server/services/McpService/mcpCredentials', () => ({
  resolveEnv: async (config: { env: Record<string, string> }) =>
    Object.fromEntries(
      Object.entries(config.env).map(([key, value]) => [
        key,
        value === '${credential}' ? 'test-secret-placeholder-9c41' : value,
      ])
    ),
  resolveHeaders: async () => ({}),
  configRequiresCredential: () => true,
  configCredentialSpec: () => ({ requiresSecret: true, bundleFields: [] }),
  credentialKeyForConfig: (config: { id: string; providerId: string | null }) =>
    config.providerId ?? config.id,
}));

interface ServerRowFixture {
  id: string;
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  url: null;
  headers: Record<string, string>;
  env: Record<string, string>;
  scope: 'shared';
  enabled: boolean;
  requiresConfirmation: boolean;
  providerId: string | null;
  source: 'user';
}

let mockRows: ServerRowFixture[] = [];
jest.mock('@snaglet/db', () => ({
  McpServers: { listAll: async () => mockRows },
  Providers: { findById: async () => null },
}));

const logLines: string[] = [];
jest.mock('@server/config/logger', () => {
  const record = (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return { logger: { info: record, debug: record, warn: record, error: record } };
});

import { mcpService } from '@server/services/McpService/McpService';
import { McpInstaller } from '@server/services/McpService/mcpInstaller';

jest.setTimeout(30_000);

const SERVER = 'test-server-a';
const TOOL = `mcp__${SERVER}__whoami`;
const FIXTURE = path.resolve(__dirname, '../../../../../support/fake-mcp-stdio-server.cjs');
const SERVER_ARGS = ['--fixture-arg', `postgres://user:${SECRET}@db.example/test`];

let work: string;
let installRoot: string;
let toolsBin: string;
let nodeOnlyBin: string;
let npmLog: string;
let npxLog: string;
let failFlag: string;
let brokenFlag: string;

interface WhoAmI {
  pid: number;
  ppid: number;
  argv: string[];
  pathHead: string;
  tokenLength: number;
}

/** Writes an executable node script. */
function script(file: string, body: string): void {
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
}

function row(
  pathValue: string,
  args = ['-y', 'test-mcp-fixture@1.0.0', ...SERVER_ARGS]
): ServerRowFixture {
  return {
    id: SERVER,
    name: 'Test Server A',
    transport: 'stdio',
    command: 'npx',
    args,
    url: null,
    headers: {},
    env: { PATH: pathValue, FIXTURE_TOKEN: '${credential}' },
    scope: 'shared',
    enabled: true,
    requiresConfirmation: false,
    providerId: null,
    source: 'user',
  };
}

async function whoami(): Promise<WhoAmI> {
  const result = await mcpService.callTool(TOOL);
  if ('error' in result) throw new Error(`call failed: ${JSON.stringify(result)}`);
  const [first] = result.content as Array<{ text: string }>;
  return JSON.parse(first?.text ?? '{}') as WhoAmI;
}

function lines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function allFileText(dir: string): string {
  if (!existsSync(dir)) return '';
  let out = '';
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    out += statSync(full).isDirectory() ? allFileText(full) : `${readFileSync(full, 'utf8')}\n`;
  }
  return out;
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'snaglet-mcp-process-'));
  toolsBin = path.join(work, 'tools-bin');
  nodeOnlyBin = path.join(work, 'node-only-bin');
  npmLog = path.join(work, 'npm.jsonl');
  npxLog = path.join(work, 'npx.jsonl');
  failFlag = path.join(work, 'npm-fail');
  brokenFlag = path.join(work, 'npm-broken');
  mkdirSync(toolsBin);
  mkdirSync(nodeOnlyBin);
  symlinkSync(process.execPath, path.join(toolsBin, 'node'));
  symlinkSync(process.execPath, path.join(nodeOnlyBin, 'node'));
  script(
    path.join(toolsBin, 'npm'),
    `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify({ args, env: process.env }) + '\\n');
if (fs.existsSync(${JSON.stringify(failFlag)})) {
  process.stderr.write('npm error code E404\\nnpm error 404 Not Found - GET https://registry.example/test-mcp-fixture\\n');
  process.exit(1);
}
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[3];
const at = spec.indexOf('@', 1);
const name = spec.slice(0, at);
const requested = spec.slice(at + 1);
const dir = path.join(prefix, 'node_modules', ...name.split('/'));
fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: requested === 'latest' ? '3.0.0' : requested, bin: { 'test-mcp-fixture': 'bin/server.js' } }));
if (fs.existsSync(${JSON.stringify(brokenFlag)})) {
  fs.writeFileSync(path.join(dir, 'bin', 'server.js'), '#!/usr/bin/env node\\nprocess.exit(3);\\n');
} else {
  fs.copyFileSync(${JSON.stringify(FIXTURE)}, path.join(dir, 'bin', 'server.js'));
}`
  );
  const fakeNpx = `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(npxLog)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
require(${JSON.stringify(FIXTURE)});`;
  script(path.join(toolsBin, 'npx'), fakeNpx);
  script(path.join(nodeOnlyBin, 'npx'), fakeNpx);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

beforeEach(async () => {
  installRoot = mkdtempSync(path.join(work, 'mcp-'));
  rmSync(npmLog, { force: true });
  rmSync(npxLog, { force: true });
  rmSync(failFlag, { force: true });
  rmSync(brokenFlag, { force: true });
  logLines.length = 0;
  mcpService.useInstaller(new McpInstaller({ root: installRoot }));
  mockRows = [row(toolsBin)];
  await mcpService.loadConfig();
});

afterEach(async () => {
  await mcpService.shutdown();
});

describe('install once — real processes', () => {
  it('runs an npx server as one direct node child with its configured args', async () => {
    const report = await whoami();

    expect(report.ppid).toBe(process.pid);
    expect(report.argv).toEqual(SERVER_ARGS);
    expect(report.pathHead).toMatch(/node_modules[\\/]\.bin$/);
    expect(report.tokenLength).toBe(SECRET.length);
    expect(lines(npxLog)).toHaveLength(0);

    const npmCalls = lines(npmLog);
    expect(npmCalls).toHaveLength(1);
    expect((npmCalls[0]!.args as string[]).slice(3)).toEqual([
      'test-mcp-fixture@1.0.0',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
    ]);

    // A second call reuses the same process; nothing is installed again.
    expect((await whoami()).pid).toBe(report.pid);
    expect(lines(npmLog)).toHaveLength(1);
  });

  it('keeps every secret out of npm, the install folder and the logs', async () => {
    await whoami();

    const npmCalls = lines(npmLog);
    expect(JSON.stringify(npmCalls)).not.toContain(SECRET);
    expect((npmCalls[0]!.env as Record<string, string>).FIXTURE_TOKEN).toBeUndefined();
    expect(allFileText(installRoot)).not.toContain(SECRET);
    expect(logLines.join('\n')).not.toContain(SECRET);
  });

  it('Update restarts the running server on a fresh copy', async () => {
    const before = await whoami();

    const result = await mcpService.updateInstall(SERVER);

    expect(result).toEqual({
      ok: true,
      previousVersion: '1.0.0',
      installedVersion: '1.0.0',
      restarted: true,
    });
    expect(await gone(before.pid)).toBe(true);
    const after = await whoami();
    expect(after.pid).not.toBe(before.pid);
    expect(after.ppid).toBe(process.pid);
    expect(lines(npmLog)).toHaveLength(2);
    expect(
      readdirSync(path.join(installRoot, SERVER)).filter((n) => n.startsWith('pkg-'))
    ).toHaveLength(1);
  });

  it('runs the configured npx command exactly as written when the install fails', async () => {
    writeFileSync(failFlag, '');

    const report = await whoami();

    expect(lines(npxLog)).toEqual([{ args: ['-y', 'test-mcp-fixture@1.0.0', ...SERVER_ARGS] }]);
    expect(report.argv).toEqual(['-y', 'test-mcp-fixture@1.0.0', ...SERVER_ARGS]);
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toMatchObject({
      state: 'npx',
      reason:
        'install failed: code E404 — 404 Not Found - GET https://registry.example/test-mcp-fixture',
    });
    expect(logLines.join('\n')).not.toContain(SECRET);
  });

  it('runs the configured npx command when the installed copy installs but will not start', async () => {
    writeFileSync(brokenFlag, '');

    const report = await whoami();

    expect(lines(npmLog)).toHaveLength(1);
    expect(lines(npxLog)).toEqual([{ args: ['-y', 'test-mcp-fixture@1.0.0', ...SERVER_ARGS] }]);
    expect(report.argv).toEqual(['-y', 'test-mcp-fixture@1.0.0', ...SERVER_ARGS]);
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toMatchObject({
      state: 'npx',
      reason: expect.stringMatching(/^the installed copy didn't start: /),
    });
  });

  it('runs the configured npx command exactly as written when npm is missing', async () => {
    mockRows = [row(nodeOnlyBin)];
    await mcpService.reload();

    await whoami();

    expect(lines(npmLog)).toHaveLength(0);
    expect(lines(npxLog)).toEqual([{ args: ['-y', 'test-mcp-fixture@1.0.0', ...SERVER_ARGS] }]);
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toMatchObject({
      state: 'npx',
      reason: "npm wasn't found on PATH",
    });
  });
});
