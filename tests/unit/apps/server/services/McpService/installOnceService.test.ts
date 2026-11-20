/**
 * McpService + install-once: an `npx <pkg>` server starts from Snaglet's
 * installed copy with node; a failed install falls back to the configured
 * command exactly as written; the pane's Update reinstalls and restarts a
 * running server (and only a running one); a server created at runtime is
 * installed in the background without being started; a deleted server's
 * folder goes only when no server with that id exists; and an installed copy
 * that fails to start while npx works is set aside, never left failing.
 *
 * The SDK Client and transport factory are fakes (the factory records the
 * launch it was handed); the installer is real, on a temp root, with a fake
 * npm that writes a fixture package — nothing reaches a registry.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface FakeTransport {
  onclose?: () => void;
  onerror?: (err: Error) => void;
  close: () => Promise<void>;
  direct: boolean;
}

/** Which launches fail to start: the installed copy, the configured command, or both. */
let mockFailing: { direct: boolean; configured: boolean } = { direct: false, configured: false };

class FakeClient {
  transport: FakeTransport | null = null;
  readonly close = jest.fn(async () => {
    const transport = this.transport;
    this.transport = null;
    transport?.onclose?.();
  });
  async connect(transport: FakeTransport): Promise<void> {
    this.transport = transport;
    if (transport.direct ? mockFailing.direct : mockFailing.configured) {
      throw new Error(transport.direct ? 'Cannot find module ./lib/missing.js' : 'npx crashed');
    }
  }
  async listTools() {
    return { tools: [{ name: 'do_thing' }] };
  }
  async callTool() {
    return { content: [{ type: 'text', text: 'ok' }] };
  }
}

interface Launch {
  command: string;
  args: string[];
  binDir: string;
  version?: string;
}

const mockClients: FakeClient[] = [];
const mockLaunches: Array<{ command: string | null; args: string[]; direct: Launch | null }> = [];

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => {
    const client = new FakeClient();
    mockClients.push(client);
    return client;
  }),
}));

