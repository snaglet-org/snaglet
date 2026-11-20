/**
 * /api/hooks — the folder-write REST surface for the GUI hook builder. Mounts
 * the real router + HookWorkspaceService against a temp dir
 * (HOOK_WORKSPACES_DIR); the lifecycle service is mocked (it has its own
 * real-PG tests). Pins the request/response shapes the hook-builder client
 * relies on and the 404-vs-500 contract.
 *
 * HOOK_WORKSPACES_DIR is read once when HookWorkspaceService loads, so the
 * env module is imported before the router, statically, so no test's timeout
 * pays for compiling its import graph.
 */
import request from 'supertest';
import express from 'express';
import { rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { ConflictError } from '@snaglet/shared/utils';
import { hookWorkspacesDir } from '../../../../support/hookWorkspacesEnv';
import hooksRouter from '@server/routes/hooks';
import { errorHandler } from '@server/middleware';
import { hookWorkspaceService } from '@server/services/customHooks/HookWorkspaceService';
import { getPanelToken, mintChildDispatchToken } from '@server/middleware/panelAuth';

const clearHookRunHistory = jest.fn();
const deleteHook = jest.fn();

jest.mock('@server/services/customHooks/HookLifecycleService', () => ({
  clearHookRunHistory: (...args: unknown[]) => clearHookRunHistory(...args),
  deleteHook: (...args: unknown[]) => deleteHook(...args),
}));

const HOOK_TS =
  "import { defineHook } from '@snaglet/sdk';\nexport default defineHook({ on: 'run:end', run() {} });\n";

async function buildApp(): Promise<express.Application> {
  const app = express();
  app.use(express.json());
  app.use('/api/hooks', hooksRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  clearHookRunHistory.mockReset();
  clearHookRunHistory.mockImplementation(async (hookName: string) => ({
    hookName,
    deletedRuns: 0,
  }));
  deleteHook.mockReset();
  deleteHook.mockImplementation(async (hookName: string) => {
    const stage = hookWorkspaceService.stageDelete(hookName);
    hookWorkspaceService.finalizeDelete(stage);
    return {
      hookName: stage.hookName,
      deletedRuns: 0,
      deletedRegistration: false,
      deletedSchedules: 0,
      trash: { disposition: 'system-trash', fallbackDir: null },
    };
  });
});

afterAll(async () => {
  delete process.env.HOOK_WORKSPACES_DIR;
  await rm(hookWorkspacesDir, { recursive: true, force: true });
});

describe('POST /api/hooks — create', () => {
  it('creates a hook workspace and returns 201 with the workspace info', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/hooks')
      .send({ hookName: 'on-message', files: { 'hook.ts': HOOK_TS } });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.workspace.hookName).toBe('on-message');
    expect(res.body.data.workspace.files).toContain('hook.ts');
    // The service picked up the temp dir (the env module ran before it loaded).
    expect(existsSync(path.join(hookWorkspacesDir, 'on-message', 'hook.ts'))).toBe(true);
  });

  it('400s when hookName is missing', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/hooks')
      .send({ files: { 'hook.ts': HOOK_TS } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400s when files["hook.ts"] is missing', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/hooks').send({ hookName: 'no-files' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('409s on a name collision instead of silently overwriting the existing hook.ts', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'dup-hook', files: { 'hook.ts': HOOK_TS } });

    const overwrite =
      "import { defineHook } from '@snaglet/sdk';\nexport default defineHook({ on: 'thread:create', run() {} });\n";
    const res = await request(app)
      .post('/api/hooks')
      .send({ hookName: 'dup-hook', files: { 'hook.ts': overwrite } });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    // The original hook.ts must be intact — the collision never wrote.
    const getRes = await request(app).get('/api/hooks/dup-hook/files/hook.ts');
    expect(getRes.body.data.content).toBe(HOOK_TS);
  });
});

describe('GET /api/hooks — list', () => {
  it('includes a previously-created hook', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'listed-one', files: { 'hook.ts': HOOK_TS } });

    const res = await request(app).get('/api/hooks');
    expect(res.status).toBe(200);
    const names = (res.body.data as Array<{ hookName: string }>).map((h) => h.hookName);
    expect(names).toContain('listed-one');
  });
});

