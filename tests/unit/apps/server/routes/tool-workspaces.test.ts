/**
 * /api/tools/workspaces — path-traversal defense at the HTTP boundary: a real
 * supertest request whose encoded %2f decodes to `../` inside the route
 * param, and an adversarial PUT body key. Neither reaches the DB on those
 * inputs (updateFiles throws its 400 before syncDefinitionToDb runs), so
 * `syncDefinitionToDb` is stubbed and TOOL_WORKSPACES_DIR points at a temp
 * dir set before the router import. The last block pins the tool row the save
 * routes answer with against the one GET /api/tools/:id returns.
 */
import request from 'supertest';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

jest.mock('@server/domains/tools/routes/helpers', () => ({
  ...jest.requireActual('@server/domains/tools/routes/helpers'),
  syncDefinitionToDb: jest.fn(async () => ({ id: 'stub', name: 'stub' })),
}));
jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { findBySource: jest.fn(async () => null), findById: jest.fn(async () => null) },
}));
// Custom tools have no definition.ts, so the registry knows none of them.
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn(async () => undefined),
    getDefinition: jest.fn(() => undefined),
    getToolIds: jest.fn(() => []),
  },
}));
jest.mock('@server/services/ToolService/customTools/CustomToolScanner', () => ({
  withCustomToolUpsert: jest.fn(
    async (
      _folderName: string,
      mutation: (checkpoint: () => Promise<() => void>) => Promise<unknown>
    ) => mutation(async () => () => undefined)
  ),
  withCustomToolRemove: jest.fn(async (_folderName: string, mutation: () => Promise<unknown>) =>
    mutation()
  ),
}));

const TOOL_TS = 'export default async function handler(input) {\n  return input;\n}\n';

let workspacesDir: string;

async function buildApp(): Promise<express.Application> {
  const workspacesRouter = (await import('@server/domains/tools/routes/workspaces.routes')).default;
  const { errorHandler } = await import('@server/middleware');
  const app = express();
  app.use(express.json());
  app.use('/api/tools', workspacesRouter);
  app.use(errorHandler);
  return app;
}

beforeAll(async () => {
  workspacesDir = await mkdtemp(path.join(tmpdir(), 'snaglet-tool-ws-routes-'));
  process.env.TOOL_WORKSPACES_DIR = workspacesDir;
  await mkdir(path.join(workspacesDir, 'my-tool'), { recursive: true });
  await writeFile(path.join(workspacesDir, 'my-tool', 'tool.ts'), TOOL_TS, 'utf-8');
});

afterAll(async () => {
  delete process.env.TOOL_WORKSPACES_DIR;
  await rm(workspacesDir, { recursive: true, force: true });
});

