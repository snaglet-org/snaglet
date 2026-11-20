/**
 * End-to-end acceptance test for "drop a folder, get a working tool". It writes
 * a tool folder in an OS temp dir (outside the monorepo, so the `@snaglet/sdk`
 * install seam is exercised), drives FolderScanner + tool registration as boot
 * does, and calls the tool through the real ToolExecutor. Also: a malformed
 * folder is skipped without crashing, and removing a folder disables its tool.
 *
 * The test tool imports `@snaglet/sdk` and calls `snaglet.context.get()`, so the esbuild
 * bundle fails if the SDK does not resolve and execute throws if it does not
 * run. `snaglet.context.get()` reads only the injected env; no HTTP server needed.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { getDb } from '@snaglet/db';
import { Tools } from '@snaglet/db/tables/tools';
import { FolderScanner } from '@server/services/FolderScanner';
import {
  registerToolFolder,
  CUSTOM_TOOL_REQUIRED_FILES,
} from '@server/services/ToolService/customTools/CustomToolScanner';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import searchTools from '@server/services/ToolService/handlers/tools/tool-search';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type { ToolRow } from '@snaglet/db/tables/tools';

const TOOL_DEFINITION = {
  name: 'echo-shout',
  description: 'Uppercases the given text (folder-drop smoke tool).',
  categoryPath: 'custom',
  parametersSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  keywords: ['echo', 'test'],
};

// Author contract: default-export handler(input, context). Imports the SDK so
// the build must vendor + bundle @snaglet/sdk to succeed.
const TOOL_SOURCE = `
import snaglet from '@snaglet/sdk';

export default async function handler(input) {
  const text = typeof input?.text === 'string' ? input.text : '';
  const ctx = snaglet.context.get();
  return { shouted: text.toUpperCase(), sawContext: ctx !== null && typeof ctx === 'object' };
}
`;

describe('custom tool folder-drop registration (E2E)', () => {
  let toolsDir: string;

  beforeAll(async () => {
    // OS temp dir → outside the monorepo/pnpm workspace on purpose.
    toolsDir = await mkdtemp(path.join(tmpdir(), 'snaglet-custom-tools-'));
    getDb(); // ensure the per-file embedded DB is open
  });

  afterAll(async () => {
    await rm(toolsDir, { recursive: true, force: true });
  });

  async function writeToolFolder(name: string, definition: unknown, source: string): Promise<void> {
    const dir = path.join(toolsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'definition.json'),
      JSON.stringify(definition, null, 2),
      'utf-8'
    );
    await writeFile(path.join(dir, 'tool.ts'), source, 'utf-8');
  }

  it('required-files contract is definition.json + tool.ts', () => {
    expect([...CUSTOM_TOOL_REQUIRED_FILES]).toEqual(['definition.json', 'tool.ts']);
  });

  it('registers a dropped folder, builds it outside the monorepo, and makes it agent-callable', async () => {
    await writeToolFolder('echo-shout', TOOL_DEFINITION, TOOL_SOURCE);

    // Drive it exactly like boot: reconcile the folder via the generic scanner.
    await registerToolFolder(toolsDir, 'echo-shout');

    // 1. It is registered in the tools table, enabled, as a workspace tool.
    const row = await Tools.findBySource('workspace:echo-shout');
    expect(row).not.toBeNull();
    const tool = row as ToolRow;
    expect(tool.id).toBe('echo_shout');
    expect(tool.enabled).toBe(true);
    expect(tool.type).toBe('external');

    const config = tool.configJson as Record<string, unknown>;
    expect(config.workspace_tool).toBe(true);
    const builtPath = config.built_path as string;
    expect(builtPath.endsWith(path.join('dist', 'tool.cjs'))).toBe(true);

    // 2. The self-contained bundle actually exists on disk.
    const built = await stat(builtPath);
    expect(built.isFile()).toBe(true);

    // 3. It is callable via the real execute path (workspace-tool spawn branch),
    //    with the SDK bundled and running.
    const agentTool: ResolvedAgentTool = {
      agentId: '',
      tool,
      settings: {},
      requiresConfirmation: false,
    };
    const result = await toolExecutor.execute(
      { name: tool.id, input: { text: 'hello world' } },
      agentTool
    );

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as { shouted: string; sawContext: boolean };
    expect(parsed.shouted).toBe('HELLO WORLD');
    expect(parsed.sawContext).toBe(true);

    // 4. Progressive disclosure includes workspace tools just like built-ins.
    // Keyword mode keeps this acceptance path deterministic and exercises the
    // real tools-table query populated by registerToolFolder above.
    const searchResult = await searchTools({ query: 'echo', mode: 'keyword' });
    expect(typeof searchResult).toBe('string');
    const discovered = JSON.parse(searchResult as string) as {
      tools: Array<{ id: string }>;
    };
    expect(discovered.tools.map((entry) => entry.id)).toContain(tool.id);
  }, 60_000);

  it('skips a malformed folder without crashing and never enables it', async () => {
    await mkdir(path.join(toolsDir, 'broken'), { recursive: true });
    await writeFile(path.join(toolsDir, 'broken', 'definition.json'), '{ not valid json ', 'utf-8');
    await writeFile(path.join(toolsDir, 'broken', 'tool.ts'), 'export default () => 1;', 'utf-8');

    // Must resolve (not throw) — the server stays healthy.
    await expect(registerToolFolder(toolsDir, 'broken')).resolves.toBeUndefined();

    const row = await Tools.findBySource('workspace:broken');
    // Either no row was created, or it exists but is not enabled.
    expect(row?.enabled ?? false).toBe(false);
  }, 30_000);

  it('disables a tool when its folder is removed (scanner lifecycle)', async () => {
    // Folder name == definition name so the `workspace:<folder>` source key and
    // the query below line up.
    const dir = path.join(toolsDir, 'ephemeral-tool');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'definition.json'),
      JSON.stringify({ ...TOOL_DEFINITION, name: 'ephemeral-tool' }),
      'utf-8'
    );
    await writeFile(path.join(dir, 'tool.ts'), TOOL_SOURCE, 'utf-8');

    const scanner = new FolderScanner({
      dir: toolsDir,
      kind: 'test',
      requiredFiles: [...CUSTOM_TOOL_REQUIRED_FILES],
      onUpsert: (folder) => registerToolFolder(toolsDir, folder.name),
      onRemove: async (name) => {
        const existing = await Tools.findBySource(`workspace:${name}`);
        if (existing && existing.enabled) await Tools.setEnabled(existing.id, false);
      },
    });

    // First scan registers + enables it.
    await scanner.scan();
    const enabled = await Tools.findBySource('workspace:ephemeral-tool');
    expect(enabled?.enabled).toBe(true);

    // Remove the folder; the next scan on the same instance detects the removal.
    await rm(dir, { recursive: true, force: true });
    await scanner.scan();
    const disabled = await Tools.findBySource('workspace:ephemeral-tool');
    expect(disabled?.enabled).toBe(false);
  }, 60_000);
});
