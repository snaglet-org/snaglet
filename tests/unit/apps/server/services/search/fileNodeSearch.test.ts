import { beforeEach, describe, expect, it } from '@jest/globals';
import path from 'node:path';

const mockQuery = jest.fn();

jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: mockQuery }),
}));

jest.mock('@server/services/search/nodeSearch', () => ({
  createQueryEmbedding: jest.fn(),
}));

import { resolveAbsoluteFilePathsByNodeIds } from '@server/services/search/fileNodeSearch';

const PROJECT_ROOT = path.resolve('fixture-project');

describe('resolveAbsoluteFilePathsByNodeIds', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns no paths without querying for an empty exclusion set', async () => {
    await expect(resolveAbsoluteFilePathsByNodeIds([])).resolves.toEqual(new Set());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('resolves deterministic unique node IDs to canonical absolute paths', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { folder_path: PROJECT_ROOT, relative_path: 'src/../src/a.ts' },
        { folder_path: PROJECT_ROOT, relative_path: 'src/b.ts' },
      ],
    });

    await expect(
      resolveAbsoluteFilePathsByNodeIds(['file-b', 'file-a', 'file-b', '  '])
    ).resolves.toEqual(
      new Set([path.join(PROJECT_ROOT, 'src', 'a.ts'), path.join(PROJECT_ROOT, 'src', 'b.ts')])
    );
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM public.files f'), [
      ['file-a', 'file-b'],
    ]);
  });

  it('omits rows that have no authoritative project folder', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { folder_path: null, relative_path: 'src/orphan.ts' },
        { folder_path: PROJECT_ROOT, relative_path: 'src/kept.ts' },
      ],
    });

    await expect(resolveAbsoluteFilePathsByNodeIds(['file-a', 'file-b'])).resolves.toEqual(
      new Set([path.join(PROJECT_ROOT, 'src', 'kept.ts')])
    );
  });

  it('rejects relative paths that escape the authoritative project folder', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ folder_path: PROJECT_ROOT, relative_path: '../outside.ts' }],
    });

    await expect(resolveAbsoluteFilePathsByNodeIds(['file-escape'])).resolves.toEqual(new Set());
  });

  it('rejects absolute values stored in the relative-path column', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ folder_path: PROJECT_ROOT, relative_path: path.resolve('fixture-outside.ts') }],
    });

    await expect(resolveAbsoluteFilePathsByNodeIds(['file-absolute'])).resolves.toEqual(new Set());
  });
});
