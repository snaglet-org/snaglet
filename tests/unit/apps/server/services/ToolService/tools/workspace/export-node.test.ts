/**
 * export_node — author-facing kind vocabulary.
 *
 * The tool maps its own `kind` enum onto ExportService kinds; a kind missing
 * from KIND_MAP is rejected before any export runs. Pins that `image` is a
 * first-class export kind on both the schema and the map.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runExport = jest.fn();
jest.mock('@server/services/ExportService', () => ({
  runExport: (...args: unknown[]) => runExport(...args),
}));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => ({ actorId: 'member-1', actorKind: 'user', actorName: 'Test User' }),
}));

import handler from '@server/services/ToolService/tools/workspace/export-node/tool';
import definition from '@server/services/ToolService/tools/workspace/export-node/definition';

const DEST = '/Users/test-user/Desktop';

beforeEach(() => {
  jest.clearAllMocks();
  runExport.mockResolvedValue({
    result: {
      kind: 'image',
      id: 'image-1',
      fileName: 'Login shot.png',
      bytes: 120,
      path: `${DEST}/Login shot.png`,
      downloaded: false,
    },
  });
});

describe('export_node — image kind', () => {
  it('advertises image in the kind enum', () => {
    const kind = definition.parameters_schema.properties?.kind as { enum: string[] };
    expect(kind.enum).toContain('image');
  });

  it('maps kind:image onto the service image export and reports the written path', async () => {
    const out = await handler({ kind: 'image', id: 'image-1', dest_dir: DEST }, {}, {});
    const result = JSON.parse(out as string) as Record<string, unknown>;

    expect(runExport).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', id: 'image-1', destDir: DEST })
    );
    expect(result).toMatchObject({
      success: true,
      kind: 'image',
      id: 'image-1',
      file_name: 'Login shot.png',
      path: `${DEST}/Login shot.png`,
    });
  });

  it('requires an id for an image export', async () => {
    await expect(handler({ kind: 'image', dest_dir: DEST }, {}, {})).rejects.toThrow(
      /id is required/
    );
    expect(runExport).not.toHaveBeenCalled();
  });
});
