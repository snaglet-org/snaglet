import { readFile } from 'fs/promises';
import path from 'path';
import type { ToolHandler } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import viewImage from '@server/services/ToolService/handlers/files/viewImage';
import readMultipleFiles from '@server/services/ToolService/handlers/files/readMultipleFiles';

const tool: ToolHandler = async (input, settings, context) => {
  if (input.mode === 'multiple') {
    return readMultipleFiles(input, settings, context);
  }
  if (input.mode === 'image') {
    return viewImage(input, settings, context);
  }

  const rawPath = String(input.path ?? '');
  if (!rawPath) throw new Error('path is required');
  const cwd = resolveToolCwd(undefined, context);
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  validatePathConstraint(filePath, settings);

  const startRaw = input.start_line;
  const endRaw = input.end_line;

  const content = await readFile(filePath, 'utf-8');

  // Fast path: no slicing requested — preserve original return shape (raw string, no header).
  if (startRaw === undefined && endRaw === undefined) {
    return content;
  }

  const lines = content.split('\n');
  const totalLines = lines.length;

  const start = startRaw === undefined ? 1 : Number(startRaw);
  const end = endRaw === undefined ? totalLines : Number(endRaw);

  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error('start_line and end_line must be integers');
  }
  if (start < 1 || end < 1) {
    throw new Error('start_line and end_line are 1-indexed and must be >= 1');
  }
  if (start > end) {
    throw new Error(`start_line (${start}) must be <= end_line (${end})`);
  }

  // Clamp end to file length; out-of-range start yields empty content with metadata.
  const effectiveStart = Math.min(start, totalLines + 1);
  const effectiveEnd = Math.min(end, totalLines);
  const sliced = effectiveStart > totalLines ? [] : lines.slice(effectiveStart - 1, effectiveEnd);

  const effectiveEndDisplay = Math.max(effectiveStart - 1, effectiveEnd);
  const truncated = effectiveStart > 1 || effectiveEnd < totalLines;
  const header = `[lines ${effectiveStart}-${effectiveEndDisplay} of ${totalLines}${truncated ? ' (truncated)' : ''}]\n`;

  return header + sliced.join('\n');
};

export default tool;
