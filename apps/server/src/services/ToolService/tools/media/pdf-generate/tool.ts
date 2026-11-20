import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { asNonEmptyString, requireString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFileBuffer } from '@server/services/ToolService/handlers/_shared';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';

function normalizePdfContent(content: string, contentType: string): string {
  if (contentType === 'html') {
    return content
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li)>/gi, '\n')
      .replace(/<li>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return content.trim();
}

const tool: ToolHandler = async (input, settings) => {
  const content = requireString(input, 'content');
  const outputPath = requireString(input, 'outputPath');
  const contentType = asNonEmptyString(input.contentType) ?? 'markdown';
  validatePathConstraint(outputPath, settings);

  const tempDir = await mkdtemp(path.join(tmpdir(), 'snaglet-pdf-generate-'));
  try {
    const sourcePath = path.join(tempDir, 'document.txt');
    await writeFile(sourcePath, normalizePdfContent(content, contentType), 'utf8');

    const result = await runExecFileBuffer('/usr/sbin/cupsfilter', [
      '-m',
      'application/pdf',
      sourcePath,
    ]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `cupsfilter failed with exit code ${result.code}`);
    }

    await writeFile(outputPath, result.stdout);
    return `PDF saved to ${outputPath}`;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

export default tool;
