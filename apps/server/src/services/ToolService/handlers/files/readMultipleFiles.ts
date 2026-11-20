import { readFile } from 'fs/promises';
import { getErrorMessage } from '@snaglet/shared/utils';
import path from 'path';
import type { ToolHandler } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';

const tool: ToolHandler = async (input, settings, context) => {
  const rawPaths = input.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new Error('paths must be a non-empty array');
  }

  const cwd = resolveToolCwd(undefined, context);

  const sections = await Promise.all(
    rawPaths.map(async (raw) => {
      const rawPath = String(raw ?? '');
      try {
        if (!rawPath) throw new Error('empty path');
        const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
        validatePathConstraint(filePath, settings);
        const content = await readFile(filePath, 'utf8');
        return `===== ${filePath} =====\n${content}`;
      } catch (err) {
        const message = getErrorMessage(err);
        return `===== ${rawPath} =====\n[error: ${message}]`;
      }
    })
  );

  return sections.join('\n\n');
};

export default tool;
