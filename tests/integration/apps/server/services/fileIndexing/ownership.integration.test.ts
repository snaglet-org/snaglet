/**
 * Single-owner file indexing — end-to-end against the real database + filesystem.
 * The ownership resolver is unit-tested; this covers its wiring:
 *   - the sweep (reindexAll) indexes a folder tree under exactly one project and
 *     purges the overlapping ("satellite") projects, so nested sub-projects do
 *     not each re-embed the same files; and
 *   - the read path (getFileSearchScope + the lexical file filter) redirects a
 *     satellite's file search to the owner's index, narrowed to the satellite's
 *     subtree via the relative_path prefix.
 * Two overlap shapes: two projects on the same folder, and a project on a
 * subfolder of an indexed folder. Read assertions use lexical search (FTS over
 * relative_path), which needs no embedding provider, so hits are deterministic.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Containers, Projects, getDb } from '@snaglet/db';
import { Files } from '@snaglet/db/tables/files';
import { ensureWatchConfig, getFileSearchScope, reindexAll } from '@server/services/fileIndexing';
import { searchLexicalWorkspace } from '@server/services/ToolService/handlers/search/workspaceSearch/lexical';
import type { SearchableKind } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

// Temp folder roots + the container/project nodes created, torn down in afterAll.
const tmpDirs: string[] = [];
const containerIds: string[] = [];

async function makeProject(name: string, folderPath: string) {
  const container = await Containers.create({ name: `${name}-c`, category: 'project' });
  containerIds.push(container.id);
  return Projects.create({ name, containerId: container.id, folderPath });
}

/** Run a lexical file-kind search and return the matching file node ids. */
async function fileSearchIds(
  query: string,
  fileProjectId: string,
  filePathPrefix: string | null
): Promise<string[]> {
  const { hits } = await searchLexicalWorkspace({
    query,
    kinds: new Set<SearchableKind>(['file']),
    limit: 20,
    allowedContainerIds: null,
    containerRowsCache: null,
    timeRange: null,
    fileProjectId,
    filePathPrefix,
  });
  return hits.filter((h) => h.kind === 'file').map((h) => h.id);
}

const relPaths = (rows: Awaited<ReturnType<typeof Files.listByProject>>) =>
  rows.map((r) => r.relativePath).sort();

describe('file indexing — single owner per folder tree', () => {
  afterAll(async () => {
    if (containerIds.length > 0) {
      // Deleting the container node cascades its project marker + file nodes
      // (and their embeddings) via the shared-PK / container_id FKs.
      await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [containerIds]);
    }
    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('subfolder project is a satellite: owner indexes the tree, satellite is purged + redirected', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'snaglet-own-root-'));
    tmpDirs.push(root);
    await writeFile(path.join(root, 'octopusroot'), 'octopus root content');
    const sub = path.join(root, 'apps', 'server');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'walrussub'), 'walrus sub content');
    await ensureWatchConfig(root); // gate on at the root
    await ensureWatchConfig(sub); // gate on at the subfolder (so it's index-eligible)

    const rootProj = await makeProject('own-root', root);
    const subProj = await makeProject('own-sub', sub);

    await reindexAll('test:subfolder', undefined, [rootProj, subProj]);

    // Write side: the root owner indexed the whole tree (incl. the subfolder
    // file at its root-relative path); the satellite has no nodes of its own.
    expect(relPaths(await Files.listByProject(rootProj.id))).toEqual([
      'apps/server/walrussub',
      'octopusroot',
    ]);
    expect(await Files.listByProject(subProj.id)).toEqual([]);

    // Read side: ownership redirect.
    expect(getFileSearchScope(rootProj.id)).toEqual({ projectId: rootProj.id, pathPrefix: '' });
    expect(getFileSearchScope(subProj.id)).toEqual({
      projectId: rootProj.id,
      pathPrefix: 'apps/server',
    });

    // The owner node ids the satellite's search should resolve to.
    const ownerFiles = await Files.listByProject(rootProj.id);
    const subNodeId = ownerFiles.find((f) => f.relativePath === 'apps/server/walrussub')?.id;
    const rootNodeId = ownerFiles.find((f) => f.relativePath === 'octopusroot')?.id;

    // Searching the owner index with the satellite's subtree prefix returns the
    // subfolder file (Postgres tokenizes a slashed path as one lexeme, so we
    // query the full relative path — leaf-word matching is a separate FTS limit).
    expect(await fileSearchIds('apps/server/walrussub', rootProj.id, 'apps/server/%')).toContain(
      subNodeId
    );
    // ...but a file outside the satellite's subtree is excluded by the prefix
    // even though it matches the query text.
    expect(await fileSearchIds('octopusroot', rootProj.id, 'apps/server/%')).toEqual([]);
    // With no prefix (owner's whole tree) the root file is found.
    expect(await fileSearchIds('octopusroot', rootProj.id, null)).toContain(rootNodeId);
  });

  it('two projects on the same folder share one owner; the other is purged', async () => {
    const shared = await mkdtemp(path.join(tmpdir(), 'snaglet-own-shared-'));
    tmpDirs.push(shared);
    await writeFile(path.join(shared, 'sharedfile'), 'shared content');
    await ensureWatchConfig(shared);

    const projA = await makeProject('own-shared-a', shared);
    const projB = await makeProject('own-shared-b', shared);

    await reindexAll('test:same-folder', undefined, [projA, projB]);

    // Exactly one owner; both projects' file searches resolve to it (prefix '').
    const scopeA = getFileSearchScope(projA.id);
    const scopeB = getFileSearchScope(projB.id);
    expect(scopeA?.pathPrefix).toBe('');
    expect(scopeB?.pathPrefix).toBe('');
    expect(scopeA?.projectId).toBe(scopeB?.projectId);

    const ownerId = scopeA?.projectId as string;
    const otherId = ownerId === projA.id ? projB.id : projA.id;
    expect([projA.id, projB.id]).toContain(ownerId);

    // Only the owner holds the file node; the duplicate project holds none.
    expect(relPaths(await Files.listByProject(ownerId))).toEqual(['sharedfile']);
    expect(await Files.listByProject(otherId)).toEqual([]);
  });
});
