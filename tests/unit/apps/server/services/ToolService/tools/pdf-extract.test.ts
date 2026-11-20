import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import pdfExtractTool from '@server/services/ToolService/tools/media/pdf-extract/tool';
import { buildMinimalPdf } from '../../../../../../support/minimalPdf';

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))
  );
});

describe('pdf_extract builtin tool', () => {
  it('uses the shared cross-platform parser for requested pages', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'snaglet-pdf-tool-'));
    folders.push(folder);
    const source = join(folder, 'sample.pdf');
    await writeFile(source, buildMinimalPdf(['first page', 'second page', 'third page']));

    const result = JSON.parse(
      await pdfExtractTool({ source, pages: '3,1', includeMetadata: false }, {})
    ) as {
      pageCount: number;
      selectedPages: number[];
      text: string;
      metadata?: unknown;
    };

    expect(result).toMatchObject({ pageCount: 3, selectedPages: [1, 3] });
    expect(result.text).toContain('first page');
    expect(result.text).toContain('third page');
    expect(result.text).not.toContain('second page');
    expect(result.metadata).toBeUndefined();
  });
});
