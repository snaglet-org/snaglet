import { beforeEach, describe, expect, it } from '@jest/globals';

// clone_node is a thin surface over the shared clone engine — mock `cloneNode`
// and assert the tool resolves the target tri-state + returns the new root.
const mockCloneNode = jest.fn();
jest.mock('@server/domains/clone/NodeCloneService', () => ({
  cloneNode: mockCloneNode,
}));

import cloneNodeTool from '@server/services/ToolService/tools/workspace/clone-node/tool';
import { parseToolResult } from '../../../../../../support/toolHarness';

interface CloneNodeResult {
  success: boolean;
  kind: string;
  node: { id: string; container_id: string | null };
  node_count: number;
  link: string;
}

const asResult = (out: unknown): CloneNodeResult => parseToolResult<CloneNodeResult>(out);

interface CloneRoot {
  id: string;
  kind: string;
  title: string;
  parentId: string | null;
  sortKey: string;
  createdAt: string;
  updatedAt: string;
}

const cloneResult = (rootOverrides: Partial<CloneRoot> = {}, count = 1) => ({
  root: {
    id: 'container-new',
    kind: 'container',
    title: 'Group (1)',
    parentId: 'container-target',
    sortKey: '3',
    createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2025-01-01T00:00:00Z').toISOString(),
    ...rootOverrides,
  },
  count,
});

describe('clone_node tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCloneNode.mockResolvedValue(cloneResult());
  });

  it('clones by id and returns the new root id, link, and node count', async () => {
    mockCloneNode.mockResolvedValueOnce(cloneResult({}, 7));
    const out = await cloneNodeTool(
      { id: 'container-src', target_container_id: 'container-target' },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.kind).toBe('container');
    expect(result.node.id).toBe('container-new');
    expect(result.node.container_id).toBe('container-target');
    expect(result.node_count).toBe(7);
    // Prefixed ids drop the scheme in linkForm — `[Title](id)`.
    expect(result.link).toBe('[Group (1)](container-new)');
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'container-src',
        targetContainerId: 'container-target',
      })
    );
  });

  it('omitted target → undefined (paste beside the original)', async () => {
    await cloneNodeTool({ id: 'doc-1' }, {}, {});
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'doc-1', targetContainerId: undefined })
    );
  });

  it('null target → workspace root', async () => {
    await cloneNodeTool({ id: 'doc-1', target_container_id: null }, {}, {});
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ targetContainerId: null })
    );
  });

  it('empty-string target → workspace root', async () => {
    await cloneNodeTool({ id: 'doc-1', target_container_id: '' }, {}, {});
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ targetContainerId: null })
    );
  });

  it('passes sort_order and allow_archived through', async () => {
    await cloneNodeTool({ id: 'doc-1', sort_order: 4, allow_archived: true }, {}, {});
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ sortOrder: 4, allowArchived: true })
    );
  });

  it('throws when id is missing', async () => {
    await expect(cloneNodeTool({}, {}, {})).rejects.toThrow(/`id`.*required/);
    expect(mockCloneNode).not.toHaveBeenCalled();
  });

  it('throws when sort_order is not finite', async () => {
    await expect(cloneNodeTool({ id: 'doc-1', sort_order: NaN }, {}, {})).rejects.toThrow(
      /sort_order/
    );
    expect(mockCloneNode).not.toHaveBeenCalled();
  });
});