describe('GET /api/hooks/:hookName — 404 vs 200', () => {
  it('200s with info for an existing workspace', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'get-me', files: { 'hook.ts': HOOK_TS } });

    const res = await request(app).get('/api/hooks/get-me');
    expect(res.status).toBe(200);
    expect(res.body.data.hookName).toBe('get-me');
  });

  it('404s (never a bare Express 404 or 500) for a nonexistent workspace', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/hooks/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/hooks/:hookName/files/:fileName — the 404-vs-500 contract', () => {
  it('returns the file content when it exists', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'has-file', files: { 'hook.ts': HOOK_TS } });

    const res = await request(app).get('/api/hooks/has-file/files/hook.ts');
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe(HOOK_TS);
  });

  it('400s (not 404) for a non-whitelisted file name in an existing workspace', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'missing-file-hook', files: { 'hook.ts': HOOK_TS } });

    // NOTES.md is not a file this service owns → rejected before any fs read.
    const res = await request(app).get('/api/hooks/missing-file-hook/files/NOTES.md');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404s (not 500) when the whole workspace folder is missing', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/hooks/never-created/files/hook.ts');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/hooks/:hookName/files/:fileName — path-traversal defense via a real request', () => {
  it('rejects an encoded %2f traversal (Express decodes it to ../ inside the param) with a 400, not a file read', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'trav-hook', files: { 'hook.ts': HOOK_TS } });

    // encodeURIComponent turns each "/" into "%2f"; Express percent-decodes the
    // route param after matching, so req.params.fileName arrives as the literal
    // "../../../../etc/passwd" — the exact arbitrary-read the whitelist blocks.
    const encoded = encodeURIComponent('../../../../etc/passwd');
    const res = await request(app).get(`/api/hooks/trav-hook/files/${encoded}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Must not have leaked /etc/passwd content.
    expect(JSON.stringify(res.body)).not.toMatch(/root:.*:0:0:/);
  });

  it('rejects an encoded absolute path (%2Fetc%2Fpasswd) with a 400', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'trav-hook-2', files: { 'hook.ts': HOOK_TS } });

    const res = await request(app).get(
      `/api/hooks/trav-hook-2/files/${encodeURIComponent('/etc/passwd')}`
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /api/hooks/:hookName/files — update', () => {
  it('overwrites hook.ts and the change round-trips through GET', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'editable', files: { 'hook.ts': HOOK_TS } });

    const updated =
      "import { defineHook } from '@snaglet/sdk';\nexport default defineHook({ on: 'thread:create', run() {} });\n";
    const putRes = await request(app)
      .put('/api/hooks/editable/files')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ 'hook.ts': updated });
    expect(putRes.status).toBe(200);

    const getRes = await request(app).get('/api/hooks/editable/files/hook.ts');
    expect(getRes.body.data.content).toBe(updated);
  });

  it('500s (generic internal error, not a 404) for a nonexistent workspace — matches ToolWorkspaceService.updateFiles', async () => {
    const app = await buildApp();
    const res = await request(app)
      .put('/api/hooks/never-created-either/files')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ 'hook.ts': 'x' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('400s an adversarial body key that escapes the sandbox, and writes nothing', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'write-guard-route', files: { 'hook.ts': HOOK_TS } });

    const res = await request(app)
      .put('/api/hooks/write-guard-route/files')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ '../../../../tmp/snaglet-route-escape-canary.txt': 'pwned' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(existsSync('/tmp/snaglet-route-escape-canary.txt')).toBe(false);
    // The real hook.ts is untouched — the whole request was rejected atomically.
    const getRes = await request(app).get('/api/hooks/write-guard-route/files/hook.ts');
    expect(getRes.body.data.content).toBe(HOOK_TS);
  });
});

describe('PUT /api/hooks/:hookName/files — panel token only', () => {
  it('refuses a write without the panel token, or with a hook child credential, and keeps hook.ts', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'guarded-code', files: { 'hook.ts': HOOK_TS } });

    const anonymous = await request(app)
      .put('/api/hooks/guarded-code/files')
      .send({ 'hook.ts': 'export default 1;\n' });
    const fromHook = await request(app)
      .put('/api/hooks/guarded-code/files')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('test-agent-a', 'guarded-code'))
      .send({ 'hook.ts': 'export default 1;\n' });

    expect(anonymous.status).toBe(403);
    expect(fromHook.status).toBe(403);
    const getRes = await request(app).get('/api/hooks/guarded-code/files/hook.ts');
    expect(getRes.body.data.content).toBe(HOOK_TS);
  });
});

describe('DELETE /api/hooks/:hookName — delete', () => {
  it('removes the workspace; a subsequent GET 404s', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/hooks')
      .send({ hookName: 'deletable', files: { 'hook.ts': HOOK_TS } });

    const delRes = await request(app).delete('/api/hooks/deletable');
    expect(delRes.status).toBe(200);
    // The trash outcome travels to the client — the move-to-Trash modal's
    // recoverability copy depends on this wire shape.
    expect(delRes.body.data.trash).toEqual({ disposition: 'system-trash', fallbackDir: null });

    const getRes = await request(app).get('/api/hooks/deletable');
    expect(getRes.status).toBe(404);
  });

  it('is a harmless no-op (200) for a workspace that never existed', async () => {
    const app = await buildApp();
    const res = await request(app).delete('/api/hooks/ghost-hook');
    expect(res.status).toBe(200);
  });

  it('returns 409 without claiming deletion when an invocation is queued or running', async () => {
    deleteHook.mockRejectedValueOnce(
      new ConflictError('Hook busy-delete has a queued or running invocation')
    );
    const app = await buildApp();
    const res = await request(app).delete('/api/hooks/busy-delete');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('DELETE /api/hooks/:hookName/runs — clear history', () => {
  it('is idempotent when the hook folder is missing', async () => {
    const app = await buildApp();
    const res = await request(app).delete('/api/hooks/orphan-history/runs');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hookName: 'orphan-history', deletedRuns: 0 });
    expect(clearHookRunHistory).toHaveBeenCalledWith('orphan-history');
  });

  it('returns 409 when an invocation is queued or running', async () => {
    clearHookRunHistory.mockRejectedValueOnce(
      new ConflictError('Hook busy-hook has a queued or running invocation')
    );
    const app = await buildApp();
    const res = await request(app).delete('/api/hooks/busy-hook/runs');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});
