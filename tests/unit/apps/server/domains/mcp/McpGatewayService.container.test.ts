/**
 * container(op) at the MCP boundary. The project facets (folder_path,
 * github_url, file_indexing_enabled) are outside the external shape
 * (EXTERNAL_OP_PARAMS), so the gateway refuses them: container tools are not
 * path-guarded, so that refusal is the real guard. The shape check keys on the
 * canonical id after alias resolution and op pinning, so every name and every
 * op is covered.
 * Uses the real alias registry, curation map and container definition.
 */
const getDefinitionMock = jest.fn();
const executeMock = jest.fn();

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    load: jest.fn().mockResolvedValue(undefined),
    getDefinition: (...args: unknown[]) => getDefinitionMock(...args),
    getAllDefinitions: jest.fn().mockReturnValue({}),
  },
}));

jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: { execute: (...args: unknown[]) => executeMock(...args) },
}));

jest.mock('@snaglet/db', () => ({ Containers: {}, Projects: {} }));

jest.mock('@server/realtime/actorContext', () => ({
  runWithActor: (_actor: unknown, operation: () => unknown) => operation(),
}));

import { mcpGatewayService } from '@server/domains/mcp/McpGatewayService';
import { projectTools } from '@server/domains/mcp/mcpProjection';
import containerDefinition from '@server/services/ToolService/tools/containers/container/definition';

const caller = { memberId: 'member-1', name: 'External test' };

const call = (name: string, args: Record<string, unknown>) =>
  mcpGatewayService.executeExternalToolCall(name, args, caller);

const deniedText = (result: { isError?: boolean; content?: Array<{ text?: string }> }) => {
  expect(result.isError).toBe(true);
  return result.content?.[0]?.text ?? '';
};

const NAMES_AND_OPS: Array<[string, Record<string, unknown>]> = [
  ['snaglet_container', { op: 'create', name: 'X' }],
  ['snaglet_container', { op: 'update', id: 'container-1' }],
  ['snaglet_create_container', { name: 'X' }],
  ['snaglet_update_container', { container_id: 'container-1' }],
  ['snaglet_workspace_create_container', { name: 'X' }],
  ['snaglet_workspace_update_container', { id: 'container-1' }],
];

describe('McpGatewayService container(op)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDefinitionMock.mockImplementation((id: string) =>
      id === 'container' ? containerDefinition : undefined
    );
    executeMock.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
  });

  it.each([
    ['snaglet_container', { op: 'create', name: 'X', parent_id: 'container-1' }],
    ['snaglet_container', { op: 'update', id: 'container-1', description: 'd' }],
    ['snaglet_create_container', { name: 'X', parent_path: '/Snaglet' }],
    ['snaglet_update_container', { container_id: 'container-1', description: 'd' }],
    // The handler's legacy names stay accepted on the canonical tool.
    ['snaglet_container', { op: 'create', name: 'X', container_id: 'container-1' }],
    ['snaglet_container', { op: 'create', name: 'X', container_path: '/Snaglet' }],
    ['snaglet_container', { op: 'update', container_id: 'container-1', description: 'd' }],
    ['snaglet_container', { op: 'update', container_path: '/Snaglet/X', description: 'd' }],
  ])('allows %s %j', async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBeFalsy();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  describe.each(['folder_path', 'github_url', 'file_indexing_enabled'])(
    'denies the %s facet through every name and op',
    (facet) => {
      it.each(NAMES_AND_OPS)('%s %j', async (name, args) => {
        const result = await call(name, { ...args, [facet]: 'x' });
        expect(deniedText(result)).toMatch(new RegExp(facet));
        expect(executeMock).not.toHaveBeenCalled();
      });
    }
  );

  it('denies a facet set to null too (present = supplied)', async () => {
    const result = await call('snaglet_container', { op: 'update', id: 'c-1', folder_path: null });
    expect(deniedText(result)).toMatch(/folder_path/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('snaglet_update_container with a smuggled op:create plus folder_path stays update and is denied', async () => {
    const result = await call('snaglet_update_container', {
      op: 'create',
      container_id: 'container-1',
      folder_path: '/etc',
    });
    expect(deniedText(result)).toMatch(/folder_path/);
    expect(executeMock).not.toHaveBeenCalled();

    // Without the facet, the same smuggled op still runs as update.
    await call('snaglet_update_container', {
      op: 'create',
      container_id: 'container-1',
      description: 'd',
    });
    expect(executeMock.mock.calls[0]?.[0]).toEqual({
      name: 'update_container',
      input: expect.objectContaining({ op: 'update', container_id: 'container-1' }),
    });
  });

  it('snaglet_create_container with a smuggled op:update stays create', async () => {
    await call('snaglet_create_container', { op: 'update', name: 'X' });
    expect(executeMock.mock.calls[0]?.[0]).toEqual({
      name: 'create_container',
      input: expect.objectContaining({ op: 'create', name: 'X' }),
    });
  });

  it.each([
    ['snaglet_container', { op: 'delete', id: 'container-1' }],
    ['snaglet_container', { op: 'archive', id: 'container-1' }],
  ])('refuses %s %j (not an op of container), naming the external ops', async (name, args) => {
    const result = await call(name, args);
    expect(deniedText(result)).toMatch(
      /^`(delete|archive)` is not an op of snaglet_container; external ops: create, update\.$/
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('refuses snaglet_container with no op (op not curated)', async () => {
    const result = await call('snaglet_container', {});
    expect(deniedText(result)).toMatch(/not available to external MCP clients/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('leaves the project facets out of the external schema; the gateway refuses them', () => {
    // folder_path/github_url are set in the app: not in the schema an
    // external client sees, and refused at call time (above).
    const [projected] = projectTools({ container: containerDefinition });
    expect(projected?.name).toBe('snaglet_container');
    const props = (projected?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(
      [
        'op',
        'name',
        'parent_id',
        'parent_path',
        'category',
        'sort_order',
        'id',
        'path',
        'description',
      ].sort()
    );
    // In-app the facets are still there.
    const inApp = containerDefinition.parameters_schema.properties as Record<string, unknown>;
    expect(inApp).toHaveProperty('folder_path');
    expect(inApp).toHaveProperty('github_url');
    expect(projected?.description).toMatch(
      /Project folders and GitHub links are set in the Snaglet app/
    );
  });
});
