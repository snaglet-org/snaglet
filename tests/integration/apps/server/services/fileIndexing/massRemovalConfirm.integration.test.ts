/**
 * Mass-removal hold → person-confirmed release, end-to-end against
 * the real database + filesystem (per-file PostgreSQL clone, temp folders only).
 *
 *   - deleting most of a project holds the removals (rows kept, hold recorded);
 *   - the hold never releases by itself across reconciles;
 *   - POST apply-held-removals with the count the person saw removes exactly the
 *     missing rows, clears the hold and warning, and survivors keep their ids;
 *   - a stale count (outside ±10%, or above ceil(expected × 1.1)) → 409 with the
 *     fresh numbers, nothing removed;
 *   - the release is humans-only: not on the /mcp gateway, not referenced by
 *     any tool, the MCP projection, or the hook service.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Containers, Projects, getDb } from '@snaglet/db';
import { Files } from '@snaglet/db/tables/files';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { compileIgnoreRules } from '@server/services/fileIndexing/exclusions';
import { getProjectIndexingRuntime } from '@server/services/fileIndexing/projectIndexingStatus';
import { reconcileProject } from '@server/services/fileIndexing/reconcile';
import { registerProjectEmbeddingRoutes } from '@server/domains/projects/handlers/embeddingsHandlers';
import { errorHandler } from '@server/middleware';
import { CURATED_TOOL_IDS } from '@server/domains/mcp/mcpProjection';
import mcpGatewayRoutes from '@server/domains/mcp/mcp.routes';

const RUN = Date.now();
const rules = compileIgnoreRules([], []);
const SERVER_SRC = path.resolve(__dirname, '../../../../../../apps/server/src');

const tmpDirs: string[] = [];
const containerIds: string[] = [];

async function makeProject(name: string, folderPath: string): Promise<ProjectRow> {
  const container = await Containers.create({ name: `${name}-c`, category: 'project' });
  containerIds.push(container.id);
  return Projects.create({ name, containerId: container.id, folderPath });
}

async function writeFiles(root: string, rels: string[]): Promise<void> {
  for (const rel of rels) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), `export const v${RUN} = '${rel}';\n`);
  }
}

async function rowIds(projectId: string): Promise<Record<string, string>> {
  const rows = await Files.listByProject(projectId);
  return Object.fromEntries(rows.map((r) => [r.relativePath, r.id]));
}

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerProjectEmbeddingRoutes(router);
  app.use('/api/projects', router);
  app.use('/mcp', mcpGatewayRoutes);
  app.use(errorHandler);
  return app;
}

async function listTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTs(full)));
    else if (/\.(ts|tsx|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('mass-removal hold and confirmed release', () => {
  let dir = '';
  let project: ProjectRow;
  const keep = Array.from({ length: 50 }, (_, i) => `keep/${i}.ts`);
  const gone = Array.from({ length: 250 }, (_, i) => `gone/${i}.ts`);
  let survivorIds: Record<string, string> = {};
  const app = makeApp();

  // Nested so it unwinds before the shared DB teardown closes the pool.
  afterAll(async () => {
    if (containerIds.length > 0) {
      await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [containerIds]);
    }
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-massremoval-'));
    tmpDirs.push(dir);
    await writeFiles(dir, [...keep, ...gone]);
    project = await makeProject(`massremoval-${RUN}`, dir);
    const first = await reconcileProject(project, rules);
    expect(first.upserted).toBe(300);
    const ids = await rowIds(project.id);
    survivorIds = Object.fromEntries(keep.map((k) => [k, ids[k]]));
    await rm(path.join(dir, 'gone'), { recursive: true, force: true });
  });

  it('deleting most of the project holds the removals and records the hold', async () => {
    const result = await reconcileProject(project, rules);
    expect(result).toMatchObject({ removed: 0, kept: 250 });
    expect(Object.keys(await rowIds(project.id))).toHaveLength(300);
    const rt = getProjectIndexingRuntime(project.id);
    expect(rt.heldRemovals).toMatchObject({ count: 250, total: 300 });
    expect(rt.lastWarning).toMatch(/250 of 300 indexed files are missing from the folder/);
  });

  it('the hold never releases by itself', async () => {
    for (let i = 0; i < 3; i++) await reconcileProject(project, rules);
    expect(Object.keys(await rowIds(project.id))).toHaveLength(300);
    expect(getProjectIndexingRuntime(project.id).heldRemovals?.count).toBe(250);
  });

  it('is not reachable over the /mcp gateway (humans only)', async () => {
    const res = await request(app)
      .post(`/mcp/api/projects/${project.id}/indexing/apply-held-removals`)
      .send({ expected: 250 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const viaRpc = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'snaglet_apply_held_removals', arguments: { expected: 250 } },
      });
    expect(viaRpc.status).toBe(401); // no key; and no such tool exists anyway
    expect(Object.keys(await rowIds(project.id))).toHaveLength(300);
  });

  it('no tool, MCP projection or hook references the release', async () => {
    expect(CURATED_TOOL_IDS.some((id) => /held|mass|removal/i.test(id))).toBe(false);
    const files = [
      ...(await listTs(path.join(SERVER_SRC, 'services/ToolService'))),
      ...(await listTs(path.join(SERVER_SRC, 'domains/mcp'))),
      path.join(SERVER_SRC, 'services/HookService.ts'),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      expect({
        file,
        hit: /applyHeldRemovals|apply-held-removals|allowMassRemoval/.test(src),
      }).toEqual({
        file,
        hit: false,
      });
    }
  });

  it('a stale count above ceil(expected × 1.1) → 409 with fresh numbers, nothing removed', async () => {
    const res = await request(app)
      .post(`/api/projects/${project.id}/indexing/apply-held-removals`)
      .send({ expected: 200 }); // cap 220 < 250 found
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/250 files are missing now, not 200/);
    expect(res.body.error?.details ?? res.body.details).toMatchObject({
      reason: 'count-changed',
      found: 250,
      expected: 200,
      total: 300,
    });
    expect(Object.keys(await rowIds(project.id))).toHaveLength(300);
    expect(getProjectIndexingRuntime(project.id).heldRemovals?.count).toBe(250);
    expect(getProjectIndexingRuntime(project.id).activeExclusiveOp).toBeNull();
  });

  it('a bad body is rejected (400) without scanning', async () => {
    const res = await request(app)
      .post(`/api/projects/${project.id}/indexing/apply-held-removals`)
      .send({ expected: 'all' });
    expect(res.status).toBe(400);
    expect(Object.keys(await rowIds(project.id))).toHaveLength(300);
  });

  it('the matching count removes exactly the missing rows; survivors keep their ids', async () => {
    const res = await request(app)
      .post(`/api/projects/${project.id}/indexing/apply-held-removals`)
      .send({ expected: 250 });
    expect(res.status).toBe(200);
    expect(res.body.data ?? res.body).toMatchObject({ removed: 250, kept: 0 });
    expect(await rowIds(project.id)).toEqual(survivorIds);
    const rt = getProjectIndexingRuntime(project.id);
    expect(rt.heldRemovals).toBeNull();
    expect(rt.lastWarning).toBeNull();
    expect(rt.activeExclusiveOp).toBeNull();
  });

  it('with nothing held, the release is refused (409)', async () => {
    const res = await request(app)
      .post(`/api/projects/${project.id}/indexing/apply-held-removals`)
      .send({ expected: 250 });
    expect(res.status).toBe(409);
    expect(await rowIds(project.id)).toEqual(survivorIds);
  });
});