jest.mock('@server/services/McpService/mcpTransport', () => ({
  buildTransport: (
    config: { command: string | null; args: string[] },
    _env: unknown,
    _headers: unknown,
    direct?: Launch | null
  ) => {
    mockLaunches.push({ command: config.command, args: [...config.args], direct: direct ?? null });
    return { close: async () => undefined, direct: Boolean(direct) };
  },
  loginPathReady: async () => undefined,
  describeConnectError: (_config: unknown, err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

jest.mock('@server/services/ToolService/lib/loginShellPath', () => ({
  shellPath: () => '/test/login/bin:/usr/bin:/bin',
}));

jest.mock('@server/services/McpService/mcpCredentials', () => ({
  resolveEnv: async () => ({}),
  resolveHeaders: async () => ({}),
  configRequiresCredential: () => false,
  configCredentialSpec: () => ({ requiresSecret: false, bundleFields: [] }),
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
  scope: 'shared' | 'per-agent';
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

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { mcpService } from '@server/services/McpService/McpService';
import { McpInstaller } from '@server/services/McpService/mcpInstaller';

type InstallerOptions = NonNullable<ConstructorParameters<typeof McpInstaller>[0]>;
type NpmRunner = NonNullable<InstallerOptions['runNpm']>;

const SERVER = 'test-server-a';
const TOOL = `mcp__${SERVER}__do_thing`;

let root: string;
let npmCalls: string[][];
let latest: string;
let npmFails: boolean;

const fakeNpm: NpmRunner = async (_command, args) => {
  npmCalls.push(args);
  if (npmFails) return { ok: false, notFound: false, message: 'E500 registry unavailable' };
  const prefix = args[2] ?? '';
  const spec = args[3] ?? '';
  const at = spec.indexOf('@', 1);
  const name = spec.slice(0, at);
  const requested = spec.slice(at + 1);
  const dir = path.join(prefix, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: requested === 'latest' ? latest : requested, bin: 'server.js' })
  );
  writeFileSync(path.join(dir, 'server.js'), '#!/usr/bin/env node\n');
  return { ok: true };
};

function row(overrides: Partial<ServerRowFixture> = {}): ServerRowFixture {
  return {
    id: SERVER,
    name: 'Test Server A',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'test-mcp-pkg', '--flag'],
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

let ensureSpy: jest.SpiedFunction<McpInstaller['ensureInstalled']>;

/** Wait for every background install loadConfig started so far. */
async function backgroundInstalls(): Promise<void> {
  await Promise.all(ensureSpy.mock.results.map((result) => result.value));
}

function copies(): string[] {
  const dir = path.join(root, SERVER);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('pkg-')) : [];
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'snaglet-mcp-service-install-'));
  npmCalls = [];
  latest = '2.0.0';
  npmFails = false;
  mockFailing = { direct: false, configured: false };
  const installer = new McpInstaller({ root, runNpm: fakeNpm, platform: 'darwin' });
  ensureSpy = jest.spyOn(installer, 'ensureInstalled');
  mcpService.useInstaller(installer);
  mockRows = [row()];
  await mcpService.loadConfig();
  mockClients.length = 0;
  mockLaunches.length = 0;
});

afterEach(async () => {
  await mcpService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('McpService — install once', () => {
  it('starts an npx server from its installed copy with node', async () => {
    await mcpService.connect(SERVER);

    expect(npmCalls).toHaveLength(1);
    expect(mockLaunches).toHaveLength(1);
    const { direct } = mockLaunches[0]!;
    expect(direct).toMatchObject({ command: 'node', version: '2.0.0' });
    expect(direct!.args.slice(-1)).toEqual(['--flag']);
    expect(direct!.args[0]).toMatch(/node_modules\/test-mcp-pkg\/server\.js$/);
    expect(mcpService.getStatus(SERVER)).toBe('connected');
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toMatchObject({
      state: 'installed',
      installedVersion: '2.0.0',
    });
  });

  it('falls back to the configured command, exactly as written, when the install fails', async () => {
    npmFails = true;
    mockRows = [row({ args: ['-y', 'test-mcp-pkg@1.2.3', '--flag'] })];
    await mcpService.loadConfig();
    await backgroundInstalls();

    await mcpService.connect(SERVER);

    expect(mockLaunches).toHaveLength(1);
    expect(mockLaunches[0]).toEqual({
      command: 'npx',
      args: ['-y', 'test-mcp-pkg@1.2.3', '--flag'],
      direct: null,
    });
    expect(mcpService.getStatus(SERVER)).toBe('connected');
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toMatchObject({
      state: 'npx',
      reason: 'install failed: E500 registry unavailable',
    });
  });

  it('runs non-npx servers as configured and never calls npm for them', async () => {
    mockRows = [row({ command: 'uvx', args: ['test-mcp-tool'] })];
    await mcpService.loadConfig();
    await backgroundInstalls();

    await mcpService.connect(SERVER);

    expect(npmCalls).toHaveLength(0);
    expect(mockLaunches[0]).toEqual({ command: 'uvx', args: ['test-mcp-tool'], direct: null });
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toBeNull();
  });
});

describe('McpService — an installed copy that does not start', () => {
  it('starts the configured npx command instead, and keeps using npx until a new install', async () => {
    mockFailing = { direct: true, configured: false };

    await mcpService.connect(SERVER);

    expect(mockLaunches.map((launch) => launch.direct !== null)).toEqual([true, false]);
    expect(mockLaunches[1]).toEqual({
      command: 'npx',
      args: ['-y', 'test-mcp-pkg', '--flag'],
      direct: null,
    });
    expect(mockClients[0]!.close).toHaveBeenCalledTimes(1);
    expect(mcpService.getStatus(SERVER)).toBe('connected');
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toMatchObject({
      state: 'npx',
      reason: "the installed copy didn't start: Cannot find module ./lib/missing.js",
      updatable: true,
    });

    // The next start goes straight to npx.
    await mcpService.disconnect(SERVER);
    mockLaunches.length = 0;
    await mcpService.connect(SERVER);
    expect(mockLaunches.map((launch) => launch.direct)).toEqual([null]);

    // Update installs a fresh copy and starts from it again.
    mockFailing = { direct: false, configured: false };
    await expect(mcpService.updateInstall(SERVER)).resolves.toMatchObject({
      ok: true,
      restarted: true,
    });
    expect(mockLaunches.at(-1)!.direct).not.toBeNull();
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toMatchObject({ state: 'installed' });
  });

  it('does not blame the install when npx fails too', async () => {
    mockFailing = { direct: true, configured: true };

    await mcpService.connect(SERVER);

    expect(mcpService.getStatus(SERVER)).toBe('disconnected');
    expect(mcpService.getStatusDetail(SERVER)).toBe('npx crashed');
    expect(mockClients.every((client) => client.close.mock.calls.length === 1)).toBe(true);
    await expect(mcpService.getInstallInfo(SERVER)).resolves.toMatchObject({ state: 'installed' });
  });
});

describe('McpService — Update', () => {
  it('reinstalls the latest and restarts a running server on the new copy', async () => {
    await mcpService.connect(SERVER);
    const [firstCopy] = copies();
    const first = mockClients[0]!;
    latest = '2.1.0';

    const result = await mcpService.updateInstall(SERVER);

    expect(result).toEqual({
      ok: true,
      previousVersion: '2.0.0',
      installedVersion: '2.1.0',
      restarted: true,
    });
    expect(npmCalls.map((args) => args[3])).toEqual(['test-mcp-pkg@latest', 'test-mcp-pkg@latest']);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(mockClients).toHaveLength(2);
    expect(mockLaunches[1]!.direct).toMatchObject({ version: '2.1.0' });
    expect(mcpService.getStatus(SERVER)).toBe('connected');
    expect(copies()).toHaveLength(1);
    expect(copies()).not.toContain(firstCopy);
  });

  it('reinstalls a pinned version as pinned', async () => {
    mockRows = [row({ args: ['-y', 'test-mcp-pkg@1.2.3'] })];
    await mcpService.loadConfig();
    await backgroundInstalls();
    npmCalls.length = 0;

    const result = await mcpService.updateInstall(SERVER);

    expect(npmCalls.map((args) => args[3])).toEqual(['test-mcp-pkg@1.2.3']);
    expect(result).toMatchObject({ ok: true, installedVersion: '1.2.3', restarted: false });
  });

  it('leaves a stopped server stopped', async () => {
    const result = await mcpService.updateInstall(SERVER);

    expect(result).toMatchObject({ ok: true, installedVersion: '2.0.0', restarted: false });
    expect(mockClients).toHaveLength(0);
    expect(mcpService.getStatus(SERVER)).toBe('unknown');
  });

  it('keeps the old copy and the running server when the install fails', async () => {
    await mcpService.connect(SERVER);
    const before = copies();
    npmFails = true;

    const result = await mcpService.updateInstall(SERVER);

    expect(result).toEqual({
      ok: false,
      previousVersion: '2.0.0',
      installedVersion: '2.0.0',
      restarted: false,
      error: 'install failed: E500 registry unavailable',
    });
    expect(mockClients[0]!.close).not.toHaveBeenCalled();
    expect(mcpService.getStatus(SERVER)).toBe('connected');
    expect(copies()).toEqual(before);
    await expect(mcpService.callTool(TOOL)).resolves.toMatchObject({ isError: false });
  });

  it('refuses a server that has no npx package', async () => {
    mockRows = [row({ command: 'uvx', args: ['test-mcp-tool'] })];
    await mcpService.loadConfig();

    await expect(mcpService.updateInstall(SERVER)).resolves.toMatchObject({
      ok: false,
      error: "Nothing to update: this server isn't started with npx.",
    });
    expect(npmCalls).toHaveLength(0);
  });
});

describe('McpService — when installs happen', () => {
  it('installs nothing at boot, and installs a server created at runtime without starting it', async () => {
    // beforeEach's first load was the boot load: nothing installed.
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(npmCalls).toHaveLength(0);

    mockRows = [row(), row({ id: 'test-server-b', args: ['-y', 'test-mcp-other@1.0.0'] })];
    await mcpService.loadConfig();
    await backgroundInstalls();

    expect(npmCalls.map((args) => args[3])).toEqual(['test-mcp-other@1.0.0']);
    expect(mockClients).toHaveLength(0);
    expect(mcpService.getStatus('test-server-b')).toBe('unknown');
  });

  it('does not install a server created disabled', async () => {
    mockRows = [row(), row({ id: 'test-server-b', enabled: false })];
    await mcpService.loadConfig();
    await backgroundInstalls();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(npmCalls).toHaveLength(0);
  });

  it('removes a deleted server folder only while no server has that id', async () => {
    await mcpService.connect(SERVER);
    expect(existsSync(path.join(root, SERVER))).toBe(true);

    await mcpService.removeInstall(SERVER);
    expect(existsSync(path.join(root, SERVER))).toBe(true);

    await mcpService.disconnect(SERVER);
    mockRows = [];
    await mcpService.removeInstall(SERVER);
    expect(existsSync(path.join(root, SERVER))).toBe(false);
  });

  it('restores onto the kept folder without reinstalling', async () => {
    await mcpService.connect(SERVER);
    await mcpService.disconnect(SERVER);
    mockRows = [];
    await mcpService.reload();
    npmCalls.length = 0;

    // Restore within the undo window: the row comes back, the folder is still there.
    mockRows = [row()];
    await mcpService.syncFromProvider(SERVER);
    await backgroundInstalls();
    await mcpService.connect(SERVER);

    expect(npmCalls).toHaveLength(0);
    expect(mockLaunches.at(-1)!.direct).toMatchObject({ version: '2.0.0' });
  });
});
