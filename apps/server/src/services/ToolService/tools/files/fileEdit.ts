import { readFile, writeFile } from 'fs/promises';
import nodePath from 'path';
import { findAndReplace, getErrorMessage } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';

type Edit = { old_text: string; new_text: string };

function normalizeEdits(input: Record<string, unknown>): Edit[] {
  const { old_text, new_text, edits } = input as {
    old_text?: string;
    new_text?: string;
    edits?: Edit[];
  };

  if (Array.isArray(edits) && edits.length > 0) {
    if (old_text !== undefined || new_text !== undefined) {
      throw new Error(
        'Provide either `edits` (batch) or `old_text`+`new_text` (single), not both.'
      );
    }
    edits.forEach((e, i) => {
      if (!e || typeof e.old_text !== 'string' || typeof e.new_text !== 'string') {
        throw new Error(`edits[${i}] must have string fields old_text and new_text`);
      }
    });
    return edits;
  }

  if (typeof old_text !== 'string' || typeof new_text !== 'string') {
    throw new Error('Must provide either `edits` array or both `old_text` and `new_text` strings.');
  }
  return [{ old_text, new_text }];
}

const handler: ToolHandler = async (input, settings, context) => {
  const rawPath = (input as { path: string }).path;
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error('path is required');
  }
  const cwd = resolveToolCwd(undefined, context);
  const path = nodePath.isAbsolute(rawPath) ? rawPath : nodePath.resolve(cwd, rawPath);
  validatePathConstraint(path, settings);

  const edits = normalizeEdits(input as Record<string, unknown>);

  const original = await readFile(path, 'utf8');
  let contents = original;
  const applied: Array<{ index: number; occurrences: number; old_text_preview: string }> = [];

  for (let i = 0; i < edits.length; i++) {
    const { old_text, new_text } = edits[i];
    try {
      const result = findAndReplace(contents, old_text, new_text);
      contents = result.updated;
      applied.push({
        index: i,
        occurrences: result.occurrences,
        old_text_preview: old_text.length > 60 ? old_text.slice(0, 57) + '...' : old_text,
      });
    } catch (err) {
      const msg = getErrorMessage(err);
      throw new Error(`edits[${i}] failed: ${msg}`);
    }
  }

  if (contents === original) {
    const payload = {
      path,
      edits_applied: 0,
      bytes_written: 0,
      note: 'No changes — replacement text identical to original.',
    };
    return { output: JSON.stringify(payload, null, 2) };
  }

  await writeFile(path, contents, 'utf8');

  const payload = {
    path,
    edits_applied: applied.length,
    bytes_written: Buffer.byteLength(contents, 'utf8'),
    applied,
  };
  return { output: JSON.stringify(payload, null, 2) };
};

export default handler;
