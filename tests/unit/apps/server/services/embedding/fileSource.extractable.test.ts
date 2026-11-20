/**
 * readEmbeddableFileContent — the indexing read step shared by ingest and the
 * embedding classifier. Text files keep the plain body/hash/size contract;
 * extractable files (PDF) are identified by their raw bytes (the hash ingest
 * stamps and file_embeddings keys on) while the embedded content is the
 * extracted text layer. Failures (no text layer, corrupt bytes, oversize) are
 * per-file skips, never throws.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MAX_EXTRACT_PDF_SOURCE_BYTES,
  clearUnembeddableExtractableCache,
  readEmbeddableFileContent,
} from '@server/services/embedding/fileSource';
import { fileBodyHash } from '@server/services/embedding/contentHash';
import { buildMinimalPdf } from '../../../../../support/minimalPdf';

describe('readEmbeddableFileContent', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'snaglet-file-source-'));
    clearUnembeddableExtractableCache();
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('reads a text file exactly like the legacy body path', async () => {
    const abs = path.join(folder, 'notes.md');
    await writeFile(abs, '# Notes\nbody\n');
    const read = await readEmbeddableFileContent(abs);
    expect(read).toEqual({
      status: 'ok',
      content: '# Notes\nbody\n',
      contentHash: fileBodyHash('# Notes\nbody\n'),
      sizeBytes: Buffer.byteLength('# Notes\nbody\n', 'utf8'),
    });
  });

  it('answers unchanged from the hash without re-reading content semantics', async () => {
    const abs = path.join(folder, 'notes.md');
    await writeFile(abs, 'same body');
    const first = await readEmbeddableFileContent(abs);
    if (first.status !== 'ok') throw new Error('expected ok');
    const second = await readEmbeddableFileContent(abs, { knownHash: first.contentHash });
    expect(second).toEqual({ status: 'unchanged', contentHash: first.contentHash });
  });

  it('extracts a PDF text layer and hashes the raw bytes as the identity', async () => {
    const pdf = buildMinimalPdf(['quarterly revenue findings', 'appendix tables']);
    const abs = path.join(folder, 'report.pdf');
    await writeFile(abs, pdf);

    const read = await readEmbeddableFileContent(abs);
    if (read.status !== 'ok') throw new Error(`expected ok, got ${read.status}`);
    expect(read.content).toContain('quarterly revenue findings');
    expect(read.content).toContain('appendix tables');
    // Identity is the binary file, not the derived text.
    expect(read.contentHash).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(read.contentHash).not.toBe(fileBodyHash(read.content));
    expect(read.sizeBytes).toBe(pdf.length);
  });

  it('skips PDF extraction entirely when the raw hash matches knownHash', async () => {
    const pdf = buildMinimalPdf(['stable page']);
    const abs = path.join(folder, 'stable.pdf');
    await writeFile(abs, pdf);
    const knownHash = createHash('sha256').update(pdf).digest('hex');
    const read = await readEmbeddableFileContent(abs, { knownHash });
    expect(read).toEqual({ status: 'unchanged', contentHash: knownHash });
  });

  it('skips a PDF with no text layer gracefully (and caches the negative)', async () => {
    const abs = path.join(folder, 'scan.pdf');
    await writeFile(abs, buildMinimalPdf([null]));
    expect(await readEmbeddableFileContent(abs)).toEqual({ status: 'skipped' });
    // Second pass (the periodic reconcile) must hit the negative cache, not
    // re-parse — observable as: still skipped, still no throw.
    expect(await readEmbeddableFileContent(abs)).toEqual({ status: 'skipped' });
  });

  it('re-attempts a previously text-less path once the file changes', async () => {
    const abs = path.join(folder, 'evolving.pdf');
    await writeFile(abs, buildMinimalPdf([null]));
    expect(await readEmbeddableFileContent(abs)).toEqual({ status: 'skipped' });

    const withText = buildMinimalPdf(['now it has words']);
    await writeFile(abs, withText);
    // Force a distinct mtime in case the FS clock granularity hides the rewrite.
    const later = new Date(Date.now() + 5_000);
    await utimes(abs, later, later);

    const read = await readEmbeddableFileContent(abs);
    if (read.status !== 'ok') throw new Error(`expected ok, got ${read.status}`);
    expect(read.content).toContain('now it has words');
  });

  it('skips corrupt PDF bytes without throwing', async () => {
    const abs = path.join(folder, 'broken.pdf');
    await writeFile(abs, Buffer.from('%PDF-1.7 but nothing else'));
    expect(await readEmbeddableFileContent(abs)).toEqual({ status: 'skipped' });
  });

  it('skips a PDF over the raw-size cap without reading it into memory', async () => {
    const abs = path.join(folder, 'huge.pdf');
    await writeFile(abs, Buffer.alloc(MAX_EXTRACT_PDF_SOURCE_BYTES + 1));
    expect(await readEmbeddableFileContent(abs)).toEqual({ status: 'skipped' });
  });

  it('skips a missing file', async () => {
    expect(await readEmbeddableFileContent(path.join(folder, 'gone.pdf'))).toEqual({
      status: 'skipped',
    });
  });
});
