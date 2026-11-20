/**
 * An idle stop changes nothing an agent sees: the agent's MCP grant, its
 * per-tool settings and confirmation overrides, and the server's cached tool
 * list resolve the same before the stop, while the server is stopped, and
 * after a call has restarted it. Reading the agent's tools (no
 * `warmMcpServers`) never starts the server; a turn warms it only while its
 * tools aren't cached yet.
 *
 * Real AgentToolResolver and McpService; the SDK Client/transport are fakes,
 * the DB models are mocked, time is Jest's fake clock.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface FakeTransport {
  onclose?: () => void;
  close: () => Promise<void>;
}

class FakeClient {
  transport: FakeTransport | null = null;
  readonly close = jest.fn(async () => {
    const transport = this.transport;
    this.transport = null;
    transport?.onclose?.();
  });
  async connect(transport: FakeTransport): Promise<void> {
    this.transport = transport;
  }
  async listTools() {
    return {
      tools: [
        { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } },
        { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object' } },
      ],
    };
  }
  async callTool() {
    return { content: [{ type: 'text', text: 'ok' }] };
  }
}

const mockClients: FakeClient[] = [];
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => {
    const client = new FakeClient();
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

jest.mock('@server/services/McpService/mcpCredentials', () => ({
  resolveEnv: async () => ({}),
  resolveHeaders: async () => ({}),
  configRequiresCredential: () => false,
  configCredentialSpec: () => ({ requiresSecret: false, bundleFields: [] }),
  credentialKeyForConfig: (config: { id: string; providerId: string | null }) =>
    config.providerId ?? config.id,
}));

const SERVER = 'test-server-a';
const LIST = `mcp__${SERVER}__list_issues`;
const CREATE = `mcp__${SERVER}__create_issue`;

const mockRows = [
  {
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
    requiresConfirmation: true,
    providerId: null,
    source: 'user',
  },
];
jest.mock('@snaglet/db', () => ({
  ...jest.requireActual<Record<string, unknown>>('@snaglet/db'),
  McpServers: { listAll: async () => mockRows },
  Providers: { findById: async () => null },
}));

const mockAgent = {
  id: 'test-agent-a',
  parentAgentId: null,
  toolAccessMode: null,
  toolAccessAllowList: null,
  toolAccessDenyList: null,
  trustedToolCalls: false,
  mcpServers: [SERVER],
  toolOverrides: {
    [LIST]: { requiresConfirmation: false, settings: { per_page: 50 } },
  },
};
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: async (id: string) => (id === 'test-agent-a' ? mockAgent : null) },
}));
jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { listResolvable: async () => [] },
}));
jest.mock('@server/services/ToolAvailabilityService', () => ({
  getToolAvailability: async () => 'available',
}));
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: async () => undefined,
    getAllDefinitions: () => ({}),
  },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { mcpService } from '@server/services/McpService/McpService';
import { McpInstaller } from '@server/services/McpService/mcpInstaller';
import { IDLE_REAP_MS, REAP_INTERVAL_MS } from '@server/services/McpService/mcpTypes';

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** What the agent sees of its MCP tools. */
async function agentMcpTools() {
  const resolved = await resolveAgentTools('test-agent-a');
  return resolved
    .filter((entry) => entry.tool.type === 'mcp')
    .map((entry) => ({
      id: entry.tool.id,
      requiresConfirmation: entry.requiresConfirmation,
      settings: entry.settings,
      schema: entry.tool.parametersSchema,
    }));
}

let installRoot: string;

beforeEach(async () => {
  jest.useFakeTimers();
  installRoot = mkdtempSync(path.join(tmpdir(), 'snaglet-mcp-idle-resolver-'));
  mcpService.useInstaller(new McpInstaller({ root: installRoot }));
  await mcpService.loadConfig();
  mockClients.length = 0;
});

afterEach(async () => {
  await mcpService.shutdown();
  jest.useRealTimers();
  rmSync(installRoot, { recursive: true, force: true });
});

describe('idle stop and the agent’s tools', () => {
  it('resolves the same grant, overrides and tools before, during and after an idle stop', async () => {
    // Reading the agent's tools never starts the server.
    expect(await agentMcpTools()).toEqual([]);
    await settle();
    expect(mockClients).toHaveLength(0);

    // A turn warms it once (tools not cached yet).
    await resolveAgentTools('test-agent-a', { warmMcpServers: true });
    await settle();
    expect(mockClients).toHaveLength(1);

    const before = await agentMcpTools();
    expect(before.map((tool) => tool.id)).toEqual([LIST, CREATE]);
    expect(before[0]).toMatchObject({ requiresConfirmation: false, settings: { per_page: 50 } });
    expect(before[1]).toMatchObject({ requiresConfirmation: true, settings: {} });

    jest.advanceTimersByTime(IDLE_REAP_MS + REAP_INTERVAL_MS);
    await settle();
    expect(mcpService.getStatus(SERVER)).toBe('idle');

    // Stopped: same tools, and a turn does not restart it.
    expect(await agentMcpTools()).toEqual(before);
    await resolveAgentTools('test-agent-a', { warmMcpServers: true });
    await settle();
    expect(mockClients).toHaveLength(1);

    // A call restarts it; still the same.
    await expect(mcpService.callTool(LIST, {}, { agentId: 'test-agent-a' })).resolves.toMatchObject(
      { isError: false }
    );
    expect(mockClients).toHaveLength(2);
    expect(await agentMcpTools()).toEqual(before);
    expect(mockAgent.mcpServers).toEqual([SERVER]);
  });
});
