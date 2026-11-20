/**
 * Custom tool/hook children are spawned with process.execPath, never the bare
 * string 'node'. Bare 'node' resolves against the child's inherited PATH, and
 * the server is often launched where node is not on the sh PATH (e.g. only in
 * /opt/homebrew/bin), giving `spawn node ENOENT`. process.execPath is a real
 * node binary in every deployment shape (dev node/tsx, and the packaged
 * `snaglet-node` sidecar staged by apps/desktop/scripts/stage-sidecar.mjs).
 *
 * Asserts the command argument at both spawn sites
 * (ToolExecutor.executeWorkspaceTool, hookRunner.spawnHookProcess); the
 * external-runner path keeps its author-configured command, pinned below.
 */
import { EventEmitter } from 'events';

const mockSpawn = jest.fn();
// Preserve the real module (execFile etc. are promisify'd at import time deep
// in the db runtime chain — a spawn-only mock breaks those imports); override
// only spawn, which is what both sites under test call.
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// ToolExecutor spawns through cross-spawn so author-configured external runners
// work with Windows .cmd shims. Route it to the same spy so these assertions
// see the executor's chosen command on every platform, not cross-spawn's
// Windows cmd.exe wrapper for an unresolvable command.
jest.mock('cross-spawn', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    size: 0,
    load: jest.fn().mockResolvedValue(undefined),
    getHandler: jest.fn().mockReturnValue(undefined),
    getDefinition: jest.fn().mockReturnValue(undefined),
  },
}));

import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { HookRunner } from '@server/services/customHooks/hookRunner';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';

/** Fake child that immediately succeeds with the given stdout. */
function makeFakeChild(stdout = '{}', code = 0): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdoutStream = new EventEmitter();
  const stderrStream = new EventEmitter();
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.kill = jest.fn();
  queueMicrotask(() => {
    if (stdout) stdoutStream.emit('data', Buffer.from(stdout));
    child.emit('close', code, null);
  });
  return child;
}

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => makeFakeChild());
});

function makeWorkspaceAgentTool(configJson: Record<string, unknown>) {
  return {
    agentId: 'test-agent',
    settings: {},
    requiresConfirmation: false,
    tool: {
      id: 'ws-tool',
      name: 'ws-tool',
      description: 'workspace tool under test',
      type: 'custom',
      enabled: true,
      parameters_schema: {},
      config_json: configJson,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  } as Parameters<typeof toolExecutor.execute>[1];
}

describe('spawn uses process.execPath, not bare "node"', () => {
  it('ToolExecutor.executeWorkspaceTool spawns process.execPath', async () => {
    const result = await toolExecutor.execute(
      { name: 'ws-tool', input: {} },
      makeWorkspaceAgentTool({
        workspace_tool: true,
        built_path: '/tmp/fake-tool/dist/tool.cjs',
      })
    );

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(command).not.toBe('node');
    expect(args).toEqual(['/tmp/fake-tool/dist/tool.cjs']);
  });

  it('HookRunner spawns process.execPath', async () => {
    const runner = new HookRunner({ serverUrl: 'http://127.0.0.1:4001', timeoutMs: 5000 });

    await runner.run({
      hookName: 'test-hook',
      builtPath: '/tmp/fake-hook/dist/hook.cjs',
      hookDir: '/tmp/fake-hook',
      eventName: 'message:create',
      event: {},
      context: {},
    });
    await runner.settle();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(command).not.toBe('node');
    expect(args[0]).toBe('/tmp/fake-hook/dist/hook.cjs');
  });

  it('external-runner tools keep their author-configured command', async () => {
    const result = await toolExecutor.execute(
      { name: 'ext-tool', input: {} },
      makeWorkspaceAgentTool({
        external_runner: { command: '/usr/bin/python3', args: ['runner.py'] },
      })
    );

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('/usr/bin/python3');
  });
});

describe('workspace tool child token', () => {
  async function spawnedToken(context?: Parameters<typeof toolExecutor.execute>[2]) {
    const { verifyChildDispatchToken } = await import('@server/middleware/panelAuth');
    const result = await toolExecutor.execute(
      { name: 'ws-tool', input: {} },
      makeWorkspaceAgentTool({
        workspace_tool: true,
        built_path: '/tmp/fake-tool/dist/tool.cjs',
      }),
      context
    );
    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    return verifyChildDispatchToken(options.env.SNAGLET_CHILD_DISPATCH_TOKEN ?? '');
  }

  // A person ran the tool (panel Run, `snaglet run` with no agent): its nested
  // calls act as the ghost system actor, gated by ghost's allow list, as
  // agentless hooks do. /execute refuses a token bound to no agent, so an
  // unbound one would make every nested call (snaglet.tables.read included) fail.
  it.each([
    ['no context', undefined],
    ['a context with no agent', {}],
    ['an empty agent id', { agentId: '' }],
  ])('binds to ghost when a person runs the tool (%s)', async (_label, context) => {
    expect(await spawnedToken(context)).toEqual({ agentId: GHOST_AGENT_ID });
  });

  it('binds to the invoking agent when an agent runs the tool', async () => {
    expect(await spawnedToken({ agentId: 'test-agent' })).toEqual({ agentId: 'test-agent' });
  });

  it('carries the ambient chain depth and hook chain, signed', async () => {
    const { runAtChainDepth } = await import('@server/realtime/runContext');
    const { verifyChildDispatchToken } = await import('@server/middleware/panelAuth');
    await runAtChainDepth(
      2,
      () =>
        toolExecutor.execute(
          { name: 'ws-tool', input: {} },
          makeWorkspaceAgentTool({
            workspace_tool: true,
            built_path: '/tmp/fake-tool/dist/tool.cjs',
          }),
          { agentId: 'test-agent' }
        ),
      undefined,
      ['test-hook-a', 'test-hook-b']
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(verifyChildDispatchToken(options.env.SNAGLET_CHILD_DISPATCH_TOKEN ?? '')).toEqual({
      agentId: 'test-agent',
      chainDepth: 2,
      hookChain: ['test-hook-a', 'test-hook-b'],
    });
  });
});
