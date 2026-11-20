import { stat } from 'fs/promises';
import path from 'path';
import type { ToolHandler } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';

const tool: ToolHandler = async (input, settings, context) => {
  const rawPath = String(input.path ?? '');
  if (!rawPath) throw new Error('path is required');
  const cwd = resolveToolCwd(undefined, context);
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  validatePathConstraint(filePath, settings);

  const stats = await stat(filePath);
  const type = stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file';

  const info = {
    path: filePath,
    type,
    size: stats.size,
    created: stats.birthtime.toISOString(),
    modified: stats.mtime.toISOString(),
    accessed: stats.atime.toISOString(),
    mode: '0' + (stats.mode & 0o777).toString(8),
  };

  return [
    `path: ${info.path}`,
    `type: ${info.type}`,
    `size: ${info.size} bytes`,
    `created: ${info.created}`,
    `modified: ${info.modified}`,
    `accessed: ${info.accessed}`,
    `mode: ${info.mode}`,
  ].join('\n');
};

export default tool;
