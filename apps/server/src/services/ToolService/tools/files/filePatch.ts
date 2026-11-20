import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import type { ToolHandler } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';

type FileOp =
  | { kind: 'add'; file: string; lines: string[] }
  | { kind: 'delete'; file: string }
  | { kind: 'update'; file: string; moveTo?: string; chunks: PatchChunk[] };

interface PatchChunk {
  oldText: string;
  newText: string;
}

function resolvePatchPath(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

function readPatch(input: Record<string, unknown>): string {
  const value = input.patch ?? input.input ?? input.content;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('patch is required');
  }
  return value;
}

function parsePatch(patch: string): FileOp[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch') throw new Error('Patch must start with *** Begin Patch');
  const ops: FileOp[] = [];
  let i = 1;

  const parseChangeLines = (): PatchChunk[] => {
    const chunks: PatchChunk[] = [];
    let oldLines: string[] = [];
    let newLines: string[] = [];
    let sawChange = false;

    const flush = () => {
      if (!sawChange) return;
      chunks.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') });
      oldLines = [];
      newLines = [];
      sawChange = false;
    };

    for (let line = lines[i]; line !== undefined; line = lines[i]) {
      if (line === '*** End of File') {
        i++;
        continue;
      }
      if (line.startsWith('*** ') && line !== '*** End of File') break;
      if (line.startsWith('@@')) {
        flush();
        i++;
        continue;
      }

      const prefix = line[0];
      const body = line.slice(1);
      if (prefix === ' ') {
        oldLines.push(body);
        newLines.push(body);
      } else if (prefix === '-') {
        oldLines.push(body);
        sawChange = true;
      } else if (prefix === '+') {
        newLines.push(body);
        sawChange = true;
      } else if (line.length === 0) {
        oldLines.push('');
        newLines.push('');
      } else {
        throw new Error(`Invalid patch line: ${line}`);
      }
      i++;
    }
    flush();
    return chunks;
  };

  for (let line = lines[i]; line !== undefined; line = lines[i]) {
    if (line === '*** End Patch') return ops;

    if (line.startsWith('*** Add File: ')) {
      const file = line.slice('*** Add File: '.length).trim();
      i++;
      const addLines: string[] = [];
      for (let addLine = lines[i]; addLine !== undefined && !addLine.startsWith('*** '); ) {
        if (!addLine.startsWith('+'))
          throw new Error(`Add File lines must start with +: ${addLine}`);
        addLines.push(addLine.slice(1));
        i++;
        addLine = lines[i];
      }
      ops.push({ kind: 'add', file, lines: addLines });
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      ops.push({ kind: 'delete', file: line.slice('*** Delete File: '.length).trim() });
      i++;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const file = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | undefined;
      const next = lines[i];
      if (next?.startsWith('*** Move to: ')) {
        moveTo = next.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks = parseChangeLines();
      ops.push({ kind: 'update', file, moveTo, chunks });
      continue;
    }

    throw new Error(`Unsupported patch header: ${line}`);
  }

  throw new Error('Patch must end with *** End Patch');
}

function replaceOnce(contents: string, oldText: string, newText: string, file: string): string {
  if (oldText.length === 0) return `${contents}${contents.endsWith('\n') ? '' : '\n'}${newText}`;
  const first = contents.indexOf(oldText);
  if (first < 0) throw new Error(`Context not found in ${file}`);
  if (contents.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Context matched more than once in ${file}`);
  }
  return `${contents.slice(0, first)}${newText}${contents.slice(first + oldText.length)}`;
}

const tool: ToolHandler = async (input, settings, context) => {
  const cwd = resolveToolCwd(input.workdir != null ? String(input.workdir) : undefined, context);
  const ops = parsePatch(readPatch(input));
  const changed: string[] = [];

  for (const op of ops) {
    if (op.kind === 'add') {
      const filePath = resolvePatchPath(cwd, op.file);
      validatePathConstraint(filePath, settings);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${op.lines.join('\n')}${op.lines.length > 0 ? '\n' : ''}`, 'utf8');
      changed.push(`added ${op.file}`);
      continue;
    }

    if (op.kind === 'delete') {
      const filePath = resolvePatchPath(cwd, op.file);
      validatePathConstraint(filePath, settings);
      await rm(filePath);
      changed.push(`deleted ${op.file}`);
      continue;
    }

    const filePath = resolvePatchPath(cwd, op.file);
    validatePathConstraint(filePath, settings);
    let contents = await readFile(filePath, 'utf8');
    for (const chunk of op.chunks) {
      contents = replaceOnce(contents, chunk.oldText, chunk.newText, op.file);
    }

    const finalPath = op.moveTo ? resolvePatchPath(cwd, op.moveTo) : filePath;
    validatePathConstraint(finalPath, settings);
    await mkdir(path.dirname(finalPath), { recursive: true });
    await writeFile(finalPath, contents, 'utf8');
    if (op.moveTo && finalPath !== filePath) {
      await rm(filePath);
      changed.push(`updated ${op.file} -> ${op.moveTo}`);
    } else {
      changed.push(`updated ${op.file}`);
    }
  }

  return `Done!\n${changed.join('\n')}`;
};

export default tool;
