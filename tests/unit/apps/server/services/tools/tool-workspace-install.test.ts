/**
 * ToolWorkspaceService.install — failure diagnostics. On a failed install,
 * `BuildResult.output` carries the full pnpm stdout+stderr, distinct from the
 * one-line `error` summary, so a client reading `output` sees the real
 * failure; and a non-zero pnpm exit is warn-logged with the tool id and output,
 * so a failure not reproducible from the UI still leaves a trail.
 * `child_process.spawn` is mocked with a fake child, so no real pnpm runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import type { SpawnOptions } from 'child_process';

const mockSpawn = jest.fn();
jest.mock('cross-spawn', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSpawn(...args),
}));

// The real login-shell lookup would run the developer's own shell; the
// lookup itself is covered by tool-workspace-login-path.test.ts.
jest.mock('@server/services/ToolService/lib/loginShellPath', () => ({
  ...jest.requireActual<typeof import('@server/services/ToolService/lib/loginShellPath')>(
    '@server/services/ToolService/lib/loginShellPath'
  ),
  resolveLoginShellPath: () => Promise.resolve(),
}));

const loggerWarnMock = jest.fn();
const loggerInfoMock = jest.fn();
jest.mock('@server/config/logger', () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfoMock(...args),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function envValue(env: NodeJS.ProcessEnv | undefined, key: string): string | undefined {
  const found = Object.keys(env ?? {}).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase()
  );
  return found ? env?.[found] : undefined;
}

function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdoutStream = new EventEmitter();
  const stderrStream = new EventEmitter();
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.kill = jest.fn();
  queueMicrotask(() => {
    if (opts.stdout) stdoutStream.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) stderrStream.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code ?? 0);
  });
  return child;
}

let workspacesDir: string;
let service: typeof import('@server/services/ToolService/ToolWorkspaceService').toolWorkspaceService;

beforeAll(async () => {
  workspacesDir = await mkdtemp(path.join(tmpdir(), 'snaglet-tool-ws-install-'));
  process.env.TOOL_WORKSPACES_DIR = workspacesDir;
  ({ toolWorkspaceService: service } =
    await import('@server/services/ToolService/ToolWorkspaceService'));
  await mkdir(path.join(workspacesDir, 'my-tool'), { recursive: true });
});

afterAll(async () => {
  delete process.env.TOOL_WORKSPACES_DIR;
  await rm(workspacesDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockSpawn.mockReset();
  loggerWarnMock.mockReset();
  loggerInfoMock.mockReset();
});

describe('ToolWorkspaceService.install', () => {
  it("runs pnpm without the server's secrets: install scripts and .pnpmfile.cjs are agent-writable", async () => {
    const secrets: Record<string, string> = {
      SNAGLET_AUTH_TOKEN: 'test-auth-token-aaaaaaaa',
      SNAGLET_PANEL_TOKEN: 'test-panel-token-aaaaaaaa',
      CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key-aaaaaaaa',
      ANTHROPIC_API_KEY: 'test-provider-key-aaaaaaaa',
      npm_config__authToken: 'test-registry-token-aaaaaaaa',
    };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(secrets)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    mockSpawn.mockImplementation(() => makeFakeChild({ code: 0 }));

    try {
      await service.install('my-tool');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], SpawnOptions];
    for (const key of Object.keys(secrets)) expect(envValue(options.env, key)).toBeUndefined();
    expect(envValue(options.env, 'HOME')).toBe(envValue(process.env, 'HOME'));
  });

  it('removes inherited Node loader injection at the spawn boundary while preserving PATH', async () => {
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const originalNpmNodeOptions = process.env.npm_config_node_options;
    const originalUpperNpmNodeOptions = process.env.NPM_CONFIG_NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--import=tsx --trace-warnings';
    process.env.npm_config_node_options = '--loader tsx';
    process.env.NPM_CONFIG_NODE_OPTIONS = '--import tsx';
    mockSpawn.mockImplementation(() => makeFakeChild({ code: 0 }));

    try {
      await service.install('my-tool');
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
      if (originalNpmNodeOptions === undefined) delete process.env.npm_config_node_options;
      else process.env.npm_config_node_options = originalNpmNodeOptions;
      if (originalUpperNpmNodeOptions === undefined) delete process.env.NPM_CONFIG_NODE_OPTIONS;
      else process.env.NPM_CONFIG_NODE_OPTIONS = originalUpperNpmNodeOptions;
    }

    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(command).toBe('pnpm');
    expect(args).toEqual(['install', '--no-frozen-lockfile']);
    expect(envValue(options.env, 'PATH')).toBe(envValue(process.env, 'PATH'));
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(options.env).not.toHaveProperty('npm_config_node_options');
    expect(options.env).not.toHaveProperty('NPM_CONFIG_NODE_OPTIONS');
  });

  it('returns success: true with the combined stdout+stderr in `output` on a clean exit', async () => {
    mockSpawn.mockImplementation(() => makeFakeChild({ stdout: 'added 1 package', code: 0 }));

    const result = await service.install('my-tool');

    expect(result.success).toBe(true);
    expect(result.output).toContain('added 1 package');
    expect(result.error).toBeUndefined();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('surfaces the real pnpm failure text in `output` (distinct from the one-line `error`) and warn-logs it on a non-zero exit', async () => {
    const pnpmFailureText =
      'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/left-pad-9000 - Not Found - 404';
    mockSpawn.mockImplementation(() => makeFakeChild({ stderr: pnpmFailureText, code: 1 }));

    const result = await service.install('my-tool');

    expect(result.success).toBe(false);
    // The one-line summary alone would hide the real pnpm text; `output`
    // carries the failure text end to end.
    expect(result.error).toBe('pnpm install exited with code 1');
    expect(result.output).toContain(pnpmFailureText);

    // Server-side: a failing install is warn-logged with the tool id and
    // the real output, so a report that can't be reproduced from the UI
    // still has the actual pnpm error text in the server logs.
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    const [warnMessage] = loggerWarnMock.mock.calls[0] as [string];
    expect(warnMessage).toContain('my-tool');
    expect(warnMessage).toContain(pnpmFailureText);
  });

  function failSpawnWith(err: Error): void {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      queueMicrotask(() => child.emit('error', err));
      return child;
    });
  }

  it('says in plain words that pnpm is missing, keeping the raw spawn error in `output`', async () => {
    const spawnFailure = 'spawn pnpm ENOENT';
    failSpawnWith(
      Object.assign(new Error(spawnFailure), { code: 'ENOENT', syscall: 'spawn pnpm' })
    );

    const result = await service.install('my-tool');

    expect(result).toMatchObject({
      success: false,
      error:
        "Snaglet could not find pnpm. Install it, or add its folder to your shell's PATH, then restart Snaglet.",
      output: spawnFailure,
    });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock.mock.calls[0]?.[0]).toContain(spawnFailure);
  });

  it('returns and warn-logs any other caught spawn failure as is', async () => {
    const spawnFailure = 'spawn pnpm EACCES';
    failSpawnWith(
      Object.assign(new Error(spawnFailure), { code: 'EACCES', syscall: 'spawn pnpm' })
    );

    const result = await service.install('my-tool');

    expect(result).toMatchObject({ success: false, error: spawnFailure, output: spawnFailure });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock.mock.calls[0]?.[0]).toContain(spawnFailure);
  });
});
