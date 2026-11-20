import { writeFile } from 'fs/promises';
import path from 'path';
import type { ToolHandler } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';

const tool: ToolHandler = async (input, settings, context) => {
  const rawPath = String(input.path ?? '');
  const content = String(input.content ?? '');
  if (!rawPath) throw new Error('path is required');
  const cwd = resolveToolCwd(undefined, context);
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  validatePathConstraint(filePath, settings);
  await writeFile(filePath, content, 'utf-8');
  return `File written: ${filePath} (${content.length} chars)`;
};

export default tool;
