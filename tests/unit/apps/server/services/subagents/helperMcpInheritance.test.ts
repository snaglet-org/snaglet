/**
 * Subagent helpers inherit their orchestrator's MCP tools live:
 * exactly the servers the orchestrator can use in the parent thread (its own
 * enabled servers with its participant MCP delta there), under its per-tool
 * overrides, trust and the servers' confirmation policy, never a server it
 * lacks (not the helper row's own list, not a delta on the helper's hidden
 * thread). A per-agent server runs a helper's calls on the orchestrator's
 * connection. A helper narrowed by op:start `tools` keeps only the MCP tools
 * it lists; one whose orchestrator policy is gone gets none.
 *
 * Real AgentToolResolver, helper inheritance and McpService; the SDK
 * Client/transport are fakes and the DB models are mocked.
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

/** Shared server that asks before every call (its confirmation policy). */
const ASKS = 'test-server-a';
/** Per-agent server (one process per agent, like a browser) that does not ask. */
const PER_AGENT = 'test-server-b';
/** A server only another agent has. */
const OTHERS = 'test-server-c';
const tool = (server: string, name: string) => `mcp__${server}__${name}`;

function serverRow(id: string, scope: 'shared' | 'per-agent', requiresConfirmation: boolean) {
  return {
    id,
    name: id,
    transport: 'stdio',
    command: 'test-mcp-server',
    args: [],
    url: null,
    headers: {},
    env: {},
    scope,
    enabled: true,
    requiresConfirmation,
    providerId: null,
    source: 'user',
  };
}
const mockRows = [
  serverRow(ASKS, 'shared', true),
  serverRow(PER_AGENT, 'per-agent', false),
  serverRow(OTHERS, 'shared', false),
];
jest.mock('@snaglet/db', () => ({
  ...jest.requireActual<Record<string, unknown>>('@snaglet/db'),
  McpServers: { listAll: async () => mockRows },
  Providers: { findById: async () => null },
}));

const ORCH = 'test-agent-a';
const OTHER = 'test-agent-b';
const HELPER = 'subagent-11111111-1111-4111-8111-111111111111';
const NARROWED = 'subagent-22222222-2222-4222-8222-222222222222';
const ORPHAN = 'subagent-33333333-3333-4333-8333-333333333333';
const PARENT = 'thread-1111111111111-aaaaaaaaa';

interface MockAgent {
  id: string;
  parentAgentId: string | null;
  toolAccessMode: string | null;
  toolAccessAllowList: string[] | null;
  toolAccessDenyList: string[] | null;
  trustedToolCalls: boolean;
  mcpServers: string[];
  toolOverrides: Record<string, unknown> | null;
}
function agentRow(over: Partial<MockAgent> & Pick<MockAgent, 'id'>): MockAgent {
  return {
    parentAgentId: null,
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    trustedToolCalls: false,
    mcpServers: [],
    toolOverrides: null,
    ...over,
  };
}
const mockAgents = new Map<string, MockAgent>();
function seedAgents(): void {
  mockAgents.clear();
  for (const row of [
    agentRow({ id: ORCH, mcpServers: [ASKS, PER_AGENT] }),
    agentRow({ id: OTHER, mcpServers: [OTHERS] }),
    // The helper row's own servers are never read: a helper's come from its
    // orchestrator. A stray value here must not reach it.
    agentRow({ id: HELPER, parentAgentId: ORCH, mcpServers: [OTHERS] }),
    agentRow({
      id: NARROWED,
      parentAgentId: ORCH,
      toolAccessMode: 'allow_list',
      toolAccessAllowList: ['search', tool(ASKS, 'list_issues')],
    }),
    agentRow({ id: ORPHAN, parentAgentId: ORCH, mcpServers: [OTHERS] }),
  ]) {
    mockAgents.set(row.id, row);
  }
}
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: async (id: string) => mockAgents.get(id) ?? null },
}));
jest.mock('@snaglet/db/tables/subagents', () => ({
  Subagents: {
    findByAgentId: async (id: string) =>
      id === ORPHAN ? null : { agentId: id, parentThreadId: PARENT },
  },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({ ThreadParticipants: {} }));
const mockBuiltins = ['tool', 'web_fetch'].map((id) => ({
  id,
  name: id,
  type: 'builtin',
  aliases: [],
  parametersSchema: null,
}));
jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { listResolvable: async () => mockBuiltins },
}));
jest.mock('@server/services/ToolAvailabilityService', () => ({
  getToolAvailability: async () => 'available',
}));
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: async () => undefined,
    getAllDefinitions: () => ({}),
    getToolIds: () => [],
    getDefinition: () => undefined,
  },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** The orchestrator's participant entry in the parent thread (null = none). */
