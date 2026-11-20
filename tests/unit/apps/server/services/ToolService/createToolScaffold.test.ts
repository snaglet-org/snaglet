import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { stop as stopEsbuild } from 'esbuild';
import { buildToolBundle } from '@server/services/ToolService/customTools/buildToolBundle';
import {
  writeCustomToolScaffold,
  type CreatedToolScaffold,
} from '@server/services/ToolService/handlers/tools/custom-tool-scaffold';

async function executeBuiltTool(
  scaffold: CreatedToolScaffold,
  input: Record<string, unknown>
): Promise<unknown> {
  const builtPath = path.join(scaffold.folderPath, 'dist', 'tool.cjs');
  return new Promise((resolve, reject) => {
    const child = spawn('node', [builtPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `tool exited ${code}`));
      resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify({ input, context: {} }));
  });
}

describe('create_tool scaffold', () => {
  let toolsDir: string;

  beforeEach(async () => {
    toolsDir = await mkdtemp(path.join(tmpdir(), 'snaglet-create-tool-'));
  });

  afterEach(async () => {
    await rm(toolsDir, { recursive: true, force: true });
  });

  it('creates a compiling, invokable no-op tool from name and description', async () => {
    const scaffold = await writeCustomToolScaffold(toolsDir, {
      name: 'hello-world',
      description: 'A generated no-op.',
    });

    expect(scaffold.toolId).toBe('hello_world');
    expect(
      JSON.parse(await readFile(path.join(scaffold.folderPath, 'definition.json'), 'utf8'))
    ).toMatchObject({
      name: 'hello-world',
      description: 'A generated no-op.',
      parametersSchema: { type: 'object', properties: {} },
    });
    expect((await buildToolBundle(scaffold.folderPath)).success).toBe(true);
    await expect(executeBuiltTool(scaffold, { ignored: true })).resolves.toEqual({
      ok: true,
      tool: 'hello-world',
    });
  });

  it('persists a supplied schema and runs the supplied handler', async () => {
    const parametersSchema = {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'number' } },
    };
    const scaffold = await writeCustomToolScaffold(toolsDir, {
      name: 'double-value',
      description: 'Double a number.',
      parametersSchema,
      handlerSource: `export default async function handler(input: Record<string, unknown>) {
  return { doubled: Number(input.value) * 2 };
}\n`,
    });

    const definition = JSON.parse(
      await readFile(path.join(scaffold.folderPath, 'definition.json'), 'utf8')
    );
    expect(definition.parametersSchema).toEqual(parametersSchema);
    expect((await buildToolBundle(scaffold.folderPath)).success).toBe(true);
    await expect(executeBuiltTool(scaffold, { value: 21 })).resolves.toEqual({ doubled: 42 });
  });

  it('rejects an existing tool folder unless overwrite is true', async () => {
    await writeCustomToolScaffold(toolsDir, {
      name: 'collision',
      description: 'Original.',
    });

    await expect(
      writeCustomToolScaffold(toolsDir, {
        name: 'collision',
        description: 'Replacement.',
      })
    ).rejects.toThrow('Pass overwrite: true');

    await writeCustomToolScaffold(toolsDir, {
      name: 'collision',
      description: 'Replacement.',
      overwrite: true,
    });
    const definition = JSON.parse(
      await readFile(path.join(toolsDir, 'collision', 'definition.json'), 'utf8')
    );
    expect(definition.description).toBe('Replacement.');
  });
});

afterAll(() => stopEsbuild());
