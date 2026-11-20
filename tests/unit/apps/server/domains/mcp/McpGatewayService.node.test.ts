/**
 * node(op) at the MCP boundary. The external surface is exactly what the
 * get_node, workspace_tree and move aliases expose: get (single id), tree and
 * move. rename, verify_ids, archive_node and restore_node are not curated, so
 * neither their op nor their alias name reaches them.
 * Uses the real alias registry and curation map.
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

const caller = { memberId: 'member-1', name: 'External test' };

const nodeDefinition = {
  id: 'node',
  name: 'Node',
  description: 'node',
  type: 'builtin',
  tier: 'core',
  categoryPath: 'workspace',
  parameters_schema: {},
  keywords: [],
};

const call = (name: string, args: Record<string, unknown>) =>
  mcpGatewayService.executeExternalToolCall(name, args, caller);

describe('McpGatewayService node(op)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDefinitionMock.mockImplementation((id: string) =>
      id === 'node' ? nodeDefinition : undefined
    );
    executeMock.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
  });

  it.each([
    ['snaglet_node', { op: 'get', id: 'doc-1' }],
    ['snaglet_node', { op: 'tree' }],
    ['snaglet_node', { op: 'move', id: 'doc-1', parent_id: 'container-1', sort_order: 0 }],
    ['snaglet_get_node', { id: 'doc-1' }],
    ['snaglet_workspace_tree', { container_id: 'container-1' }],
    ['snaglet_move', { id: 'doc-1', new_parent_id: 'container-1' }],
  ])('allows %s %j', async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBeFalsy();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('runs the old snaglet_move name as op move with its old field names carried over', async () => {
    await call('snaglet_move', { id: 'doc-1', new_parent_id: 'container-1' });
    expect(executeMock.mock.calls[0]?.[0]).toEqual({
      name: 'move',
      input: expect.objectContaining({ op: 'move', id: 'doc-1', parent_id: 'container-1' }),
    });
  });

  it.each([
    [
      'snaglet_node',
      { op: 'get', ids: ['doc-1', 'doc-2'] },
      '`ids` is not a parameter of snaglet_node op get',
    ],
    [
      'snaglet_verify_ids',
      { ids: ['doc-1'] },
      '`ids` is not a parameter of snaglet_verify_ids op get',
    ],
  ])('refuses %s %j (never curated before the merge)', async (name, args, reason) => {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(reason);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['snaglet_node', { op: 'rename', id: 'doc-1', title: 'New' }],
    ['snaglet_node', { op: 'update', id: 'doc-1', parent_id: 'c-1' }],
    ['snaglet_node', { op: 'archive', id: 'doc-1' }],
    ['snaglet_node', { op: 'restore', id: 'doc-1' }],
    ['snaglet_node', {}],
    ['snaglet_rename', { id: 'doc-1', new_title: 'New' }],
    ['snaglet_workspace_rename', { id: 'doc-1', new_title: 'New' }],
    ['snaglet_archive_node', { id: 'doc-1' }],
    ['snaglet_archive_container', { id: 'container-1' }],
    ['snaglet_restore_node', { id: 'doc-1' }],
  ])('refuses %s %j (rename/archive/restore are not external)', async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
