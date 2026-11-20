import { stat } from 'fs/promises';
import path from 'path';
import type { ToolHandler } from '@server/services/ToolService/types';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';

function expandHome(p: string): string {
  if (p === '~') return process.env.HOME ?? p;
  if (p.startsWith('~/')) {
    const home = process.env.HOME ?? '';
    if (!home) return p;
    return path.join(home, p.slice(2));
  }
  return p;
}

const tool: ToolHandler = async (input, _settings, context) => {
  const rawPath = String(input.path ?? '');
  if (!rawPath) {
    throw new Error('Missing required parameter: path');
  }

  const basePathInput = String(input.basePath ?? resolveToolCwd(undefined, context));
  const basePath = path.resolve(expandHome(basePathInput));
  const expanded = expandHome(rawPath);
  const absolutePath = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(basePath, expanded);

  let exists = false;
  let kind: 'file' | 'directory' | 'missing' = 'missing';
  try {
    const st = await stat(absolutePath);
    exists = true;
    kind = st.isDirectory() ? 'directory' : 'file';
  } catch {
    exists = false;
    kind = 'missing';
  }

  return JSON.stringify(
    {
      inputPath: rawPath,
      basePath,
      absolutePath,
      exists,
      kind,
      parentDirectory: path.dirname(absolutePath),
    },
    null,
    2
  );
};

export default tool;
