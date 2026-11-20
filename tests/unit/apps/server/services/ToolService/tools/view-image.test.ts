/**
 * file_read image-mode tests — the merged image-viewer route.
 *
 *   - `id` branch: returns inline image + no filesystem path in the text
 *   - `path` branch: delegates to file-read-image/tool.ts unchanged
 *   - exactly-one-of validation (both / neither is an error)
 *   - param_aliases wiring: agent-facing `id` resolves to the handler's
 *     internal `image_id` key
 *   - registry sweep: no standalone workspace_get_image tool remains
 */

const findImageByIdMock = jest.fn();
jest.mock('@snaglet/db/tables/images', () => ({
  Images: { findImageById: (...args: unknown[]) => findImageByIdMock(...args) },
  // Blob-path helpers view_image uses to name the concrete on-disk file in its
  // actionable fallback note. Deterministic in test so assertions can match it.
  imageBlobPath: (key: string) => `/snaglet-home/images/${key}`,
  storageKeyFor: (id: string, mime: string) =>
    `${id}.${mime.toLowerCase().includes('svg') ? 'svg' : (mime.split('/')[1] ?? 'bin')}`,
}));

const fileReadImageMock = jest.fn();
jest.mock('@server/services/ToolService/handlers/files/fileReadImage', () => ({
  __esModule: true,
  default: (...args: unknown[]) => fileReadImageMock(...args),
}));

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import tool from '@server/services/ToolService/tools/files/fileRead';
import definition from '@server/services/ToolService/tools/files/file/definition';
import { normalizeToolParams } from '@server/services/ToolService/lib/normalizeToolParams';
import type { ToolHandlerRichResult } from '@server/services/ToolService/types';

async function run(input: Record<string, unknown>): Promise<ToolHandlerRichResult> {
  const result = await tool({ mode: 'image', ...input }, {}, undefined);
  if (typeof result === 'string') throw new Error('expected rich result, got a plain string');
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('file_read mode=image — id branch', () => {
  it('attaches raster bytes inline and names the on-disk file in an actionable fallback note', async () => {
    findImageByIdMock.mockResolvedValue({
      id: 'image-abc123',
      name: 'screenshot.png',
      description: null,
      tags: ['tool-capture'],
      containerId: null,
      mimeType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      sizeBytes: 4096,
      createdAt: '2026-07-01T00:00:00Z',
    });

    const result = await run({ image_id: 'image-abc123' });

    // png attaches its bytes as an inline image block.
    const raw = result.rawContent as { inlineImageIds?: string[] };
    expect(raw.inlineImageIds).toEqual(['image-abc123']);
    expect(result.output).toContain('image-abc123');
    // The fallback note is actionable — it names the concrete on-disk file to
    // read — and does not emit the file-read-image "- path:" metadata line.
    expect(result.output).toContain('/snaglet-home/images/image-abc123.png');
    expect(result.output).not.toContain('- path:');
    expect(result.output).not.toContain('rely on the metadata above');
    expect(fileReadImageMock).not.toHaveBeenCalled();
  });

  it('names a renamed image file by its stored key', async () => {
    findImageByIdMock.mockResolvedValue({
      id: 'image-abc123',
      name: 'Sunset',
      description: null,
      tags: [],
      containerId: null,
      mimeType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      storageKey: 'Sunset-image-abc123.png',
      sizeBytes: 4,
      createdAt: '2026-07-01T00:00:00Z',
    });

    const result = await run({ image_id: 'image-abc123' });

    expect(result.output).toContain('/snaglet-home/images/Sunset-image-abc123.png');
  });

  it('inlines the raw SVG source (not metadata-only) and names the on-disk file', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>';
    findImageByIdMock.mockResolvedValue({
      id: 'image-svg-1',
      name: 'happy-face.svg',
      description: null,
      tags: [],
      containerId: null,
      mimeType: 'image/svg+xml',
      data: Buffer.from(svg, 'utf8'),
      sizeBytes: svg.length,
      createdAt: '2026-07-01T00:00:00Z',
    });

    const result = await run({ image_id: 'image-svg-1' });

    // The raw markup is inlined so the model can read it, rather than SVG
    // degrading to metadata only.
    expect(result.output).toContain('## Source');
    expect(result.output).toContain('<svg');
    expect(result.output).toContain('<circle');
    // No image block attached — the provider can't render SVG as an inline image.
    expect(result.rawContent).toBeUndefined();
    // Fallback note names the concrete on-disk file to read.
    expect(result.output).toContain('/snaglet-home/images/image-svg-1.svg');
  });

  it('truncates a very large SVG and points at the full file', async () => {
    const huge = `<svg>${'x'.repeat(30_000)}</svg>`;
    findImageByIdMock.mockResolvedValue({
      id: 'image-svg-2',
      name: 'big.svg',
      description: null,
      tags: [],
      containerId: null,
      mimeType: 'image/svg+xml',
      data: Buffer.from(huge, 'utf8'),
      sizeBytes: huge.length,
      createdAt: '2026-07-01T00:00:00Z',
    });

    const result = await run({ image_id: 'image-svg-2' });

    expect(result.output).toContain('truncated');
    expect(result.output).toContain('/snaglet-home/images/image-svg-2.svg');
    expect(result.output.length).toBeLessThan(huge.length);
    expect(result.rawContent).toBeUndefined();
  });

  it('reports a clear not-found message for an unknown id', async () => {
    findImageByIdMock.mockResolvedValue(null);
    const result = await run({ image_id: 'image-missing' });
    expect(result.output).toContain('no workspace image found');
    expect(result.rawContent).toBeUndefined();
  });
});

