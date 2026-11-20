import { beforeEach, describe, expect, it } from '@jest/globals';

const mockPoolQuery = jest.fn();
const mockGetPool = jest.fn(() => ({ query: mockPoolQuery }));

jest.mock('@snaglet/db', () => ({
  getPool: mockGetPool,
  // Tests mock the engine-agnostic getDb() facade.
  getDb: mockGetPool,
}));

const mockResolveContainerByPath = jest.fn();
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveContainerByPath: mockResolveContainerByPath,
}));

import workspaceListRecent from '@server/services/ToolService/handlers/search/listRecent';
import { parseToolResult } from '../../../../../../support/toolHarness';

interface ListRecentResult {
  success: boolean;
  count: number;
  kinds: string[];
  items: Array<{ id: string; link: string }>;
}

const asResult = (out: unknown): ListRecentResult => parseToolResult<ListRecentResult>(out);

function rows(items: unknown[]) {
  mockPoolQuery.mockResolvedValueOnce({ rows: items });
}

describe('workspace_list_recent tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns recently-updated docs by default', async () => {
    rows([
      {
        kind: 'doc',
        id: 'd2',
        title: 'Newer',
        parent_id: 'c1',
        updated_at: '2025-02-01',
        created_at: '2025-01-01',
      },
      {
        kind: 'doc',
        id: 'd1',
        title: 'Older',
        parent_id: null,
        updated_at: '2025-01-01',
        created_at: '2024-12-01',
      },
    ]);

    const out = await workspaceListRecent({}, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.kinds).toEqual(['doc']);
    expect(result.items[0].id).toBe('d2');
    expect(result.items[0].link).toContain('d2');
    // SQL should not include containers branch
    const callSql = String(mockPoolQuery.mock.calls[0][0]);
    expect(callSql).toMatch(/FROM docs/);
    expect(callSql).not.toMatch(/FROM containers/);
  });

  it('respects limit (clamped to MAX=100)', async () => {
    rows([]);
    await workspaceListRecent({ limit: 5 }, {}, {});
    const callArgs = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(callArgs[callArgs.length - 1]).toBe(5);

    rows([]);
    await workspaceListRecent({ limit: 10000 }, {}, {});
    const callArgs2 = mockPoolQuery.mock.calls[1][1] as unknown[];
    expect(callArgs2[callArgs2.length - 1]).toBe(100);
  });

  it('includes containers when kinds=["container"]', async () => {
    rows([
      {
        kind: 'container',
        id: 'c1',
        title: 'Folder',
        parent_id: null,
        updated_at: '2025-02-01',
        created_at: '2025-01-01',
      },
    ]);
    await workspaceListRecent({ kinds: ['container'] }, {}, {});
    const callSql = String(mockPoolQuery.mock.calls[0][0]);
    expect(callSql).toMatch(/FROM containers/);
    expect(callSql).not.toMatch(/FROM docs/);
  });

  it('unions docs + containers when both kinds are requested', async () => {
    rows([]);
    await workspaceListRecent({ kinds: ['doc', 'container'] }, {}, {});
    const callSql = String(mockPoolQuery.mock.calls[0][0]);
    expect(callSql).toMatch(/FROM docs/);
    expect(callSql).toMatch(/FROM containers/);
    expect(callSql).toMatch(/UNION ALL/);
  });

  it('applies since filter (ISO normalized)', async () => {
    rows([]);
    await workspaceListRecent({ since: '2025-01-01T00:00:00Z' }, {}, {});
    const callArgs = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(callArgs).toContain('2025-01-01T00:00:00.000Z');
    expect(String(mockPoolQuery.mock.calls[0][0])).toMatch(/n\.updated_at >= \$/);
  });

  it('throws on invalid since', async () => {
    await expect(workspaceListRecent({ since: 'not-a-date' }, {}, {})).rejects.toThrow(
      /invalid `since`/
    );
  });

  it('throws on invalid kind', async () => {
    await expect(workspaceListRecent({ kinds: ['bogus'] }, {}, {})).rejects.toThrow(/invalid kind/);
  });

  it('throws when both container_id and container_path provided', async () => {
    await expect(
      workspaceListRecent({ container_id: 'c1', container_path: '/x' }, {}, {})
    ).rejects.toThrow(/both/);
  });

  it('scopes by container_id (docs)', async () => {
    rows([]);
    await workspaceListRecent({ container_id: 'c1' }, {}, {});
    const callSql = String(mockPoolQuery.mock.calls[0][0]);
    expect(callSql).toMatch(/n\.container_id = \$/);
    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('c1');
  });

  it('scopes by container_path="/" as root (docs IS NULL)', async () => {
    rows([]);
    await workspaceListRecent({ container_path: '/' }, {}, {});
    expect(mockResolveContainerByPath).not.toHaveBeenCalled();
    const callSql = String(mockPoolQuery.mock.calls[0][0]);
    expect(callSql).toMatch(/n\.container_id IS NULL/);
  });

  it('resolves container_path to id', async () => {
    mockResolveContainerByPath.mockResolvedValueOnce('c-resolved');
    rows([]);
    await workspaceListRecent({ container_path: '/projects' }, {}, {});
    expect(mockResolveContainerByPath).toHaveBeenCalledWith('/projects');
    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('c-resolved');
  });

  it('throws when container_path does not resolve', async () => {
    mockResolveContainerByPath.mockResolvedValueOnce(null);
    await expect(workspaceListRecent({ container_path: '/missing' }, {}, {})).rejects.toThrow(
      /container not found/
    );
  });
});
