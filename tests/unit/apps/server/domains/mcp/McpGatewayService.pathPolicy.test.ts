/**
 * External (API-key) MCP callers reach the host filesystem only through
 * snaglet_search kind:"code" / kind:"files". Both are confined to linked project
 * folders on canonical paths (symlinks resolved), Snaglet's own storage is off
 * limits, kind:"database" is denied, and the policy inspects the arguments
 * exactly as the executor will (double-wrap unwrap + param_aliases).
 */

import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';

const getDefinitionMock = jest.fn();
const executeMock = jest.fn();
const findProjectMock = jest.fn();
const listProjectsMock = jest.fn();
const mockHome = { dir: '' };

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    load: jest.fn().mockResolvedValue(undefined),
    getDefinition: (...args: unknown[]) => getDefinitionMock(...args),
    getAllDefinitions: jest.fn().mockReturnValue({}),
  },
}));

jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: { execute: (...args: unknown[]) => executeMock(...args) },
}));

jest.mock('@snaglet/db', () => ({
  Projects: {
    findById: (...args: unknown[]) => findProjectMock(...args),
    listAll: (...args: unknown[]) => listProjectsMock(...args),
  },
}));

jest.mock('@server/services/snagletHome', () => ({
  get SNAGLET_HOME() {
    return mockHome.dir;
  },
}));

jest.mock('@server/realtime/actorContext', () => ({
  runWithActor: (_actor: unknown, operation: () => unknown) => operation(),
}));

import { mcpGatewayService } from '@server/domains/mcp/McpGatewayService';

const CALLER = { memberId: 'member-1', name: 'External test' };

function definition(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    description: id,
    type: 'builtin',
    tier: 'core',
    categoryPath: 'search',
    parameters_schema: {},
    keywords: [],
    ...extra,
  };
}

let base: string;
let projectDir: string;
let outsideDir: string;

beforeEach(async () => {
  jest.clearAllMocks();
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-gw-path-policy-')));
  projectDir = path.join(base, 'project');
  outsideDir = path.join(base, 'outside');
  mockHome.dir = path.join(base, 'snaglet-home');
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await mkdir(path.join(mockHome.dir, 'runtime'), { recursive: true });
  await writeFile(path.join(projectDir, 'src', 'index.ts'), 'export const x = 1;\n');
  await writeFile(path.join(outsideDir, 'id_ed25519'), 'placeholder-key\n');
  await symlink(outsideDir, path.join(projectDir, 'escape'));

  getDefinitionMock.mockImplementation((id: string) => {
    if (id === 'search') return definition('search');
    if (id === 'container') return definition('container');
    return undefined;
  });
  const project = { id: 'project-1', name: 'Test Project', folderPath: projectDir };
  findProjectMock.mockImplementation(async (id: string) => (id === 'project-1' ? project : null));
  listProjectsMock.mockResolvedValue([project]);
  executeMock.mockResolvedValue({ success: true, output: '[]', durationMs: 1 });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  return mcpGatewayService.executeExternalToolCall(name, args, CALLER);
}

function deniedText(result: Awaited<ReturnType<typeof call>>): string {
  expect(result.isError).toBe(true);
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
}

describe('snaglet_search kind:"code" confinement', () => {
  it('denies an absolute path outside every project folder', async () => {
    const result = await call('snaglet_search', { kind: 'code', query: 'key', path: outsideDir });
    expect(deniedText(result)).toMatch(/outside every linked project folder/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('denies a symlink inside the project that points outside it', async () => {
    const result = await call('snaglet_search', {
      kind: 'code',
      query: 'key',
      path: path.join(projectDir, 'escape'),
    });
    expect(deniedText(result)).toMatch(/outside every linked project folder/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('denies a project-relative path that climbs out of the project', async () => {
    const result = await call('snaglet_search', {
      kind: 'code',
      query: 'key',
      project_id: 'project-1',
      path: '../outside',
    });
    expect(deniedText(result)).toMatch(/Denied/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("denies Snaglet's own storage even when a project folder contains it", async () => {
    listProjectsMock.mockResolvedValue([{ id: 'project-2', name: 'Wide', folderPath: base }]);
    const inside = await call('snaglet_search', {
      kind: 'code',
      query: 'token',
      path: path.join(mockHome.dir, 'runtime'),
    });
    expect(deniedText(inside)).toMatch(/Snaglet's own storage/);
    const around = await call('snaglet_search', { kind: 'code', query: 'token', path: base });
    expect(deniedText(around)).toMatch(/contains Snaglet's own storage/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('denies a call with neither project_id nor path (no server-cwd fallback)', async () => {
    const result = await call('snaglet_search', { kind: 'code', query: 'x' });
    expect(deniedText(result)).toMatch(/requires `project_id`/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('denies a double-wrapped call that hides kind:"code" from a shallow check', async () => {
    const result = await call('snaglet_search', {
      function_name: 'search',
      arguments: { kind: 'code', query: 'key', path: outsideDir },
    });
    expect(result.isError).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('allows a path inside the project and pins it to the canonical path', async () => {
    const result = await call('snaglet_search', {
      kind: 'code',
      query: 'x',
      project_id: 'project-1',
      path: 'src',
    });
    expect(result.isError).toBeUndefined();
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [callArg, agentTool] = executeMock.mock.calls[0] as [
      { input: Record<string, unknown> },
      { settings: Record<string, unknown> },
    ];
    expect(callArg.input.path).toBe(path.join(projectDir, 'src'));
    expect(agentTool.settings).toEqual({ root_dir: projectDir });
  });

  it('applies the same confinement through the code_search alias', async () => {
    const result = await call('snaglet_code_search', { query: 'key', path: outsideDir });
    expect(result.isError).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('other gateway-exposed search kinds', () => {
  it('denies kind:"database" (raw table rows are app-local)', async () => {
    const result = await call('snaglet_search', { kind: 'database', table: 'mcp_servers' });
    expect(deniedText(result)).toMatch(/`kind` must be one of all, workspace, docs/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('lets kinds:["entry"] through: the custom tables the table tool already serves', async () => {
    const result = await call('snaglet_search', { kinds: ['entry'], query: 'memories' });
    expect(result.isError).toBeUndefined();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('denies a kind:"files" path that escapes through a symlink', async () => {
    const result = await call('snaglet_search', {
      kind: 'files',
      query: 'key',
      project_id: 'project-1',
      path: 'escape',
    });
    expect(deniedText(result)).toMatch(/must stay inside the project folder/);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('policy sees the executor view of the arguments', () => {
  it('denies a project facet on the old update_container name (resolved to container)', async () => {
    const result = await call('snaglet_update_container', {
      id: 'container-1',
      folder_path: projectDir,
    });
    expect(deniedText(result)).toMatch(/folder_path/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('hands the alias-pinned arguments to the executor when policy allows', async () => {
    // Validating the changeable fields belongs to the container tool for
    // every caller, so the gateway lets the call through with the alias's op
    // pinned (container(op) maps `id` to update's target itself).
    const result = await call('snaglet_update_container', { id: 'container-1', description: 'd' });
    expect(result.isError).toBeUndefined();
    expect(executeMock).toHaveBeenCalledWith(
      {
        name: 'update_container',
        input: { id: 'container-1', description: 'd', op: 'update' },
      },
      expect.anything(),
      {}
    );
  });
});
