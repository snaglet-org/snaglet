import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

let toolsDir = '';
const findBySource = jest.fn();
const registerToolFolder = jest.fn(async () => undefined);
jest.mock('@server/services/snagletHome', () => ({
  get SNAGLET_TOOLS_DIR() {
    return toolsDir;
  },
}));
jest.mock('@snaglet/db/tables/tools', () => ({ Tools: { findBySource } }));
jest.mock('@server/services/ToolService/customTools/CustomToolScanner', () => ({
  registerToolFolder,
}));

import update from '@server/services/ToolService/handlers/tools/custom-tool-update';

const run = (input: Record<string, unknown>) => update(input, {}, undefined);

beforeEach(async () => {
  jest.clearAllMocks();
  toolsDir = await mkdtemp(path.join(tmpdir(), 'snaglet-custom-tool-update-'));
  const folder = path.join(toolsDir, 'a-tool');
  await mkdir(folder);
  await writeFile(
    path.join(folder, 'definition.json'),
    JSON.stringify({
      name: 'a-tool',
      description: 'old',
      parametersSchema: { type: 'object', properties: { x: { type: 'string' } } },
    })
  );
  await writeFile(path.join(folder, 'tool.ts'), 'export default async () => 1;\n');
  findBySource.mockResolvedValue({ enabled: true });
});
afterEach(() => rm(toolsDir, { recursive: true, force: true }));

describe('custom_tool op update', () => {
  it('changes only what is supplied and re-registers', async () => {
    const out = JSON.parse((await run({ name: 'a-tool', description: 'new' })) as string);
    expect(out).toMatchObject({ updated: true, registered: true, tool_id: 'a_tool' });
    const def = JSON.parse(
      await readFile(path.join(toolsDir, 'a-tool', 'definition.json'), 'utf-8')
    );
    expect(def.description).toBe('new');
    expect(def.parametersSchema.properties.x).toBeDefined();
    expect(await readFile(path.join(toolsDir, 'a-tool', 'tool.ts'), 'utf-8')).toContain('=> 1');
    expect(registerToolFolder).toHaveBeenCalledWith(toolsDir, 'a-tool');
  });

  it('replaces the handler source and keeps the description', async () => {
    await run({ name: 'a-tool', handler_source: 'export default async () => 2;\n' });
    expect(await readFile(path.join(toolsDir, 'a-tool', 'tool.ts'), 'utf-8')).toContain('=> 2');
    const def = JSON.parse(
      await readFile(path.join(toolsDir, 'a-tool', 'definition.json'), 'utf-8')
    );
    expect(def.description).toBe('old');
  });

  it('keeps extra files and every definition key it was not asked to change', async () => {
    const folder = path.join(toolsDir, 'a-tool');
    await writeFile(path.join(folder, 'helpers.ts'), 'export const h = 1;\n');
    await mkdir(path.join(folder, 'data'));
    await writeFile(path.join(folder, 'data', 'notes.md'), 'keep me');
    await writeFile(
      path.join(folder, 'definition.json'),
      JSON.stringify({
        name: 'a-tool',
        description: 'old',
        categoryPath: 'custom/mine',
        keywords: ['report', 'pdf'],
        tier: 'core',
        providerId: 'p1',
        parametersSchema: { type: 'object', properties: {} },
      })
    );
    await run({
      name: 'a-tool',
      description: 'new',
      parameters_schema: { type: 'object', properties: { y: { type: 'number' } } },
      handler_source: 'export default async () => 3;\n',
    });
    const def = JSON.parse(await readFile(path.join(folder, 'definition.json'), 'utf-8'));
    expect(def).toMatchObject({
      description: 'new',
      categoryPath: 'custom/mine',
      keywords: ['report', 'pdf'],
      tier: 'core',
      providerId: 'p1',
      parametersSchema: { type: 'object', properties: { y: { type: 'number' } } },
    });
    expect(await readFile(path.join(folder, 'helpers.ts'), 'utf-8')).toContain('h = 1');
    expect(await readFile(path.join(folder, 'data', 'notes.md'), 'utf-8')).toBe('keep me');
    expect(await readdir(folder)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.tmp$/)])
    );
  });

  it('never creates, and needs something to change', async () => {
    await expect(run({ name: 'missing-tool', description: 'x' })).rejects.toThrow('does not exist');
    await expect(run({ name: 'a-tool' })).rejects.toThrow('at least one');
  });

  it('reports a build failure (tool left disabled by the scanner)', async () => {
    findBySource.mockResolvedValue({ enabled: false });
    await expect(run({ name: 'a-tool', handler_source: 'bad' })).rejects.toThrow('failed to build');
  });
});
