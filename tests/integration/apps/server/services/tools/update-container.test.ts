/**
 * update_container — edit description and project facets in place
 * (integration, real DB). A container's category is fixed at creation and is
 * not a parameter; a `phase` parameter is ignored.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import path from 'node:path';
import os from 'node:os';
import { realpath, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { Containers } from '@snaglet/db/tables/containers';
import handler from '@server/services/ToolService/handlers/containers/updateContainer';

interface Result {
  output: string;
  rawContent: {
    success: true;
    container: {
      id: string;
      name: string;
      category: string | null;
      folder_path: string | null;
      github_url: string | null;
      description: string | null;
    };
    folder_warnings?: string[];
  };
}

async function call(input: Record<string, unknown>): Promise<Result> {
  const out = await handler(input as never, {} as never, {} as never);
  if (typeof out === 'string') throw new Error('expected structured result');
  return out as Result;
}

describe('update_container', () => {
  const createdIds: string[] = [];
  const suffix = `-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let folderPath: string;

  beforeAll(async () => {
    folderPath = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-update-container-')));
    await mkdir(path.join(folderPath, '.git'));
  });

  afterAll(async () => {
    for (let i = createdIds.length - 1; i >= 0; i--) {
      try {
        await Containers.delete(createdIds[i]);
      } catch {
        // best-effort
      }
    }
    await rm(folderPath, { recursive: true, force: true });
  });

  // A container is a project from creation or never: threads and tables are
  // scoped to it, and `project` is the only category, so `category` is not a
  // parameter. A caller still sending it changes nothing.
  it.each([null, 'project'])(
    "leaves a project container's category alone when category: %s is sent with a real change",
    async (category) => {
      const c = await Containers.create({ name: `upd-proj-fixed${suffix}`, category: 'project' });
      createdIds.push(c.id);
      const r = await call({ container_id: c.id, category, description: 'still me' });
      expect(r.rawContent.container.category).toBe('project');
      expect(r.rawContent.container.description).toBe('still me');
      expect((await Containers.findById(c.id))!.category).toBe('project');
    }
  );

  it('cannot turn a plain container into a project (category is not a changeable field)', async () => {
    const plain = await Containers.create({ name: `upd-plain-fixed${suffix}` });
    createdIds.push(plain.id);
    await expect(call({ container_id: plain.id, category: 'project' })).rejects.toThrow(
      /provide at least one field to change/
    );
    expect((await Containers.findById(plain.id))!.category).toBeNull();
  });

  it('ignores a legacy phase parameter (no such field)', async () => {
    const c = await Containers.create({ name: `upd-col${suffix}` });
    createdIds.push(c.id);
    await expect(call({ container_id: c.id, phase: 'blocked' })).rejects.toThrow(
      /provide at least one field to change/
    );
    const r = await call({ container_id: c.id, phase: 'blocked', description: 'noted' });
    expect(r.rawContent.container).not.toHaveProperty('phase');
    expect(r.rawContent.container.description).toBe('noted');
  });

  it('rejects a call with no changeable field', async () => {
    const c = await Containers.create({ name: `upd-noop${suffix}` });
    createdIds.push(c.id);
    await expect(call({ container_id: c.id })).rejects.toThrow(
      /provide at least one field to change/
    );
  });

  // Project facets: folder_path/github_url are
  // set through update_container. The internal handler path accepts them (the
  // external MCP tier denies them — see mcpServer.test.ts).
  it('sets folder_path and github_url on a project container', async () => {
    const c = await Containers.create({ name: `upd-proj-facets${suffix}`, category: 'project' });
    createdIds.push(c.id);
    const r = await call({
      container_id: c.id,
      folder_path: folderPath,
      github_url: 'https://github.com/acme/repo',
    });
    expect(r.rawContent.container.folder_path).toBe(folderPath);
    expect(r.rawContent.container.github_url).toBe('https://github.com/acme/repo');
    const persisted = (await Containers.findById(c.id))!;
    expect(persisted.folderPath).toBe(folderPath);
    expect(persisted.githubUrl).toBe('https://github.com/acme/repo');
  });

  // A folder that links but looks unusual must tell the agent why, since the
  // snaglet-projects skill says to read `folder_warnings` and mention the odd ones.
  it('returns folder_warnings when a linked folder has no repo marker', async () => {
    const bare = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-update-bare-')));
    const c = await Containers.create({ name: `upd-warn${suffix}`, category: 'project' });
    createdIds.push(c.id);
    const r = await call({ container_id: c.id, folder_path: bare });
    expect(r.rawContent.container.folder_path).toBe(bare);
    expect(r.rawContent.folder_warnings?.length).toBeGreaterThan(0);
  });

  it('omits folder_warnings for a normal repo folder', async () => {
    const c = await Containers.create({ name: `upd-nowarn${suffix}`, category: 'project' });
    createdIds.push(c.id);
    const r = await call({ container_id: c.id, folder_path: folderPath });
    expect(r.rawContent).not.toHaveProperty('folder_warnings');
  });

  it('clears a facet with null (and an empty string clears too)', async () => {
    const c = await Containers.create({
      name: `upd-facet-clear${suffix}`,
      category: 'project',
      folderPath: '/tmp/old',
      githubUrl: 'https://github.com/acme/old',
    });
    createdIds.push(c.id);
    const r = await call({ container_id: c.id, folder_path: null, github_url: '' });
    expect(r.rawContent.container.folder_path).toBeNull();
    expect(r.rawContent.container.github_url).toBeNull();
    const persisted = (await Containers.findById(c.id))!;
    expect(persisted.folderPath).toBeNull();
    expect(persisted.githubUrl).toBeNull();
  });

  it('updates a facet without touching category', async () => {
    const c = await Containers.create({
      name: `upd-facet-only${suffix}`,
      category: 'project',
    });
    createdIds.push(c.id);
    const r = await call({ container_id: c.id, folder_path: folderPath });
    expect(r.rawContent.container.category).toBe('project'); // untouched
    expect(r.rawContent.container.folder_path).toBe(folderPath);
  });

  // description: not category-gated — settable on any container.
  it('sets a description on a plain container', async () => {
    const c = await Containers.create({ name: `upd-desc${suffix}` });
    createdIds.push(c.id);
    const r = await call({ container_id: c.id, description: 'a plain container, described' });
    expect(r.rawContent.container.description).toBe('a plain container, described');
    expect((await Containers.findById(c.id))!.description).toBe('a plain container, described');
  });

  it('trims a description and clears it with null (and an empty string clears too)', async () => {
    const c = await Containers.create({ name: `upd-desc-clear${suffix}` });
    createdIds.push(c.id);
    const r1 = await call({ container_id: c.id, description: '  padded text  ' });
    expect(r1.rawContent.container.description).toBe('padded text');

    const r2 = await call({ container_id: c.id, description: null });
    expect(r2.rawContent.container.description).toBeNull();

    const r3 = await call({ container_id: c.id, description: 'set again' });
    expect(r3.rawContent.container.description).toBe('set again');
    const r4 = await call({ container_id: c.id, description: '' });
    expect(r4.rawContent.container.description).toBeNull();
    expect((await Containers.findById(c.id))!.description).toBeNull();
  });

  it('updates description without touching category', async () => {
    const c = await Containers.create({
      name: `upd-desc-only${suffix}`,
      category: 'project',
    });
    createdIds.push(c.id);
    const r = await call({ container_id: c.id, description: 'project notes' });
    expect(r.rawContent.container.category).toBe('project'); // untouched
    expect(r.rawContent.container.description).toBe('project notes');
  });
});
