import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const query = jest.fn();
const findByProviderAndModelId = jest.fn();
const getFileSearchScope = jest.fn();

jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query }),
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: (...args: unknown[]) => findByProviderAndModelId(...args) },
}));

jest.mock('@server/services/fileIndexing/index.js', () => ({
  getFileSearchScope: (...args: unknown[]) => getFileSearchScope(...args),
}));

jest.mock('@server/services/embedding/EmbeddingSettings.js', () => ({
  embeddingSettings: {
    getActiveModel: async () => ({ providerId: 'local-onnx', modelId: 'nomic', dimensions: 768 }),
  },
}));

import { getProjectFileEmbeddingCoverage } from '@server/services/embedding/fileEmbeddingCoverage';

beforeEach(() => {
  jest.clearAllMocks();
  findByProviderAndModelId.mockResolvedValue({ id: 'model-active' });
  query.mockResolvedValue({ rows: [{ embedded_files: '7', total_files: '11' }] });
});

describe('getProjectFileEmbeddingCoverage', () => {
  it('counts file rows covered by the active model in the project scope', async () => {
    getFileSearchScope.mockReturnValue({ projectId: 'project-owner', pathPrefix: '' });

    await expect(getProjectFileEmbeddingCoverage('project-owner')).resolves.toEqual({
      embeddedFiles: 7,
      totalFiles: 11,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('fe.model_id = $2'), [
      'project-owner',
      'model-active',
    ]);
  });

  it('scopes an owner subpath relative to the owner root', async () => {
    getFileSearchScope.mockReturnValue({ projectId: 'project-owner', pathPrefix: '' });

    await getProjectFileEmbeddingCoverage('project-owner', './src/search/');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('LEFT(f.relative_path'), [
      'project-owner',
      'model-active',
      'src/search',
    ]);
  });

  it('uses the owner plus subtree prefix for a satellite project', async () => {
    getFileSearchScope.mockReturnValue({
      projectId: 'project-owner',
      pathPrefix: 'apps/server',
    });

    await getProjectFileEmbeddingCoverage('project-satellite');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('LEFT(f.relative_path'), [
      'project-owner',
      'model-active',
      'apps/server',
    ]);
  });

  it('appends a satellite-relative subpath exactly once after the owner prefix', async () => {
    getFileSearchScope.mockReturnValue({
      projectId: 'project-owner',
      pathPrefix: 'apps/server',
    });

    await getProjectFileEmbeddingCoverage('project-satellite', 'src/services');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('LEFT(f.relative_path'), [
      'project-owner',
      'model-active',
      'apps/server/src/services',
    ]);
  });

  it('reports zero covered files when the active model row is unavailable', async () => {
    findByProviderAndModelId.mockResolvedValue(null);
    getFileSearchScope.mockReturnValue(null);
    query.mockResolvedValue({ rows: [{ embedded_files: '0', total_files: '4' }] });

    await expect(getProjectFileEmbeddingCoverage('project-1')).resolves.toEqual({
      embeddedFiles: 0,
      totalFiles: 4,
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), ['project-1', null]);
  });
});
