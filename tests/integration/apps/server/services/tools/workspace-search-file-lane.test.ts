/**
 * Files are not in the default search pool — end-to-end against the real
 * database. A doc and a file that both match the same term behave differently
 * under `workspace_search`:
 *   - a default (non-code-ish) query returns the doc but not the file, even
 *     though the file genuinely matches (proven by the explicit-kinds case); and
 *   - an explicit `kinds: ['file']` search still returns the file.
 *
 * Lexical (FTS over relative_path) is used on purpose — it needs no embedding
 * provider, so file hits are deterministic. The term is a single made-up word so
 * it is not code-ish (the file lane must not fire and pull the file in).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import { Files } from '@snaglet/db/tables/files';
import { Projects } from '@snaglet/db/tables/projects';
import { Threads } from '@snaglet/db/tables/threads';
import searchTool from '@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch';

// A single made-up lowercase word: matches by FTS, but is not code-ish (no path,
// extension, camelCase/snake_case symbol, or code keyword) so the file lane stays
// dormant on the default query.
const TERM = 'zephyrware';

let containerId = '';
let docId = '';
let fileId = '';

async function call(
  input: Record<string, unknown>,
  context: Record<string, unknown> = {}
): Promise<string> {
  const out = await (
    searchTool as unknown as (i: unknown, s: unknown, c: unknown) => Promise<unknown>
  )(input, {}, context);
  return typeof out === 'string' ? out : JSON.stringify(out);
}

describe('workspace_search — files stay out of the default pool', () => {
  beforeAll(async () => {
    // A project container so files.project_id has a valid owner (project id ===
    // container id). The category is fixed at creation; Projects.create writes
    // the folder facet.
    const container = await Containers.create({
      name: `File Lane Home ${Date.now()}`,
      category: 'project',
    });
    containerId = container.id;
    const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), 'snaglet-file-lane-'));
    fs.writeFileSync(path.join(folderPath, TERM), `${TERM}\n`);
    await Projects.create({
      name: 'File Lane Project',
      containerId: container.id,
      folderPath,
    });

    const doc = await Docs.create({
      title: 'Rollout Notes',
      content: `The ${TERM} rollout shipped this week.`,
      containerId: container.id,
    });
    docId = doc.id;

    // Single-segment relative path === the term, so FTS matches it directly
    // (leaf-word matching inside a multi-segment path is a separate FTS limit).
    const file = await Files.upsertByPath({
      projectId: container.id,
      relativePath: TERM,
      contentHash: `hash-${Date.now()}`,
      sizeBytes: 128,
      containerId: container.id,
    });
    fileId = file.id;
    // Generous hook timeout: seeding the doc triggers embedding generation,
    // which can intermittently exceed the default 5s under parallel test load.
  }, 30000);

  afterAll(async () => {
    if (containerId) {
      // Deleting the container node cascades the doc + file nodes it owns.
      await getDb()
        .query(`DELETE FROM public.nodes WHERE id = $1 OR container_id = $1`, [containerId])
        .catch((err: unknown) => console.warn('db cleanup failed:', err));
    }
  });

  it('default query returns the doc but excludes the matching file', async () => {
    const out = await call({ query: TERM });
    expect(out).toContain(docId);
    expect(out).not.toContain(fileId);
    // The file lane label must be absent — TERM is not code-ish.
    expect(out).not.toContain('file lane');
  });

  it('explicit kinds:["file"] returns the file', async () => {
    const out = await call({ query: TERM, kinds: ['file'], scope_files: 'workspace' });
    expect(out).toContain(fileId);
    expect(out).toContain(TERM);
  });

  it('kinds:["file"] from a project thread is scoped to that project with no thread_id argument', async () => {
    const threadId = `file-lane-thread-${Date.now()}`;
    await Threads.create({ id: threadId, title: 'File lane caller', projectId: containerId });
    const out = await call({ query: TERM, kinds: ['file'] }, { threadId });
    // The project folder resolves from the calling thread; hits come back as paths.
    expect(out).not.toContain('No real project folder could be resolved');
    expect(out).toContain('Files (1)');
    expect(out).toContain(TERM);
  });

  it('kinds:["file"] with no calling thread and no project stays unscoped to any project', async () => {
    const out = await call({ query: TERM, kinds: ['file'] });
    expect(out).not.toContain(fileId);
  });
});
