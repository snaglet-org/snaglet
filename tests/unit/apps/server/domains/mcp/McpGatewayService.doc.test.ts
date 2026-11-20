/**
 * doc(op) at the MCP boundary. The external surface is exactly what the
 * get_doc, create_doc and edit_doc aliases expose. delete_doc is not curated,
 * so neither its op nor its alias name reaches it.
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

const docDefinition = {
  id: 'doc',
  name: 'Doc',
  description: 'doc',
  type: 'builtin',
  tier: 'core',
  categoryPath: 'docs',
  parameters_schema: {},
  keywords: [],
};

const call = (name: string, args: Record<string, unknown>) =>
  mcpGatewayService.executeExternalToolCall(name, args, caller);

describe('McpGatewayService doc(op)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDefinitionMock.mockImplementation((id: string) =>
      id === 'doc' ? docDefinition : undefined
    );
    executeMock.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
  });

  it.each([
    ['snaglet_doc', { op: 'get', id: 'doc-1' }],
    ['snaglet_doc', { op: 'create', title: 'T', parent_id: 'container-1' }],
    ['snaglet_doc', { op: 'update', id: 'doc-1', edits: [{ old_text: 'a', new_text: 'b' }] }],
    ['snaglet_get_doc', { id: 'doc-1' }],
    ['snaglet_create_doc', { title: 'T', parent_path: '/Snaglet' }],
    ['snaglet_edit_doc', { doc_id: 'doc-1', edits: [{ old_text: 'a', new_text: 'b' }] }],
  ])('allows %s %j', async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBeFalsy();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('runs the old snaglet_edit_doc name as op update with doc_id carried over', async () => {
    await call('snaglet_edit_doc', { doc_id: 'doc-1', edits: [] });
    expect(executeMock.mock.calls[0]?.[0]).toEqual({
      name: 'edit_doc',
      input: expect.objectContaining({ op: 'update', id: 'doc-1' }),
    });
  });

  it.each([
    ['snaglet_doc', { op: 'delete', id: 'doc-1' }],
    ['snaglet_doc', { op: 'delete', id: 'doc-1', force: true }],
    ['snaglet_doc', {}],
    ['snaglet_delete_doc', { id: 'doc-1' }],
    ['snaglet_workspace_delete_doc', { id: 'doc-1' }],
    // an old curated name cannot be redirected to delete
    ['snaglet_edit_doc', { op: 'delete', id: 'doc-1' }],
  ])('refuses %s %j (delete is not external)', async (name, args) => {
    const result = await call(name, args);
    if (name === 'snaglet_edit_doc') {
      // the alias pins op update, so the smuggled op never reaches delete
      expect(executeMock.mock.calls[0]?.[0]).toEqual({
        name: 'edit_doc',
        input: expect.objectContaining({ op: 'update' }),
      });
      return;
    }
    expect(result.isError).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