let mockParentOverride: Record<string, unknown> | null = null;
jest.mock('@server/services/ConfigResolverService', () => ({
  resolveThreadRuntimeConfig: async (threadId: string) => ({
    agentOverrides: new Map(
      threadId === PARENT && mockParentOverride ? [[ORCH, mockParentOverride]] : []
    ),
    dispatch: {},
  }),
}));

import {
  resolveAgentTools,
  resolveAgentToolsForExecution,
} from '@server/services/AgentToolResolver';
import { mcpService } from '@server/services/McpService/McpService';
import { McpInstaller } from '@server/services/McpService/mcpInstaller';

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function mcpTools(agentId: string, options = {}) {
  return (await resolveAgentTools(agentId, options)).filter((entry) => entry.tool.type === 'mcp');
}
async function mcpIds(agentId: string, options = {}): Promise<string[]> {
  return (await mcpTools(agentId, options)).map((entry) => entry.tool.id).sort();
}

/** Warm every server once, as the orchestrator's turn would. */
async function warmAll(): Promise<void> {
  mcpService.ensureServersConnected([ASKS, PER_AGENT, OTHERS], { agentId: ORCH });
  await settle();
}

let installRoot: string;

beforeEach(async () => {
  seedAgents();
  mockParentOverride = null;
  installRoot = mkdtempSync(path.join(tmpdir(), 'snaglet-helper-mcp-'));
  mcpService.useInstaller(new McpInstaller({ root: installRoot }));
  await mcpService.loadConfig();
  mockClients.length = 0;
});

afterEach(async () => {
  await mcpService.shutdown();
  rmSync(installRoot, { recursive: true, force: true });
});

describe("a helper's MCP tools are its orchestrator's", () => {
  it("sees exactly the orchestrator's servers, never another agent's or its own row's", async () => {
    await warmAll();
    const orchestrator = await mcpIds(ORCH);
    expect(orchestrator).toEqual(
      [
        tool(ASKS, 'create_issue'),
        tool(ASKS, 'list_issues'),
        tool(PER_AGENT, 'create_issue'),
        tool(PER_AGENT, 'list_issues'),
      ].sort()
    );
    expect(await mcpIds(HELPER)).toEqual(orchestrator);
    expect((await mcpIds(HELPER)).some((id) => id.includes(OTHERS))).toBe(false);
    expect(await mcpIds(OTHER)).toEqual(
      [tool(OTHERS, 'create_issue'), tool(OTHERS, 'list_issues')].sort()
    );
  });

  it('loses a server at its next resolution when the orchestrator does', async () => {
    await warmAll();
    expect(await mcpIds(HELPER)).toContain(tool(PER_AGENT, 'list_issues'));

    mockAgents.get(ORCH)!.mcpServers = [ASKS];
    expect((await mcpIds(HELPER)).some((id) => id.includes(PER_AGENT))).toBe(false);

    mockAgents.get(ORCH)!.mcpServers = [];
    expect(await mcpIds(HELPER)).toEqual([]);

    // Granted back: the helper has it again, nothing copied in between.
    mockAgents.get(ORCH)!.mcpServers = [PER_AGENT];
    expect(await mcpIds(HELPER)).toEqual(
      [tool(PER_AGENT, 'create_issue'), tool(PER_AGENT, 'list_issues')].sort()
    );
  });

  it("follows the orchestrator's MCP delta in the parent thread, never one on its own thread", async () => {
    await warmAll();
    mockParentOverride = { mcpServers: { add: [OTHERS], remove: [ASKS] } };
    const ids = await mcpIds(HELPER);
    expect(ids.some((id) => id.includes(OTHERS))).toBe(true);
    expect(ids.some((id) => id.includes(ASKS))).toBe(false);

    // A delta handed to the resolver belongs to the thread being resolved —
    // for a helper, its hidden thread — so it never adds a server.
    mockParentOverride = null;
    const viaHiddenThread = await mcpIds(HELPER, { mcpServerOverride: { add: [OTHERS] } });
    expect(viaHiddenThread.some((id) => id.includes(OTHERS))).toBe(false);
    // The same delta does apply to an ordinary agent in its thread.
    expect(
      (await mcpIds(ORCH, { mcpServerOverride: { add: [OTHERS] } })).some((id) =>
        id.includes(OTHERS)
      )
    ).toBe(true);
  });

  it('asks for confirmation exactly where the orchestrator would be asked', async () => {
    await warmAll();
    const confirmation = async (agentId: string) =>
      Object.fromEntries(
        (await mcpTools(agentId)).map((entry) => [entry.tool.id, entry.requiresConfirmation])
      );

    // The server policy: test-server-a asks, test-server-b does not.
    expect(await confirmation(HELPER)).toEqual(await confirmation(ORCH));
    expect((await confirmation(HELPER))[tool(ASKS, 'list_issues')]).toBe(true);
    expect((await confirmation(HELPER))[tool(PER_AGENT, 'list_issues')]).toBe(false);

    // The orchestrator's own per-tool override.
    mockAgents.get(ORCH)!.toolOverrides = {
      [tool(ASKS, 'list_issues')]: { requiresConfirmation: false },
      [tool(PER_AGENT, 'create_issue')]: { requiresConfirmation: true },
    };
    expect(await confirmation(HELPER)).toEqual(await confirmation(ORCH));
    expect((await confirmation(HELPER))[tool(ASKS, 'list_issues')]).toBe(false);
    expect((await confirmation(HELPER))[tool(PER_AGENT, 'create_issue')]).toBe(true);

    // Trust skips the prompt for the orchestrator, so for its helpers too…
    mockAgents.get(ORCH)!.toolOverrides = null;
    mockAgents.get(ORCH)!.trustedToolCalls = true;
    expect(Object.values(await confirmation(HELPER)).every((asks) => !asks)).toBe(true);
    // …unless the orchestrator's entry in the parent thread asks again.
    mockParentOverride = {
      toolOverrides: { [tool(ASKS, 'create_issue')]: { requiresConfirmation: true } },
    };
    expect((await confirmation(HELPER))[tool(ASKS, 'create_issue')]).toBe(true);

    // The helper row's own trust and overrides are never read.
    mockAgents.get(ORCH)!.trustedToolCalls = false;
    mockParentOverride = null;
    mockAgents.get(HELPER)!.trustedToolCalls = true;
    mockAgents.get(HELPER)!.toolOverrides = {
      [tool(ASKS, 'list_issues')]: { requiresConfirmation: false },
    };
    expect((await confirmation(HELPER))[tool(ASKS, 'list_issues')]).toBe(true);
  });
});

