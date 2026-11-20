/**
 * McpService connection lifecycle: a failed or timed-out connect/call closes
 * its client (so a stdio server's child process cannot leak), the SDK's own
 * transport onclose keeps running, a late close from a replaced transport never
 * evicts a newer connection, and a server skipped for a config reason is not
 * re-checked (or re-logged) on every catalog read until its config changes.
 *
 * The SDK Client and transport are fakes: the fake Client installs a chained
 * onclose on connect the way the real Protocol does, and its close() fires the
 * transport's onclose the way a stdio transport does when its process exits.
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

interface ToolsResult {
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

interface CallResult {
  content: unknown[];
  isError?: boolean;
}

class FakeClient {
  transport: FakeTransport | null = null;
  readonly sdkOnClose = jest.fn();
  listToolsImpl: () => Promise<ToolsResult> = async () => ({ tools: [{ name: 'do_thing' }] });
  callToolImpl: () => Promise<CallResult> = async () => ({ content: [{ type: 'text' }] });
  readonly close = jest.fn(async () => {
    const transport = this.transport;
    this.transport = null;
    transport?.onclose?.();
  });

  async connect(transport: FakeTransport): Promise<void> {
    this.transport = transport;
    const existing = transport.onclose;
    transport.onclose = () => {
      existing?.();
      this.sdkOnClose();
    };
  }

  listTools(): Promise<ToolsResult> {
    return this.listToolsImpl();
  }

  callTool(): Promise<CallResult> {
    return this.callToolImpl();
  }
}

const mockClients: FakeClient[] = [];
const mockTransports: FakeTransport[] = [];
let mockConfigureClient: (client: FakeClient) => void = () => undefined;

function mockNewClient(): FakeClient {
  const client = new FakeClient();
  mockConfigureClient(client);
  mockClients.push(client);
  return client;
}

function mockNewTransport(): FakeTransport {
  const transport: FakeTransport = { close: async () => undefined };
  mockTransports.push(transport);
  return transport;
}

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => mockNewClient()),
}));

jest.mock('@server/services/McpService/mcpTransport', () => ({
  buildTransport: () => mockNewTransport(),
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
jest.mock('@snaglet/db', () => ({
  McpServers: { listAll: async () => mockRows },
  Providers: { findById: async () => null },
}));

const logInfo = jest.fn();
const logDebug = jest.fn();
const logError = jest.fn();
jest.mock('@server/config/logger', () => ({
  logger: {
    info: (...a: unknown[]) => logInfo(...a),
    debug: (...a: unknown[]) => logDebug(...a),
    warn: jest.fn(),
    error: (...a: unknown[]) => logError(...a),
  },
}));

import { mcpService } from '@server/services/McpService/McpService';
import { McpInstaller } from '@server/services/McpService/mcpInstaller';

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

function mcpError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function skipLogs(): unknown[][] {
  return logInfo.mock.calls.filter((c) => String(c[0]).includes(`Skipping ${SERVER}`));
}

let installRoot: string;

beforeEach(async () => {
  // These servers aren't npx, so nothing installs; the root only keeps the
  // boot-time orphan prune inside a temp folder.
  installRoot = mkdtempSync(path.join(tmpdir(), 'snaglet-mcp-lifecycle-'));
  mcpService.useInstaller(new McpInstaller({ root: installRoot }));
  mockRows = [row()];
  mockConfigureClient = () => undefined;
  resolveEnv.mockResolvedValue({});
  await mcpService.loadConfig();
  mockClients.length = 0;
  mockTransports.length = 0;
  jest.clearAllMocks();
});

afterEach(async () => {
  await mcpService.shutdown();
  rmSync(installRoot, { recursive: true, force: true });
});

describe('McpService — failed connects and calls close their client', () => {
  it('closes the client when listTools times out during connect', async () => {
    mockConfigureClient = (client) => {
      client.listToolsImpl = async () => {
        throw mcpError(-32001, 'Request timed out');
      };
    };

    await mcpService.connect(SERVER);

    expect(mockClients).toHaveLength(1);
    expect(mockClients[0]!.close).toHaveBeenCalledTimes(1);
    expect(mcpService.getStatus(SERVER)).toBe('disconnected');
  });

  it('closes the client on a timed-out call and reconnects on the next one', async () => {
    await mcpService.connect(SERVER);
    const first = mockClients[0]!;
    first.callToolImpl = async () => {
      throw mcpError(-32001, 'Request timed out');
    };

    const failed = await mcpService.callTool(TOOL);
    expect(failed).toMatchObject({ error: 'mcp_call_failed', server: SERVER });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(mcpService.getStatus(SERVER)).toBe('disconnected');

    const ok = await mcpService.callTool(TOOL);
    expect(ok).toEqual({ content: [{ type: 'text' }], isError: false });
    expect(mockClients).toHaveLength(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(mockClients[1]!.close).not.toHaveBeenCalled();
  });

  it('keeps a healthy connection when the server itself rejects the call', async () => {
    await mcpService.connect(SERVER);
    const client = mockClients[0]!;
    client.callToolImpl = async () => {
      throw mcpError(-32602, 'Invalid params');
    };

    const failed = await mcpService.callTool(TOOL);

    expect(failed).toMatchObject({ error: 'mcp_call_failed', detail: 'Invalid params' });
    expect(client.close).not.toHaveBeenCalled();
    expect(mcpService.getStatus(SERVER)).toBe('connected');
  });

  it('closes a client whose connect finished after the server was disconnected', async () => {
    let releaseListTools: (result: ToolsResult) => void = () => undefined;
    mockConfigureClient = (client) => {
      client.listToolsImpl = () =>
        new Promise<ToolsResult>((resolve) => {
          releaseListTools = resolve;
        });
    };

    const connecting = mcpService.connect(SERVER);
    await flush();
    await mcpService.disconnect(SERVER);
    releaseListTools({ tools: [{ name: 'do_thing' }] });
    await connecting;

    expect(mockClients).toHaveLength(1);
    expect(mockClients[0]!.close).toHaveBeenCalledTimes(1);
    expect(mcpService.getStatus(SERVER)).toBe('unknown');
    expect(mcpService.listServerTools(SERVER)).toEqual([]);
  });

  it('spawns one client when the same server is warmed concurrently', async () => {
    mockRows = [row({ providerId: 'test-provider' })];
    await mcpService.loadConfig();

    mcpService.ensureServersConnected([SERVER]);
    mcpService.ensureServersConnected([SERVER]);
    mcpService.getToolDefsForServers([SERVER]);
    await flush();
    await flush();

    expect(mockClients).toHaveLength(1);
    expect(mcpService.getStatus(SERVER)).toBe('connected');
  });
});

describe('McpService — transport onclose', () => {
  it("chains the SDK's own onclose instead of replacing it", async () => {
    await mcpService.connect(SERVER);
    const client = mockClients[0]!;

    mockTransports[0]!.onclose?.();

    expect(client.sdkOnClose).toHaveBeenCalledTimes(1);
    expect(mcpService.getStatus(SERVER)).toBe('unknown');
  });

  it('never evicts a newer connection when a retired transport closes late', async () => {
    await mcpService.connect(SERVER);
    const [firstClient] = mockClients;
    const [firstTransport] = mockTransports;
    firstClient!.callToolImpl = async () => {
      throw mcpError(-32000, 'Connection closed');
    };
    await mcpService.callTool(TOOL);
    await mcpService.callTool(TOOL);
    expect(mockClients).toHaveLength(2);
    expect(mcpService.getStatus(SERVER)).toBe('connected');

    // The first process's close event arrives after the replacement is live.
    firstTransport!.onclose?.();

    expect(mcpService.getStatus(SERVER)).toBe('connected');
    await expect(mcpService.callTool(TOOL)).resolves.toMatchObject({ isError: false });
    expect(mockClients).toHaveLength(2);
  });
});

describe('McpService — config-skip cache', () => {
  it('checks a skipped server once, not on every agent warm-up', async () => {
    resolveEnv.mockResolvedValue(null);

    for (let i = 0; i < 5; i++) {
      mcpService.ensureServersConnected([SERVER]);
      await flush();
    }

    expect(resolveEnv).toHaveBeenCalledTimes(1);
    expect(skipLogs()).toHaveLength(1);
    expect(mockClients).toHaveLength(0);
  });

  it('keeps the skip across an unchanged reload and logs that reload quietly', async () => {
    resolveEnv.mockResolvedValue(null);
    mcpService.ensureServersConnected([SERVER]);
    await flush();

    await mcpService.reload();
    mcpService.ensureServersConnected([SERVER]);
    await flush();

    expect(resolveEnv).toHaveBeenCalledTimes(1);
    expect(logInfo.mock.calls.some((c) => String(c[0]).includes('Loaded'))).toBe(false);
    expect(logDebug.mock.calls.some((c) => String(c[0]).includes('Loaded'))).toBe(true);
  });

  it('re-checks once the server config changes', async () => {
    resolveEnv.mockResolvedValue(null);
    mcpService.ensureServersConnected([SERVER]);
    await flush();

    mockRows = [row({ env: { TEST_TOKEN: '${credential}' } })];
    resolveEnv.mockResolvedValue({ TEST_TOKEN: 'test-secret' });
    await mcpService.reload();
    mcpService.ensureServersConnected([SERVER]);
    await flush();

    expect(resolveEnv).toHaveBeenCalledTimes(2);
    expect(mcpService.getStatus(SERVER)).toBe('connected');
  });

  it('re-checks after a credential/provider sync for the server', async () => {
    resolveEnv.mockResolvedValue(null);
    mcpService.ensureServersConnected([SERVER]);
    await flush();

    resolveEnv.mockResolvedValue({});
    await mcpService.syncFromProvider(SERVER);
    mcpService.ensureServersConnected([SERVER]);
    await flush();

    expect(resolveEnv).toHaveBeenCalledTimes(2);
    expect(mcpService.getStatus(SERVER)).toBe('connected');
  });

  it('still re-verifies on an explicit tool call without re-logging the skip', async () => {
    resolveEnv.mockResolvedValue(null);
    mcpService.ensureServersConnected([SERVER]);
    await flush();

    const result = await mcpService.callTool(TOOL);

    expect(result).toMatchObject({ error: 'mcp_server_unavailable' });
    expect(resolveEnv).toHaveBeenCalledTimes(2);
    expect(skipLogs()).toHaveLength(1);
  });
});

describe('McpService — servers start only for an agent', () => {
  it('never spawns a server from a catalog read', async () => {
    for (let i = 0; i < 3; i++) {
      expect(mcpService.getCatalogToolDefs()).toEqual([]);
      await flush();
    }
    expect(mockClients).toHaveLength(0);
    expect(resolveEnv).not.toHaveBeenCalled();
  });

  it('does not re-spawn a server after a config/provider sync', async () => {
    mcpService.ensureServersConnected([SERVER]);
    await flush();
    expect(mockClients).toHaveLength(1);

    await mcpService.syncFromProvider(SERVER);
    await flush();

    expect(mockClients).toHaveLength(1);
    expect(mcpService.getStatus(SERVER)).toBe('unknown');

    // The next agent that needs it reconnects it.
    mcpService.ensureServersConnected([SERVER], { agentId: 'agent-1' });
    await flush();
    expect(mockClients).toHaveLength(2);
    expect(mcpService.getStatus(SERVER)).toBe('connected');
  });
});

describe('McpService — start-failure backoff', () => {
  const failStart = () => {
    mockConfigureClient = (client) => {
      client.listToolsImpl = async () => {
        throw new Error('spawn npx ENOENT');
      };
    };
  };
  const failureLogs = () =>
    logError.mock.calls.filter((c) => String(c[0]).includes(`Failed to connect to ${SERVER}`));

  it('does not re-spawn a failed server on every agent warm-up', async () => {
    failStart();
    mcpService.ensureServersConnected([SERVER], { agentId: 'agent-1' });
    await flush();
    await flush();
    expect(mockClients).toHaveLength(1);

    mcpService.ensureServersConnected([SERVER], { agentId: 'agent-1' });
    mcpService.getToolDefsForServers([SERVER], { agentId: 'agent-2' });
    await flush();
    await flush();

    expect(mockClients).toHaveLength(1);
    expect(failureLogs()).toHaveLength(1);
  });

  it('retries after the backoff and logs a repeated reason only once', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      failStart();
      await mcpService.connect(SERVER);
      now.mockReturnValue(1_000_000 + 6 * 60 * 1000);
      mcpService.ensureServersConnected([SERVER], { agentId: 'agent-1' });
      await flush();
      await flush();

      expect(mockClients).toHaveLength(2);
      expect(failureLogs()).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it('explains the failure on an explicit tool call', async () => {
    failStart();
    await mcpService.connect(SERVER);

    const result = await mcpService.callTool(TOOL);

    expect(result).toMatchObject({
      error: 'mcp_server_unavailable',
      server: SERVER,
      detail: 'spawn npx ENOENT',
    });
  });

  it('lets the next agent retry right away after a config/provider sync', async () => {
    failStart();
    await mcpService.connect(SERVER);
    mockConfigureClient = () => undefined;

    await mcpService.syncFromProvider(SERVER);
    mcpService.ensureServersConnected([SERVER], { agentId: 'agent-1' });
    await flush();
    await flush();

    expect(mcpService.getStatus(SERVER)).toBe('connected');
  });
});
