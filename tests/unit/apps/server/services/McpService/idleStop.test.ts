/**
 * McpService idle stop and start rules: every connection — shared or
 * per-agent — stops after IDLE_REAP_MS without a tool call (never while a
 * call runs), keeps its cached tools, shows 'idle', and restarts on the next
 * call; concurrent callers share one start; and nothing but an agent turn or
 * a tool call ever starts a server (boot, sync, re-enable, listings,
 * backoff, disabled or unused servers spawn nothing).
 *
 * The SDK Client and transport are fakes; time is Jest's fake clock.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface FakeTransport {
  onclose?: () => void;
  onerror?: (err: Error) => void;
  close: () => Promise<void>;
}

interface CallResult {
  content: unknown[];
  isError?: boolean;
}

class FakeClient {
  transport: FakeTransport | null = null;
  listToolsImpl: () => Promise<{ tools: Array<{ name: string }> }> = async () => ({
    tools: [{ name: 'do_thing' }, { name: 'other_thing' }],
  });
  callToolImpl: () => Promise<CallResult> = async () => ({ content: [{ type: 'text' }] });
  readonly close = jest.fn(async () => {
    const transport = this.transport;
    this.transport = null;
    transport?.onclose?.();
  });
  async connect(transport: FakeTransport): Promise<void> {
    this.transport = transport;
  }
  listTools() {
    return this.listToolsImpl();
  }
  callTool() {
    return this.callToolImpl();
  }
}

const mockClients: FakeClient[] = [];
let mockConfigureClient: (client: FakeClient) => void = () => undefined;

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => {
    const client = new FakeClient();
    mockConfigureClient(client);
    mockClients.push(client);
    return client;
  }),
}));

jest.mock('@server/services/McpService/mcpTransport', () => ({
  buildTransport: () => ({ close: async () => undefined }),
  loginPathReady: async () => undefined,
  describeConnectError: (_config: unknown, err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

const resolveEnv = jest.fn<() => Promise<Record<string, string> | null>>();
jest.mock('@server/services/McpService/mcpCredentials', () => ({
  resolveEnv: () => resolveEnv(),
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
let mockProvider: { type: string; enabled: boolean } | null = null;
jest.mock('@snaglet/db', () => ({
  McpServers: { listAll: async () => mockRows },
  Providers: { findById: async () => mockProvider },
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { mcpService } from '@server/services/McpService/McpService';
import { McpInstaller } from '@server/services/McpService/mcpInstaller';
import { IDLE_REAP_MS, REAP_INTERVAL_MS } from '@server/services/McpService/mcpTypes';

const SERVER = 'test-server-a';
const TOOL = `mcp__${SERVER}__do_thing`;

function row(overrides: Partial<ServerRowFixture> = {}): ServerRowFixture {
  return {
    id: SERVER,
    name: 'Test Server A',
    transport: 'stdio',
    command: 'test-mcp-server',
    args: [],
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

/** Let promise chains (and the async close a reap starts) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Move the fake clock and run the reaper's interval ticks. */
async function idleFor(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await settle();
}

const toolIds = (ids = [SERVER]) =>
  mcpService.getToolDefsForServers(ids).map((def) => def.namespacedId);

let installRoot: string;

beforeEach(async () => {
  jest.useFakeTimers();
  installRoot = mkdtempSync(path.join(tmpdir(), 'snaglet-mcp-idle-'));
  mcpService.useInstaller(new McpInstaller({ root: installRoot }));
  mockRows = [row()];
  mockProvider = null;
  mockConfigureClient = () => undefined;
  resolveEnv.mockReset();
  resolveEnv.mockResolvedValue({});
  await mcpService.loadConfig();
  mockClients.length = 0;
});

afterEach(async () => {
  await mcpService.shutdown();
  jest.useRealTimers();
  rmSync(installRoot, { recursive: true, force: true });
});

