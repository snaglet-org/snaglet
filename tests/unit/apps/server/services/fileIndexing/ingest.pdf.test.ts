/**
 * ingestFile × PDFs — the discovery→read→row flow for the extractable class:
 * a text-bearing PDF ingests with the raw-bytes hash and raw size; a user's
 * `ignoreFileTypes: ["pdf"]` still wins; an unchanged PDF is a hash-shortcut
 * no-op; text-less and corrupt PDFs skip without throwing.
 */

import { afterEach, beforeEach, describe, expect, jest, it } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { buildMinimalPdf } from '../../../../../support/minimalPdf';

const byProjectAndPath = jest.fn<() => Promise<{ contentHash: string } | null>>();
const upsertByPath = jest.fn<() => Promise<Record<string, unknown>>>();
jest.mock('@snaglet/db/tables/files', () => ({
  Files: {
    byProjectAndPath: (...args: unknown[]) =>
      byProjectAndPath(...(args as Parameters<typeof byProjectAndPath>)),
    upsertByPath: (...args: unknown[]) =>
      upsertByPath(...(args as Parameters<typeof upsertByPath>)),
  },
}));

const emitFileEmbeddingCoverageChanged = jest.fn();
jest.mock('@server/realtime/surfaces/fileEmbeddings', () => ({
  emitFileEmbeddingCoverageChanged: () => emitFileEmbeddingCoverageChanged(),
}));

import { ingestFile } from '@server/services/fileIndexing/ingest';
import { compileIgnoreRules } from '@server/services/fileIndexing/exclusions';
import { clearUnembeddableExtractableCache } from '@server/services/embedding/fileSource';

function projectFor(folderPath: string): ProjectRow {
  return {
    id: 'project-1',
    name: 'P',
    githubUrl: null,
    folderPath,
    containerId: 'project-1',
    description: null,
    fileIndexingEnabled: true,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ingestFile — extractable PDFs', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'snaglet-ingest-pdf-'));
    jest.clearAllMocks();
    byProjectAndPath.mockResolvedValue(null);
    upsertByPath.mockResolvedValue({});
    clearUnembeddableExtractableCache();
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('upserts a text-bearing PDF with the raw-bytes hash and raw size', async () => {
    const pdf = buildMinimalPdf(['searchable pdf body']);
    await writeFile(path.join(folder, 'report.pdf'), pdf);

    const status = await ingestFile(projectFor(folder), 'report.pdf');

    expect(status).toBe('upserted');
    expect(upsertByPath).toHaveBeenCalledTimes(1);
    expect(upsertByPath).toHaveBeenCalledWith({
      projectId: 'project-1',
      relativePath: 'report.pdf',
      contentHash: createHash('sha256').update(pdf).digest('hex'),
      sizeBytes: pdf.length,
      containerId: 'project-1',
    });
    expect(emitFileEmbeddingCoverageChanged).toHaveBeenCalled();
  });

  it("respects the user's ignoreFileTypes: ['pdf'] before touching disk", async () => {
    const pdf = buildMinimalPdf(['should never be read']);
    await writeFile(path.join(folder, 'report.pdf'), pdf);
    const rules = compileIgnoreRules({ ignoreFileTypes: ['pdf'] });

    const status = await ingestFile(projectFor(folder), 'report.pdf', rules);

    expect(status).toBe('excluded');
    expect(byProjectAndPath).not.toHaveBeenCalled();
    expect(upsertByPath).not.toHaveBeenCalled();
  });

  it('answers unchanged from the stored hash without re-upserting', async () => {
    const pdf = buildMinimalPdf(['stable content']);
    await writeFile(path.join(folder, 'report.pdf'), pdf);
    byProjectAndPath.mockResolvedValue({
      contentHash: createHash('sha256').update(pdf).digest('hex'),
    });

    const status = await ingestFile(projectFor(folder), 'report.pdf');

    expect(status).toBe('unchanged');
    expect(upsertByPath).not.toHaveBeenCalled();
  });

  it('skips a PDF with no text layer without creating a row', async () => {
    await writeFile(path.join(folder, 'scan.pdf'), buildMinimalPdf([null]));
    const status = await ingestFile(projectFor(folder), 'scan.pdf');
    expect(status).toBe('skipped');
    expect(upsertByPath).not.toHaveBeenCalled();
  });

  it('treats a corrupt PDF as a per-file skip, not a batch failure', async () => {
    await writeFile(path.join(folder, 'broken.pdf'), Buffer.from('%PDF-1.4 truncated garbage'));
    const status = await ingestFile(projectFor(folder), 'broken.pdf');
    expect(status).toBe('skipped');
    expect(upsertByPath).not.toHaveBeenCalled();
  });

  it('still ingests plain text files with the utf-8 body contract', async () => {
    await writeFile(path.join(folder, 'readme.md'), '# Title\n');
    const status = await ingestFile(projectFor(folder), 'readme.md');
    expect(status).toBe('upserted');
    expect(upsertByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'readme.md',
        contentHash: createHash('sha256').update('# Title\n').digest('hex'),
        sizeBytes: Buffer.byteLength('# Title\n', 'utf8'),
      })
    );
  });
});