describe('file_read mode=image — path branch (delegates to file-read-image)', () => {
  it('delegates path calls to file-read-image/tool.ts verbatim', async () => {
    fileReadImageMock.mockResolvedValue({
      output: '# screenshot.png',
      rawContent: { inlineImageIds: ['image-xyz'] },
    });

    const input = { mode: 'image', path: '/Users/me/Desktop/screenshot.png' };
    const settings = { some: 'setting' };
    const context = { threadId: 't1' };
    const result = await tool(input, settings, context as never);

    expect(fileReadImageMock).toHaveBeenCalledWith(input, settings, context);
    expect(result).toEqual({
      output: '# screenshot.png',
      rawContent: { inlineImageIds: ['image-xyz'] },
    });
    expect(findImageByIdMock).not.toHaveBeenCalled();
  });

  it('wraps a plain-string delegate result in a rich result', async () => {
    fileReadImageMock.mockResolvedValue('plain text result');
    const result = await run({ path: '/tmp/x.png' });
    expect(result).toEqual({ output: 'plain text result' });
  });
});

describe('file_read mode=image — exactly-one-of validation', () => {
  it('rejects when both path and id are given', async () => {
    await expect(run({ path: '/tmp/x.png', image_id: 'image-1' })).rejects.toThrow(
      /exactly one of `path` or `id`/
    );
    expect(fileReadImageMock).not.toHaveBeenCalled();
    expect(findImageByIdMock).not.toHaveBeenCalled();
  });

  it('rejects when neither path nor id is given', async () => {
    await expect(run({})).rejects.toThrow(/provide exactly one of/);
  });
});

describe('file_read mode=image — param_aliases wiring', () => {
  it('declares param_aliases so an agent-facing `id` resolves to the handler-internal `image_id`', () => {
    const normalized = normalizeToolParams({ id: 'image-abc' }, definition.param_aliases);
    expect(normalized).toEqual({ id: 'image-abc', image_id: 'image-abc' });
  });

  it('leaves an explicit image_id untouched (never overwritten by id)', () => {
    const normalized = normalizeToolParams(
      { id: 'image-new', image_id: 'image-legacy' },
      definition.param_aliases
    );
    expect(normalized.image_id).toBe('image-legacy');
  });
});

describe('registry sweep — image tools absorbed into file(op:read)', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');
  const GENERATED_REGISTRY = path.join(
    REPO_ROOT,
    'apps/server/src/services/ToolService/generated/registry-source.static.ts'
  );

  it('the standalone workspace_get_image tool folder is gone', () => {
    const removedPath = path.join(
      REPO_ROOT,
      'apps/server/src/services/ToolService/tools/workspace/workspace-get-image'
    );
    expect(existsSync(removedPath)).toBe(false);
  });

  it('the generated registry lists only file for image viewing', () => {
    const src = readFileSync(GENERATED_REGISTRY, 'utf8');
    expect(src).not.toContain('"workspace_get_image"');
    expect(src).not.toContain('"view_image"');
    expect(src).not.toContain('"file_read_image"');
    expect(src).not.toContain('"file_read"');
    expect(src).toContain('"file"');
  });

  it('file exposes image mode and the handler id alias', () => {
    const schema = definition.parameters_schema as {
      properties: { mode: { enum: string[] } };
    };
    expect(schema.properties.mode.enum).toContain('image');
    expect(definition.param_aliases).toEqual({ image_id: ['id'] });
  });
});
