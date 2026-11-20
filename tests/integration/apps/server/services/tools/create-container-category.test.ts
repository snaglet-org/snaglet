/**
 * create_container category support (integration, real DB). `project` is the
 * only category (tasks are table rows, not status containers). The tool
 * pre-validates against the shared value list (friendly
 * fast-fail) with the DB CHECK as the authoritative backstop.
 */

import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from '@jest/globals';
import { Containers } from '@snaglet/db/tables/containers';
import handler from '@server/services/ToolService/handlers/containers/createContainer';

type Result = {
  output: string;
  rawContent: {
    success: true;
    container: {
      id: string;
      name: string;
      category: string | null;
    };
    folder_warnings?: string[];
  };
};

async function call(input: Record<string, unknown>): Promise<Result> {
  const out = await handler(input as never, {} as never, {} as never);
  if (typeof out === 'string') throw new Error('expected structured result');
  return out as Result;
}

describe('create_container — category', () => {
  const createdIds: string[] = [];
  const suffix = `-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const n = (base: string) => `${base}${suffix}`;

  afterAll(async () => {
    for (let i = createdIds.length - 1; i >= 0; i--) {
      try {
        await Containers.delete(createdIds[i]);
      } catch {
        // best-effort
      }
    }
  });

  it('returns folder_warnings when the linked folder has no repo marker, none for a repo', async () => {
    const bare = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-create-bare-')));
    const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-create-repo-')));
    await mkdir(path.join(repo, '.git'));
    const warned = await call({ name: n('Warn'), category: 'project', folder_path: bare });
    createdIds.push(warned.rawContent.container.id);
    expect(warned.rawContent.folder_warnings?.length).toBeGreaterThan(0);
    const clean = await call({ name: n('Clean'), category: 'project', folder_path: repo });
    createdIds.push(clean.rawContent.container.id);
    expect(clean.rawContent).not.toHaveProperty('folder_warnings');
  });

  it('stores a valid category', async () => {
    const r = await call({ name: n('Proj'), category: 'project' });
    createdIds.push(r.rawContent.container.id);
    expect(r.rawContent.container.category).toBe('project');
    const row = await Containers.findById(r.rawContent.container.id);
    expect(row!.category).toBe('project');
  });

  it('defaults category to null when omitted and returns no phase', async () => {
    const r = await call({ name: n('Plain') });
    createdIds.push(r.rawContent.container.id);
    expect(r.rawContent.container.category).toBeNull();
    expect(r.rawContent.container).not.toHaveProperty('phase');
  });

  it('rejects an invalid category', async () => {
    await expect(call({ name: n('Bad'), category: 'bogus' })).rejects.toThrow(/`category` must be/);
  });

  it.each(['reference', 'log', 'status'])('rejects retired category %s', async (category) => {
    await expect(call({ name: n(`Retired-${category}`), category })).rejects.toThrow(
      /`category` must be/
    );
  });

  it('ignores a legacy phase parameter instead of storing it', async () => {
    const r = await call({ name: n('Legacy'), phase: 'blocked' });
    createdIds.push(r.rawContent.container.id);
    expect(r.rawContent.container.category).toBeNull();
    expect(r.rawContent.container).not.toHaveProperty('phase');
  });
});
