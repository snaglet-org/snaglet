/**
 * mcp(op) handlers: masking, input mapping, update merge, who is calling
 * delete/restore, and that no op echoes a secret. The write rules themselves
 * live in mcpServerConfig (shared with the /api/mcp/servers routes) and are
 * mocked at that seam here.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindServer = jest.fn<(id: string) => Promise<unknown>>();
const mockListAll = jest.fn<() => Promise<unknown[]>>();
jest.mock('@snaglet/db', () => ({
  McpServers: { findServer: mockFindServer, listAll: mockListAll },
}));
jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: { findByProviderId: jest.fn(async () => null) },
}));
jest.mock('@server/services/McpService', () => ({
  mcpService: {
    reload: jest.fn(async () => undefined),
    getStatus: jest.fn(() => 'connected'),
    requiresCredential: jest.fn(() => false),
    testConnection: jest.fn(async () => ({ ok: true, status: 'connected', toolCount: 3 })),
  },
}));
const mockCreate = jest.fn<(body: unknown, id: string) => Promise<unknown>>();
const mockUpdate = jest.fn<(existing: unknown, body: unknown) => Promise<unknown>>();
const mockDelete = jest.fn<(id: string, actor: unknown) => Promise<unknown>>();
const mockRestore = jest.fn<(id: string, actor: unknown) => Promise<unknown>>();
const mockSetCred = jest.fn<(server: unknown, input: unknown) => Promise<void>>();
jest.mock('@server/services/McpService/mcpServerConfig', () => ({
  createMcpServer: mockCreate,
  updateMcpServer: mockUpdate,
  deleteMcpServer: mockDelete,
  restoreMcpServer: mockRestore,
  setMcpServerCredential: mockSetCred,
  mcpCredKeyFor: (row: { providerId: string | null; id: string }) => row.providerId ?? row.id,
}));

import {
  createServer,
  deleteServer,
  getServer,
  maskValues,
  mcpActor,
  mergeForUpdate,
  restoreServer,
  setServerCredential,
  testServer,
  toBody,
  updateServer,
} from '@server/services/ToolService/handlers/agents/mcp';

type Result = { output: string; rawContent: Record<string, unknown> };
const call = (h: typeof createServer, input: Record<string, unknown>) =>
  h(input, {}, undefined) as Promise<Result>;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'gh',
  providerId: null,
  name: 'GitHub',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'gh-mcp'],
  url: null,
  headers: {},
  env: { GITHUB_TOKEN: '${credential}', DEBUG: 'ghp_literal' },
  scope: 'shared',
  enabled: true,
  autoload: false,
  requiresConfirmation: true,
  source: 'user',
  createdAt: '',
  updatedAt: '',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFindServer.mockResolvedValue(row());
});

describe('maskValues', () => {
  it('masks literals and keeps credential placeholders readable', () => {
    expect(
      maskValues({ A: '${credential}', B: '${cred.token}', C: 'sk-123', D: '${cred.bad-x}' })
    ).toEqual({ A: '${credential}', B: '${cred.token}', C: '•••', D: '•••' });
    expect(maskValues(null)).toEqual({});
  });
});

describe('toBody', () => {
  it('maps snake_case to the route body and type-checks', () => {
    expect(
      toBody({ name: 'N', requires_confirmation: false, provider_id: null, command_args: ['a'] })
    ).toEqual({ name: 'N', requiresConfirmation: false, providerId: null, args: ['a'] });
    expect(toBody({ command_args: 'x' })).toMatch(/command_args/);
    expect(toBody({ env: { A: 1 } })).toMatch(/env/);
    expect(toBody({ enabled: 'yes' })).toMatch(/enabled/);
  });
});

describe('mergeForUpdate', () => {
  it('keeps the stored spec, overlays sent fields, leaves enabled/autoload/providerId unsent', () => {
    const merged = mergeForUpdate(row() as never, { url: 'https://x' });
    expect(merged).toMatchObject({ name: 'GitHub', command: 'npx', url: 'https://x' });
    expect(merged).not.toHaveProperty('enabled');
    expect(merged).not.toHaveProperty('autoload');
    expect(merged).not.toHaveProperty('providerId');
  });
});

describe('mcpActor', () => {
  it('is the agent for its own run and a person otherwise', () => {
    expect(mcpActor({ agentId: 'test-agent-a' })).toEqual({
      kind: 'agent',
      agentId: 'test-agent-a',
    });
    // The panel acting as an agent is still a person at the controls.
    expect(mcpActor({ agentId: 'test-agent-a', bypassToolAccess: true })).toEqual({
      kind: 'person',
    });
    expect(mcpActor(undefined)).toEqual({ kind: 'person' });
  });
});

describe('handlers', () => {
  it('get masks literal env values', async () => {
    const r = await call(getServer, { id: 'gh' });
    expect(r.output).toContain('${credential}');
    expect(r.output).not.toContain('ghp_literal');
  });

  it('create goes through the shared rule with the mapped body', async () => {
    mockCreate.mockResolvedValue(row());
    const r = await call(createServer, { id: 'gh', name: 'GitHub', command: 'npx' });
    expect(mockCreate).toHaveBeenCalledWith({ name: 'GitHub', command: 'npx' }, 'gh');
    expect(r.output).toMatch(/^Added MCP server/);
  });

  it('create surfaces shared-rule errors as a tool error', async () => {
    mockCreate.mockRejectedValue(new Error("Server 'gh' already exists"));
    const r = await call(createServer, { id: 'gh', name: 'GitHub', command: 'npx' });
    expect(r.rawContent.error).toMatch(/already exists/);
  });

  it('update needs an existing server and at least one field', async () => {
    mockFindServer.mockResolvedValueOnce(null);
    expect((await call(updateServer, { id: 'nope', name: 'X' })).rawContent.error).toMatch(
      /not found/
    );
    expect((await call(updateServer, { id: 'gh' })).rawContent.error).toMatch(/Nothing to update/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('delete reports pruned agents', async () => {
    mockDelete.mockResolvedValue({ id: 'gh', removed: true, agentsPruned: 2 });
    const r = await call(deleteServer, { id: 'gh' });
    expect(mockDelete).toHaveBeenCalledWith('gh', { kind: 'person' });
    expect(r.output).toMatch(/removed it from 2 agent/);
    expect(r.output).toMatch(/restore/);
  });

  it('delete and restore record the calling agent', async () => {
    mockDelete.mockResolvedValue({ id: 'gh', removed: true, agentsPruned: 0 });
    mockRestore.mockResolvedValue({ id: 'gh', restored: true, agentsRestored: 2 });
    await deleteServer({ id: 'gh' }, {}, { agentId: 'test-agent-a' });
    const r = (await restoreServer({ id: 'gh' }, {}, { agentId: 'test-agent-a' })) as Result;

    expect(mockDelete).toHaveBeenCalledWith('gh', { kind: 'agent', agentId: 'test-agent-a' });
    expect(mockRestore).toHaveBeenCalledWith('gh', { kind: 'agent', agentId: 'test-agent-a' });
    expect(r.output).toMatch(/^Restored MCP server "gh".* 2 agent/);
    expect(r.rawContent).toEqual({
      action: 'restored',
      id: 'gh',
      restored: true,
      agentsRestored: 2,
    });
  });

  it('restore surfaces a refusal as a tool error and needs an id', async () => {
    mockRestore.mockRejectedValue(new Error("Server 'gh' was deleted by someone else"));
    const r = await call(restoreServer, { id: 'gh' });
    expect(r.rawContent.error).toMatch(/deleted by someone else/);
    expect((await call(restoreServer, {})).rawContent.error).toMatch(/`id` is required/);
  });

  it('test reports the probe', async () => {
    expect((await call(testServer, { id: 'gh' })).output).toMatch(/connected: 3 tool/);
  });

  it('set_credential saves and never echoes the secret or bundle values', async () => {
    const r = await call(setServerCredential, {
      id: 'gh',
      secret: 'ghp_SECRET',
      bundle: { token: 'BUNDLE_SECRET' },
    });
    expect(mockSetCred).toHaveBeenCalledWith(expect.objectContaining({ id: 'gh' }), {
      secret: 'ghp_SECRET',
      bundle: { token: 'BUNDLE_SECRET' },
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain('ghp_SECRET');
    expect(text).not.toContain('BUNDLE_SECRET');
    expect(r.output).toMatch(/secret and bundle \(token\)/);
  });

  it('set_credential validates its input', async () => {
    expect((await call(setServerCredential, { id: 'gh', secret: '' })).rawContent.error).toMatch(
      /secret/
    );
    expect(
      (await call(setServerCredential, { id: 'gh', bundle: { a: 1 } })).rawContent.error
    ).toMatch(/bundle/);
    expect(mockSetCred).not.toHaveBeenCalled();
  });
});
