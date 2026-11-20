import { access, readFile, rename, rm, writeFile } from 'fs/promises';
import path from 'path';
import { Tools } from '@snaglet/db/tables/tools';
import { safeJsonParse } from '@snaglet/shared/utils';
import { isRecord } from '@snaglet/shared/utils/type-guards';
import { SNAGLET_TOOLS_DIR } from '@server/services/snagletHome';
import { registerToolFolder } from '@server/services/ToolService/customTools/CustomToolScanner';
import type { ToolHandler } from '@server/services/ToolService/types';

/**
 * custom_tool(op:update): change an existing custom tool's description,
 * parameters_schema and/or tool.ts, keeping whatever is not supplied. It edits
 * in place: supplied fields are merged into the existing definition.json (every
 * other key, such as categoryPath, keywords, tier, providerId, is kept), tool.ts is
 * rewritten only when handler_source is given, and every other file in the
 * folder (helper modules, data, notes) is left alone. Each file is written via
 * a temp-file rename so a crash never leaves a half-written file. The tool is
 * then registered synchronously so a compile failure comes back to the caller.
 * Never creates: an unknown name is an error.
 */
async function replaceFile(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temp, content);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const update: ToolHandler = async (input) => {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new Error('name is required');
  const { description, parameters_schema: schema, handler_source: handlerSource } = input;
  if (description === undefined && schema === undefined && handlerSource === undefined) {
    throw new Error('Pass at least one of description, parameters_schema or handler_source');
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new Error('description must be a string');
  }
  if (schema !== undefined && !isRecord(schema)) {
    throw new Error('parameters_schema must be a JSON object');
  }
  if (handlerSource !== undefined && typeof handlerSource !== 'string') {
    throw new Error('handler_source must be a string');
  }

  const folder = path.join(SNAGLET_TOOLS_DIR, name);
  let existing: Record<string, unknown> | null;
  try {
    existing = safeJsonParse<Record<string, unknown> | null>(
      await readFile(path.join(folder, 'definition.json'), 'utf-8'),
      null
    );
    await access(path.join(folder, 'tool.ts'));
  } catch {
    throw new Error(`Custom tool "${name}" does not exist. Use op "create" to make a new one.`);
  }
  if (!existing) throw new Error(`Custom tool "${name}" has an unreadable definition.json`);

  if (typeof description === 'string' && !description.trim()) {
    throw new Error('description must not be empty');
  }
  if (typeof handlerSource === 'string' && !handlerSource.trim()) {
    throw new Error('handler_source must not be empty when provided');
  }

  const definition: Record<string, unknown> = { ...existing };
  if (typeof description === 'string') definition.description = description.trim();
  if (schema !== undefined) definition.parametersSchema = schema;
  await replaceFile(
    path.join(folder, 'definition.json'),
    `${JSON.stringify(definition, null, 2)}\n`
  );
  if (typeof handlerSource === 'string') {
    await replaceFile(path.join(folder, 'tool.ts'), handlerSource);
  }
  await registerToolFolder(SNAGLET_TOOLS_DIR, name);

  const row = await Tools.findBySource(`workspace:${name}`);
  if (!row?.enabled) {
    throw new Error(
      `Updated ${name}, but it failed to build and is disabled. Check the server log for the TypeScript error, then update it again.`
    );
  }
  return JSON.stringify({
    path: folder,
    tool_id: name.replace(/-/g, '_'),
    updated: true,
    registered: true,
  });
};

export default update;
