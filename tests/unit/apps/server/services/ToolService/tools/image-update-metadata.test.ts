const updateMetadataMock = jest.fn();
const renameMock = jest.fn();
const emitTreeNodeUpdatedMock = jest.fn();

jest.mock('@snaglet/db/tables/images', () => ({
  Images: {
    updateMetadata: (...args: unknown[]) => updateMetadataMock(...args),
    rename: (...args: unknown[]) => renameMock(...args),
  },
}));

jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeUpdated: (...args: unknown[]) => emitTreeNodeUpdatedMock(...args),
}));

import tool from '@server/services/ToolService/tools/media/image-update-metadata/tool';

async function run(input: Record<string, unknown>): Promise<string> {
  const result = await tool(input, {}, undefined);
  if (typeof result !== 'string') throw new Error('expected a plain string tool result');
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('image_update_metadata', () => {
  it('normalizes replacement tags and reports honest indexing state', async () => {
    updateMetadataMock.mockResolvedValue({
      id: 'image-1',
      name: 'reference.png',
      description: 'Coastal reference',
      tags: ['shoreline', 'Tide'],
      updatedAt: '2026-07-20T00:00:00.000Z',
    });

    const output = await run({
      image_id: ' image-1 ',
      description: ' Coastal reference ',
      tags: [' shoreline ', 'shoreline', '', 'Tide'],
    });

    expect(updateMetadataMock).toHaveBeenCalledWith('image-1', {
      description: 'Coastal reference',
      tags: ['shoreline', 'Tide'],
    });
    expect(output).toContain('Keyword metadata is searchable immediately.');
    expect(output).toContain('When metadata changes, stale stored vectors are removed.');
    expect(output).not.toContain('will be re-embedded');
    expect(emitTreeNodeUpdatedMock).toHaveBeenCalledWith({
      id: 'image-1',
      kind: 'image',
      description: 'Coastal reference',
      tags: ['shoreline', 'Tide'],
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
  });

  it('reports vector removal when description and tags are cleared', async () => {
    updateMetadataMock.mockResolvedValue({
      id: 'image-1',
      name: 'reference.png',
      description: null,
      tags: [],
      updatedAt: '2026-07-20T00:01:00.000Z',
    });

    const output = await run({ image_id: 'image-1', description: null, tags: [] });

    expect(output).toContain('Stored vectors were removed because no description or tags remain.');
  });

  it('rejects missing metadata, invalid tags, and unknown images', async () => {
    await expect(run({ image_id: 'image-1' })).rejects.toThrow(/name, description and\/or tags/);
    await expect(run({ image_id: 'image-1', tags: 'shoreline' })).rejects.toThrow(
      /tags must be an array/
    );
    updateMetadataMock.mockResolvedValue(null);
    await expect(run({ image_id: 'missing', tags: [] })).rejects.toThrow(/Image not found/);
  });

  it('renames the image and its file through the model and announces the new title', async () => {
    renameMock.mockResolvedValue({
      status: 'renamed',
      image: {
        id: 'image-1',
        name: 'Harbor at dusk',
        description: null,
        tags: [],
        updatedAt: '2026-07-20T00:02:00.000Z',
      },
    });

    const output = await run({ image_id: 'image-1', name: '  Harbor at dusk ' });

    expect(renameMock).toHaveBeenCalledWith('image-1', 'Harbor at dusk');
    expect(updateMetadataMock).not.toHaveBeenCalled();
    expect(output).toContain('Image updated: Harbor at dusk [image-1]');
    expect(output).toContain('the stored image file now carries the new name');
    expect(emitTreeNodeUpdatedMock).toHaveBeenCalledWith({
      id: 'image-1',
      kind: 'image',
      title: 'Harbor at dusk',
      updatedAt: '2026-07-20T00:02:00.000Z',
    });
  });

  it('renames and replaces metadata in one call', async () => {
    renameMock.mockResolvedValue({
      status: 'renamed',
      image: { id: 'image-1', name: 'Harbor', description: null, tags: [], updatedAt: 't1' },
    });
    updateMetadataMock.mockResolvedValue({
      id: 'image-1',
      name: 'Harbor',
      description: 'Boats',
      tags: [],
      updatedAt: 't2',
    });

    await run({ image_id: 'image-1', name: 'Harbor', description: 'Boats' });

    expect(emitTreeNodeUpdatedMock).toHaveBeenCalledWith({
      id: 'image-1',
      kind: 'image',
      title: 'Harbor',
      description: 'Boats',
      tags: [],
      updatedAt: 't2',
    });
  });

  it('rejects an empty or overlong name and reports unknown images', async () => {
    await expect(run({ image_id: 'image-1', name: '   ' })).rejects.toThrow(/Enter a name/);
    await expect(run({ image_id: 'image-1', name: 'x'.repeat(121) })).rejects.toThrow(
      /at most 120 characters/
    );
    expect(renameMock).not.toHaveBeenCalled();
    renameMock.mockResolvedValue({ status: 'missing' });
    await expect(run({ image_id: 'missing', name: 'Harbor' })).rejects.toThrow(/Image not found/);
  });
});