describe('idle stop — shared servers', () => {
  it('stops after 10 minutes without a call, keeps its tools, and restarts on the next call', async () => {
    await mcpService.connect(SERVER);
    const before = toolIds();
    expect(before).toEqual([TOOL, `mcp__${SERVER}__other_thing`]);

    await idleFor(IDLE_REAP_MS + REAP_INTERVAL_MS);

    expect(mockClients[0]!.close).toHaveBeenCalledTimes(1);
    expect(mcpService.getStatus(SERVER)).toBe('idle');
    expect(toolIds()).toEqual(before);
    expect(mcpService.getCatalogToolDefs().map((def) => def.namespacedId)).toEqual(before);
    expect(mcpService.getToolDef(TOOL)).not.toBeNull();

    const result = await mcpService.callTool(TOOL);

    expect(result).toEqual({ content: [{ type: 'text' }], isError: false });
    expect(mockClients).toHaveLength(2);
    expect(mcpService.getStatus(SERVER)).toBe('connected');
    expect(toolIds()).toEqual(before);
  });

  it('keeps running while it is used', async () => {
    await mcpService.connect(SERVER);
    for (let i = 0; i < 3; i++) {
      await idleFor(IDLE_REAP_MS - REAP_INTERVAL_MS);
      await mcpService.callTool(TOOL);
    }
    expect(mockClients[0]!.close).not.toHaveBeenCalled();
    expect(mcpService.getStatus(SERVER)).toBe('connected');
  });

  it('never stops a server while a call is running on it', async () => {
    await mcpService.connect(SERVER);
    let finish: (result: CallResult) => void = () => undefined;
    mockClients[0]!.callToolImpl = () =>
      new Promise<CallResult>((resolve) => {
        finish = resolve;
      });

    const call = mcpService.callTool(TOOL);
    await idleFor(IDLE_REAP_MS * 2);
    expect(mockClients[0]!.close).not.toHaveBeenCalled();

    finish({ content: [{ type: 'text', text: 'slow' }] });
    await expect(call).resolves.toEqual({
      content: [{ type: 'text', text: 'slow' }],
      isError: false,
    });

    // The idle clock restarts when the call ends.
    await idleFor(IDLE_REAP_MS - REAP_INTERVAL_MS);
    expect(mockClients[0]!.close).not.toHaveBeenCalled();
    await idleFor(2 * REAP_INTERVAL_MS);
    expect(mockClients[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('a background warm-up nobody uses stops too', async () => {
    mcpService.ensureServersConnected([SERVER], { agentId: 'test-agent-a' });
    await settle();
    expect(mcpService.getStatus(SERVER)).toBe('connected');

    await idleFor(IDLE_REAP_MS + REAP_INTERVAL_MS);

    expect(mcpService.getStatus(SERVER)).toBe('idle');
  });

  it('shows idle apart from a failed start, with the failure reason', async () => {
    await mcpService.connect(SERVER);
    await idleFor(IDLE_REAP_MS + REAP_INTERVAL_MS);
    expect(mcpService.getStatus(SERVER)).toBe('idle');
    expect(mcpService.getStatusDetail(SERVER)).toBeNull();

    mockConfigureClient = (client) => {
      client.listToolsImpl = async () => {
        throw new Error('server crashed on start');
      };
    };
    await mcpService.callTool(TOOL);

    expect(mcpService.getStatus(SERVER)).toBe('disconnected');
    expect(mcpService.getStatusDetail(SERVER)).toBe('server crashed on start');
  });
});

describe('idle stop — per-agent servers', () => {
  it('stops each agent connection on its own and restarts it on that agent’s next call', async () => {
    mockRows = [row({ scope: 'per-agent' })];
    await mcpService.loadConfig();
    await mcpService.connect(SERVER, { agentId: 'test-agent-a' });
    await idleFor(IDLE_REAP_MS / 2);
    await mcpService.connect(SERVER, { agentId: 'test-agent-b' });

    await idleFor(IDLE_REAP_MS / 2 + REAP_INTERVAL_MS);
    expect(mockClients[0]!.close).toHaveBeenCalledTimes(1);
    expect(mockClients[1]!.close).not.toHaveBeenCalled();
    expect(mcpService.getStatus(SERVER)).toBe('connected');

    await idleFor(IDLE_REAP_MS / 2);
    expect(mcpService.getStatus(SERVER)).toBe('idle');
    expect(toolIds()).toContain(TOOL);

    await expect(mcpService.callTool(TOOL, {}, { agentId: 'test-agent-a' })).resolves.toMatchObject(
      {
        isError: false,
      }
    );
    expect(mockClients).toHaveLength(3);
  });
});

describe('single-flight starts', () => {
  it('N concurrent calls to a stopped server start it once and all succeed', async () => {
    await mcpService.connect(SERVER);
    await idleFor(IDLE_REAP_MS + REAP_INTERVAL_MS);
    mockClients.length = 0;

    const results = await Promise.all(Array.from({ length: 5 }, () => mcpService.callTool(TOOL)));

    expect(mockClients).toHaveLength(1);
    for (const result of results)
      expect(result).toEqual({ content: [{ type: 'text' }], isError: false });
  });

  it('a call that arrives while the server is starting waits for that start', async () => {
    let release: () => void = () => undefined;
    mockConfigureClient = (client) => {
      client.listToolsImpl = () =>
        new Promise((resolve) => {
          release = () => resolve({ tools: [{ name: 'do_thing' }] });
        });
    };
    mcpService.ensureServersConnected([SERVER]);
    await settle();
    expect(mcpService.getStatus(SERVER)).toBe('connecting');

    const call = mcpService.callTool(TOOL);
    await settle();
    release();

    await expect(call).resolves.toEqual({ content: [{ type: 'text' }], isError: false });
    expect(mockClients).toHaveLength(1);
  });

  it('a call that arrives while the reaper is closing the server starts one new process', async () => {
    await mcpService.connect(SERVER);
    let finishClose: () => void = () => undefined;
    mockClients[0]!.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        })
    );
    jest.advanceTimersByTime(IDLE_REAP_MS + REAP_INTERVAL_MS);

    const calls = await Promise.all([mcpService.callTool(TOOL), mcpService.callTool(TOOL)]);
    finishClose();

    expect(mockClients).toHaveLength(2);
    for (const result of calls) expect(result).toMatchObject({ isError: false });
  });
});

describe('nothing starts a server but a turn or a call', () => {
  it('boot, reload and sync start nothing', async () => {
    await mcpService.reload();
    await mcpService.syncFromProvider(SERVER);
    await settle();
    expect(mockClients).toHaveLength(0);
    expect(resolveEnv).not.toHaveBeenCalled();
  });

  it('listing tools never starts a server, warm or cold', async () => {
    expect(mcpService.getToolDefsForServers([SERVER])).toEqual([]);
    expect(mcpService.getCatalogToolDefs()).toEqual([]);
    expect(mcpService.listServerTools(SERVER)).toEqual([]);
    await settle();
    expect(mockClients).toHaveLength(0);

    await mcpService.connect(SERVER);
    await idleFor(IDLE_REAP_MS + REAP_INTERVAL_MS);
    // A turn of an agent that has the server sees its cached tools and does not restart it.
    mcpService.ensureServersConnected([SERVER], { agentId: 'test-agent-a' });
    mcpService.getToolDefsForServers([SERVER]);
    await settle();
    expect(mockClients).toHaveLength(1);
    expect(mcpService.getStatus(SERVER)).toBe('idle');
  });

  it('a disabled server never starts, not even for a call', async () => {
    mockRows = [row({ enabled: false })];
    await mcpService.loadConfig();

    mcpService.ensureServersConnected([SERVER]);
    await mcpService.callTool(TOOL);
    await mcpService.syncFromProvider(SERVER);
    await settle();

    expect(mockClients).toHaveLength(0);
  });

  it('re-enabling a server starts nothing until an agent needs it', async () => {
    mockRows = [row({ enabled: false })];
    await mcpService.loadConfig();
    mockRows = [row({ enabled: true })];
    await mcpService.syncFromProvider(SERVER);
    await settle();
    expect(mockClients).toHaveLength(0);
  });

  it('a server whose integration provider is off never spawns', async () => {
    mockRows = [row({ providerId: 'test-provider' })];
    mockProvider = { type: 'integration', enabled: false };
    await mcpService.loadConfig();

    mcpService.ensureServersConnected([SERVER]);
    await settle();
    await mcpService.callTool(TOOL);

    expect(mockClients).toHaveLength(0);
    expect(mcpService.getStatusDetail(SERVER)).toBe('integration provider disabled');
  });

  it('a failed start is not retried in the background — no timer re-spawns it', async () => {
    mockConfigureClient = (client) => {
      client.listToolsImpl = async () => {
        throw new Error('spawn test-mcp-server ENOENT');
      };
    };
    mcpService.ensureServersConnected([SERVER]);
    await settle();
    expect(mockClients).toHaveLength(1);

    // Hours pass with no agent turn and no call: nothing retries.
    await idleFor(6 * 60 * 60 * 1000);
    expect(mockClients).toHaveLength(1);
  });

  it('a server no agent has enabled is never started', async () => {
    mockRows = [row(), row({ id: 'test-server-unused' })];
    await mcpService.loadConfig();

    // A turn of an agent that has only test-server-a.
    mcpService.ensureServersConnected([SERVER]);
    await settle();
    await idleFor(IDLE_REAP_MS * 3);

    expect(mockClients).toHaveLength(1);
    expect(mcpService.getStatus('test-server-unused')).toBe('unknown');
  });
});
