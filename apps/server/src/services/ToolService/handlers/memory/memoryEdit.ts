import { resolveMemoryOwner } from '@server/services/ToolService/ToolValidation';
import type { ToolHandler } from '@server/services/ToolService/types';
import { memoryService, type MemoryEdit } from '@server/services/MemoryService';
import { asTrimmedString } from '@snaglet/shared/utils';

const MODES = ['overwrite', 'append', 'replace'] as const;
type Mode = (typeof MODES)[number];

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** Raw string read — unlike asTrimmedString, '' survives (a valid replace_with). */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Turn the agent-facing params into the service's MemoryEdit. Every mode's
 * requirements fail here, before any lookup, so a malformed call never touches
 * the store.
 */
function buildEdit(mode: Mode, input: Record<string, unknown>): MemoryEdit {
  if (mode === 'replace') {
    const find = readString(input.find);
    if (!find) {
      throw new Error(
        'replace mode requires a non-empty `find` string — the literal text to look for in the memory.'
      );
    }
    const replaceWith = readString(input.replace_with);
    if (replaceWith === undefined) {
      throw new Error(
        'replace mode requires `replace_with` — pass "" to delete the found text outright.'
      );
    }
    return { mode, find, replaceWith, all: input.all === true };
  }

  const content = readString(input.content);
  if (!content?.trim()) throw new Error(`${mode} mode requires non-empty \`content\`.`);
  if (mode === 'append') {
    const separator = readString(input.separator);
    return separator === undefined ? { mode, content } : { mode, content, separator };
  }
  return { mode, content };
}

const tool: ToolHandler = async (input, _settings, context) => {
  // Exactly one target, mirroring the owner resolution's discipline: guessing
  // between two selectors is how you edit the wrong memory.
  const memoryId = asTrimmedString(input.memory_id);
  const key = asTrimmedString(input.key);
  if (memoryId && key) {
    throw new Error('memory update targets one memory: pass memory_id or key, not both.');
  }
  if (!memoryId && !key) {
    throw new Error('memory update requires one of memory_id or key.');
  }

  const mode = input.mode;
  if (!isMode(mode)) {
    throw new Error(`mode is required and must be one of ${MODES.join(' | ')}.`);
  }
  const edit = buildEdit(mode, input);

  const owner = await resolveMemoryOwner(context, 'memory (update)');
  const result = await memoryService.edit({ ...owner, memoryId, key, edit });

  switch (result.status) {
    case 'updated':
      return `Memory updated: '${result.key ?? result.id}' (id: ${result.id})\n\n${result.content}`;
    case 'not_found':
      // Also the answer when the memory belongs to someone else — update
      // never reaches outside its own owner.
      return `No matching memory: ${
        memoryId ? `id '${memoryId}'` : `key '${key}'`
      } did not resolve to one of your memories. Nothing was changed — update only changes memories you already have; use memory op "create" to make one.`;
    case 'find_absent':
      throw new Error(
        `replace failed: '${edit.mode === 'replace' ? edit.find : ''}' does not appear in that memory's content. Nothing was changed — read the memory first (memory op "search") and match its text exactly.`
      );
    case 'would_blank':
      throw new Error(
        'That edit would leave the memory empty. Nothing was changed — use memory op "delete" to delete a memory outright.'
      );
  }
};

export default tool;