describe('GET /api/tools/workspaces/:toolId/files/:fileName — traversal defense', () => {
  it('returns tool.ts content for the legitimate whitelisted path', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/tools/workspaces/my-tool/files/tool.ts');
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe(TOOL_TS);
  });

  it('rejects an encoded %2f traversal (decodes to ../ in the param) with a 400 — no file read', async () => {
    const app = await buildApp();
    const encoded = encodeURIComponent('../../../../etc/passwd');
    const res = await request(app).get(`/api/tools/workspaces/my-tool/files/${encoded}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/root:.*:0:0:/);
  });

  it('rejects a non-whitelisted file name (e.g. package.json) with a 400', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/tools/workspaces/my-tool/files/package.json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /api/tools/workspaces/:toolId/files — traversal defense', () => {
  it('400s an adversarial body key that escapes the sandbox, and writes nothing', async () => {
    const app = await buildApp();
    const canary = path.join(workspacesDir, '..', 'snaglet-tool-route-escape-canary.txt');
    await rm(canary, { force: true });

    const res = await request(app)
      .put('/api/tools/workspaces/my-tool/files')
      .send({ '../../../../snaglet-tool-route-escape-canary.txt': 'pwned' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(existsSync(canary)).toBe(false);
    // Legitimate tool.ts untouched.
    const getRes = await request(app).get('/api/tools/workspaces/my-tool/files/tool.ts');
    expect(getRes.body.data.content).toBe(TOOL_TS);
  });

  it('still accepts a legitimate tool.ts update', async () => {
    const app = await buildApp();
    const updated = 'export default async () => 99;\n';
    const putRes = await request(app)
      .put('/api/tools/workspaces/my-tool/files')
      .send({ 'tool.ts': updated });
    expect(putRes.status).toBe(200);
    const getRes = await request(app).get('/api/tools/workspaces/my-tool/files/tool.ts');
    expect(getRes.body.data.content).toBe(updated);
  });
});

describe('workspace routes coordinate with the custom-tool scanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('owns create through the draft DB sync', async () => {
    const app = await buildApp();
    const scanner = await import('@server/services/ToolService/customTools/CustomToolScanner');
    const helpers = await import('@server/domains/tools/routes/helpers');
    const res = await request(app)
      .post('/api/tools/workspaces')
      .send({
        toolId: 'new-tool',
        files: {
          'definition.json': JSON.stringify({ name: 'new-tool' }),
          'tool.ts': TOOL_TS,
          'TOOL.md': '# New tool',
        },
      });

    expect(res.status).toBe(201);
    expect(scanner.withCustomToolUpsert).toHaveBeenCalledTimes(1);
    expect(scanner.withCustomToolUpsert).toHaveBeenCalledWith('new-tool', expect.any(Function));
    expect(helpers.syncDefinitionToDb).toHaveBeenCalledTimes(1);
  });

  it('rejects a noncanonical tool id instead of aliasing it onto another folder', async () => {
    const app = await buildApp();
    const scanner = await import('@server/services/ToolService/customTools/CustomToolScanner');
    const helpers = await import('@server/domains/tools/routes/helpers');
    const res = await request(app)
      .post('/api/tools/workspaces')
      .send({
        toolId: 'aliased-tool!',
        files: {
          'definition.json': JSON.stringify({ name: 'aliased-tool' }),
          'tool.ts': TOOL_TS,
          'TOOL.md': '# Aliased tool',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(scanner.withCustomToolUpsert).not.toHaveBeenCalled();
    expect(helpers.syncDefinitionToDb).not.toHaveBeenCalled();
    expect(existsSync(path.join(workspacesDir, 'aliased-tool'))).toBe(false);
  });

  it('owns a tool.ts-only update even though it does not sync metadata', async () => {
    const app = await buildApp();
    const scanner = await import('@server/services/ToolService/customTools/CustomToolScanner');
    const helpers = await import('@server/domains/tools/routes/helpers');
    const res = await request(app)
      .put('/api/tools/workspaces/my-tool/files')
      .send({ 'tool.ts': 'export default async () => 12345;\n' });

    expect(res.status).toBe(200);
    expect(scanner.withCustomToolUpsert).toHaveBeenCalledTimes(1);
    expect(helpers.syncDefinitionToDb).not.toHaveBeenCalled();
  });

  it('owns one deploy build and one activation sync', async () => {
    const app = await buildApp();
    const scanner = await import('@server/services/ToolService/customTools/CustomToolScanner');
    const helpers = await import('@server/domains/tools/routes/helpers');
    const { toolWorkspaceService } =
      await import('@server/services/ToolService/ToolWorkspaceService');
    jest
      .spyOn(toolWorkspaceService, 'install')
      .mockResolvedValue({ success: true, output: '', durationMs: 1 });
    const build = jest
      .spyOn(toolWorkspaceService, 'build')
      .mockResolvedValue({ success: true, output: '', durationMs: 2 });
    jest
      .spyOn(toolWorkspaceService, 'readFile')
      .mockReturnValue(JSON.stringify({ name: 'my-tool' }));
    jest.spyOn(toolWorkspaceService, 'getInfo').mockReturnValue({
      toolId: 'my-tool',
      dir: path.join(workspacesDir, 'my-tool'),
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: { name: 'my-tool' },
    });
    jest
      .spyOn(toolWorkspaceService, 'getBuiltToolPath')
      .mockReturnValue(path.join(workspacesDir, 'my-tool', 'dist', 'tool.cjs'));

    const res = await request(app).post('/api/tools/workspaces/my-tool/deploy');

    expect(res.status).toBe(200);
    expect(scanner.withCustomToolUpsert).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(helpers.syncDefinitionToDb).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it('serializes delete but leaves removal to the scanner bridge', async () => {
    const app = await buildApp();
    const scanner = await import('@server/services/ToolService/customTools/CustomToolScanner');
    const folder = path.join(workspacesDir, 'delete-me');
    await mkdir(folder, { recursive: true });

    const res = await request(app).delete('/api/tools/workspaces/delete-me');

    expect(res.status).toBe(200);
    expect(scanner.withCustomToolRemove).toHaveBeenCalledTimes(1);
    expect(existsSync(folder)).toBe(false);
  });
});

describe('workspace routes answer with the tool as the tool routes show it', () => {
  /** A fresh custom tool's `tools` row as syncDefinitionToDb writes it. */
  const weatherRow = {
    id: 'weather',
    name: 'weather',
    description: "Today's weather for a place: high, low, sunrise, sunset, UV and air quality.",
    type: 'external',
    categoryPath: 'custom',
    providerId: null,
    tier: 'standard',
    parametersSchema: { type: 'object', properties: { place: { type: 'string' } } },
    keywords: ['weather', 'local'],
    aliases: [],
    source: 'workspace:weather',
    sortOrder: 0,
    enabled: true,
    configJson: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  async function buildAppWithToolGet(): Promise<express.Application> {
    const app = await buildApp();
    const singleRouter = (await import('@server/domains/tools/routes/single.routes')).default;
    app.use('/api/tools', singleRouter);
    return app;
  }

  async function getTool(app: express.Application, row: typeof weatherRow) {
    const { Tools } = await import('@snaglet/db/tables/tools');
    jest.mocked(Tools.findById).mockResolvedValueOnce(row as never);
    const res = await request(app).get(`/api/tools/${row.id}`);
    expect(res.status).toBe(200);
    return res.body.data as Record<string, unknown>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deploy returns the same row GET /api/tools/:id does, availability included', async () => {
    const app = await buildAppWithToolGet();
    const helpers = await import('@server/domains/tools/routes/helpers');
    const { toolWorkspaceService } =
      await import('@server/services/ToolService/ToolWorkspaceService');
    jest
      .spyOn(toolWorkspaceService, 'install')
      .mockResolvedValue({ success: true, output: '', durationMs: 1 });
    jest
      .spyOn(toolWorkspaceService, 'build')
      .mockResolvedValue({ success: true, output: '', durationMs: 2 });
    jest
      .spyOn(toolWorkspaceService, 'readFile')
      .mockReturnValue(JSON.stringify({ name: 'weather' }));
    jest.spyOn(toolWorkspaceService, 'getInfo').mockReturnValue({
      toolId: 'weather',
      dir: path.join(workspacesDir, 'weather'),
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: { name: 'weather' },
    });
    jest
      .spyOn(toolWorkspaceService, 'getBuiltToolPath')
      .mockReturnValue(path.join(workspacesDir, 'weather', 'dist', 'tool.cjs'));
    jest.mocked(helpers.syncDefinitionToDb).mockResolvedValueOnce(weatherRow as never);

    const res = await request(app).post('/api/tools/workspaces/weather/deploy');

    expect(res.status).toBe(200);
    expect(res.body.data.tool).toEqual({ ...weatherRow, availability: 'available' });
    expect(res.body.data.tool).toEqual(await getTool(app, weatherRow));
  });

  it('create returns the disabled draft row with its availability', async () => {
    const app = await buildAppWithToolGet();
    const helpers = await import('@server/domains/tools/routes/helpers');
    const draft = { ...weatherRow, enabled: false };
    jest.mocked(helpers.syncDefinitionToDb).mockResolvedValueOnce(draft as never);

    const res = await request(app)
      .post('/api/tools/workspaces')
      .send({
        toolId: 'weather',
        files: {
          'definition.json': JSON.stringify({ name: 'weather' }),
          'tool.ts': TOOL_TS,
          'TOOL.md': '# weather',
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.tool).toEqual({ ...draft, availability: 'disabled' });
    expect(res.body.data.tool).toEqual(await getTool(app, draft));
  });

  it('a definition update returns the re-synced row with its availability', async () => {
    const app = await buildAppWithToolGet();
    const helpers = await import('@server/domains/tools/routes/helpers');
    const updated = { ...weatherRow, description: 'Weather for a place.' };
    jest.mocked(helpers.syncDefinitionToDb).mockResolvedValueOnce(updated as never);

    const res = await request(app)
      .put('/api/tools/workspaces/my-tool/files')
      .send({
        'definition.json': JSON.stringify({ name: 'weather', description: 'Weather for a place.' }),
      });

    expect(res.status).toBe(200);
    expect(res.body.data.tool).toEqual({ ...updated, availability: 'available' });
    expect(res.body.data.tool).toEqual(await getTool(app, updated));
  });
});
