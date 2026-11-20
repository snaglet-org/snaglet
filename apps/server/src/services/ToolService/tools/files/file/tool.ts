import type { ToolHandler } from '@server/services/ToolService/types';
import fileRead from '../fileRead';
import fileList from '../fileList';
import fileInfo from '../fileInfo';
import fileWrite from '../fileWrite';
import fileEdit from '../fileEdit';
import filePatch from '../filePatch';
import fileDiff from '../fileDiff';

const present = (value: unknown): boolean => value !== undefined && value !== null;

export type FileUpdateShape = 'edits' | 'patch' | 'content';

/**
 * Which of update's three shapes a call uses. Exactly one is allowed:
 * `edits` (or the single-edit old_text/new_text pair), `patch`, or `content`.
 * Shared with the permission engine so the path guard checks the same paths
 * the handler will write.
 */
export function fileUpdateShape(input: Record<string, unknown>): FileUpdateShape[] {
  const shapes: FileUpdateShape[] = [];
  if (present(input.edits) || present(input.old_text) || present(input.new_text)) {
    shapes.push('edits');
  }
  if (present(input.patch)) shapes.push('patch');
  if (present(input.content)) shapes.push('content');
  return shapes;
}

const update: ToolHandler = async (input, settings, context) => {
  const shapes = fileUpdateShape(input);
  if (shapes.length !== 1) {
    throw new Error(
      shapes.length === 0
        ? 'update needs one of: `edits` (find/replace, preferred), `patch` (*** Begin Patch format, for multi-hunk or multi-file changes), or `content` (full rewrite of `path`).'
        : `update takes exactly one of \`edits\`, \`patch\` or \`content\`; got ${shapes.join(' + ')}.`
    );
  }
  if (shapes[0] === 'patch') {
    // Hand the patch handler only the patch, so a stray `content` is never
    // read as patch text (filePatch falls back to input/content otherwise).
    return filePatch({ patch: input.patch, workdir: input.workdir }, settings, context);
  }
  if (shapes[0] === 'content') return fileWrite(input, settings, context);
  return fileEdit(input, settings, context);
};

/**
 * create writes `content` to `path`, nothing else. Refuse the other write
 * shapes so the path guard and the handler can never disagree about what is
 * written.
 */
const create: ToolHandler = (input, settings, context) => {
  const stray = fileUpdateShape(input).filter((shape) => shape !== 'content');
  if (stray.length > 0) {
    throw new Error(
      `create writes \`content\` to \`path\` and takes no ${stray.map((s) => `\`${s}\``).join(' or ')}; use op:"update" to change an existing file.`
    );
  }
  return fileWrite(input, settings, context);
};

const OPS: Record<string, ToolHandler> = {
  read: fileRead,
  list: fileList,
  info: fileInfo,
  create,
  update,
  diff: fileDiff,
};

/** file(op): read, list, inspect, create, update or diff local files. */
const tool: ToolHandler = async (input, settings, context) => {
  const handler = typeof input.op === 'string' ? OPS[input.op] : undefined;
  if (!handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  return handler(input, settings, context);
};

export default tool;