describe('per-agent servers', () => {
  it("run a helper's calls on its orchestrator's connection (no second process)", async () => {
    // The helper's turn warms the orchestrator's connection, not one of its own.
    await resolveAgentTools(HELPER, { warmMcpServers: true });
    await settle();
    const started = mockClients.length;
    expect(started).toBe(2); // test-server-a (shared) + test-server-b for the orchestrator

    const helperTool = (await mcpTools(HELPER)).find(
      (entry) => entry.tool.id === tool(PER_AGENT, 'list_issues')
    );
    expect(helperTool?.mcpAgentId).toBe(ORCH);
    expect(helperTool?.agentId).toBe(HELPER);

    // The orchestrator and the helper call it: still one process.
    await expect(
      mcpService.callTool(tool(PER_AGENT, 'list_issues'), {}, { agentId: ORCH })
    ).resolves.toMatchObject({ isError: false });
    await expect(
      mcpService.callTool(tool(PER_AGENT, 'list_issues'), {}, { agentId: helperTool!.mcpAgentId })
    ).resolves.toMatchObject({ isError: false });
    expect(mockClients).toHaveLength(started);
  });

  it("an ordinary agent's tools route to its own connection", async () => {
    await warmAll();
    const own = (await mcpTools(ORCH)).find(
      (entry) => entry.tool.id === tool(PER_AGENT, 'list_issues')
    );
    expect(own?.mcpAgentId).toBe(ORCH);
  });
});

describe('a narrowed helper', () => {
  it('keeps only the MCP tools it lists; asking first reaches the rest of the orchestrator’s', async () => {
    await warmAll();
    expect(await mcpIds(NARROWED)).toEqual([tool(ASKS, 'list_issues')]);
    // The execution set (allow-list escalation: a person is asked first)
    // still stops at the orchestrator's servers.
    const execution = (await resolveAgentToolsForExecution(NARROWED))
      .filter((entry) => entry.tool.type === 'mcp')
      .map((entry) => entry.tool.id);
    expect(execution).toEqual(expect.arrayContaining([tool(PER_AGENT, 'create_issue')]));
    expect(execution.some((id) => id.includes(OTHERS))).toBe(false);
  });

  it('warms only the servers of the tools it lists', async () => {
    await resolveAgentTools(NARROWED, { warmMcpServers: true });
    await settle();
    expect(mockClients).toHaveLength(1);
    expect(mcpService.getStatus(ASKS)).toBe('connected');
    expect(mcpService.getStatus(PER_AGENT)).not.toBe('connected');
  });
});

describe('a helper whose orchestrator policy is gone', () => {
  it('gets no MCP tools, whatever its own row lists', async () => {
    await warmAll();
    expect(await mcpIds(ORPHAN)).toEqual([]);
    expect(await mcpIds(ORPHAN, { mcpServerOverride: { add: [OTHERS] } })).toEqual([]);
  });

  it('gets only the always-available tools, never its own row (All) access', async () => {
    const ids = (await resolveAgentTools(ORPHAN)).map((entry) => entry.tool.id);
    expect(ids).toEqual(['tool']);
    // A helper that still has its orchestrator gets the orchestrator's (All).
    expect((await resolveAgentTools(HELPER)).map((entry) => entry.tool.id)).toEqual([
      'tool',
      'web_fetch',
    ]);
  });
});
