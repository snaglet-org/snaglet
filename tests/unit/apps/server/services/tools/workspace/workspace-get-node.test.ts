import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks declared before module imports (jest.mock is hoisted).
const mockPoolQuery = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  getDb: jest.fn(() => ({ query: mockPoolQuery })),
}));

jest.mock('@server/services/activeThreadRuns', () => ({
  getThreadActivity: jest.fn(async () => new Map()),
  activeRunMarker: () => '',
}));

import executeGetNode from '@server/services/ToolService/handlers/workspace/getNode';

const NOW = '2026-01-01T00:00:00.000Z';

/** A generic-node row as the tool's join map returns it, with kind columns nulled. */
function nodeRow(overrides: Record<string, unknown>) {
  return {
    id: 'node-1',
    type: 'doc',
    title: null,
    archived: false,
    archived_at: null,
    container_id: null,
    sort_order: 1,
    created_at: NOW,
    updated_at: NOW,
    category: null,
    folder_path: null,
    github_url: null,
    description: null,
    revision: null,
    ...overrides,
  };
}

describe('get_node — generic node', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it('reports revision as null for a node without a revision', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [nodeRow({ id: 'doc-1', type: 'doc', title: 'Notes' })],
    });

    const result = await executeGetNode({ node_id: 'doc-1' });
    expect(result.rawContent.revision).toBeNull();
  });

  it('does not select or return the legacy doc task fields (tasks are table rows)', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [nodeRow({ id: 'doc-1', type: 'doc', title: 'Notes' })],
    });

    const result = await executeGetNode({ node_id: 'doc-1' });
    const sql = String(mockPoolQuery.mock.calls[0][0]);
    for (const field of ['due_at', 'assigned_to', 'priority']) {
      expect(sql).not.toContain(field);
      expect(result.rawContent).not.toHaveProperty(field);
    }
  });
});
