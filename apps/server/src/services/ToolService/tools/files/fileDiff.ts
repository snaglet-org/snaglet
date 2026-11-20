import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { requireString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { readPathOrLiteral, runExecFile } from '@server/services/ToolService/handlers/_shared';

const tool: ToolHandler = async (input, settings) => {
  const left = requireString(input, 'left');
  const right = requireString(input, 'right');
  const contextLines = Math.max(0, Number(input.contextLines ?? 3) || 3);

  const leftInput = await readPathOrLiteral(left, settings);
  const rightInput = await readPathOrLiteral(right, settings);

  const tempDir = await mkdtemp(path.join(tmpdir(), 'snaglet-diff-'));
  const leftPath = path.join(tempDir, 'left.txt');
  const rightPath = path.join(tempDir, 'right.txt');

  try {
    await writeFile(leftPath, leftInput.value, 'utf8');
    await writeFile(rightPath, rightInput.value, 'utf8');

    const result = await runExecFile('git', [
      'diff',
      '--no-index',
      `--unified=${contextLines}`,
      '--',
      leftPath,
      rightPath,
    ]);

    if (result.code === 0) {
      return 'No differences.';
    }

    if (result.code !== 1) {
      throw new Error(result.stderr.trim() || `git diff failed with exit code ${result.code}`);
    }

    const diff = result.stdout
      .replaceAll(leftPath, leftInput.source === 'path' ? left : 'left')
      .replaceAll(rightPath, rightInput.source === 'path' ? right : 'right')
      .trim();

    return diff || 'Differences detected, but no diff output was produced.';
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

export default tool;
