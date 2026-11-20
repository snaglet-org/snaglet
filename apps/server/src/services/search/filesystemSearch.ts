/**
 * Project-folder filesystem search for the command palette.
 *
 * Resolves the project folder attached to a thread (walking the container
 * lineage up to the owning project), maintains a stable `~/.snaglet/projects/<id>`
 * symlink alias for it, and fuzzy-matches files/folders under that alias
 * against the palette query.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { getDb } from '@snaglet/db';
import { refreshProjectFolderAlias, projectAliasPath } from '@server/services/projectFolder';

export type PaletteFilesystemKind = 'file' | 'folder';

export type PaletteFilesystemResult = {
  type: 'filesystem';
  filesystemKind: PaletteFilesystemKind;
  name: string;
  path: string;
  subtitle: string | null;
  score: number;
};

type FilesystemCandidate = {
  kind: PaletteFilesystemKind;
  name: string;
  relativePath: string;
  parentRelativePath: string | null;
  score: number;
};

type ProjectFolderContext = {
  projectId: string;
  folderPath: string;
  aliasPath: string;
};

const MAX_FILESYSTEM_RESULTS = 12;
const MAX_FILESYSTEM_ENTRIES = 2000;

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Score `candidate` against `query` for palette ranking. Both strings are
 * normalized to lowercase alphanumerics before comparison. Score bands:
 * exact match (1000+) > prefix (800+) > substring (600+) > subsequence
 * (350+) > no match (0). Exported for testability.
 */
export function fuzzyScore(candidate: string, query: string): number {
  const c = normalizeComparable(candidate);
  const q = normalizeComparable(query);
  if (!q) return 0;
  if (c === q) return 1000 + q.length;
  if (c.startsWith(q)) return 800 + q.length;
  const idx = c.indexOf(q);
  if (idx >= 0) return 600 + q.length - idx;

  let matched = 0;
  let cursor = 0;
  for (const ch of c) {
    if (cursor < q.length && ch === q[cursor]) {
      cursor += 1;
      matched += 1;
    }
  }
  if (matched === q.length) return 350 + q.length;
  return 0;
}

async function getProjectFolderContext(
  threadId: string | undefined
): Promise<ProjectFolderContext | null> {
  if (!threadId) return null;
  const { rows } = await getDb().query<{ project_id: string; folder_path: string | null }>(
    `
      with recursive lineage as (
        select n.container_id, 0 as depth
        from public.nodes n
        where n.id = $1
          and n.container_id is not null

        union all

        select parent.container_id, lineage.depth + 1
        from lineage
        join public.nodes parent on parent.id = lineage.container_id
        where parent.container_id is not null
          and lineage.depth < 32
      )
      select p.id as project_id, p.folder_path
      from lineage l
      join public.containers p
        on p.id = l.container_id
       and p.category = 'project'
      order by l.depth asc
      limit 1
    `,
    [threadId]
  );

  const row = rows[0];
  if (!row?.folder_path) return null;

  const folderPath = path.resolve(row.folder_path);
  const aliasPath = projectAliasPath(row.project_id);
  return { projectId: row.project_id, folderPath, aliasPath };
}

async function listFilesystemCandidates(
  context: ProjectFolderContext,
  query: string,
  filter: PaletteFilesystemKind | null
): Promise<PaletteFilesystemResult[]> {
  if (!query) return [];
  const root = context.aliasPath;
  const queue = [''];
  const candidates: FilesystemCandidate[] = [];
  let scanned = 0;

  while (queue.length > 0 && scanned < MAX_FILESYSTEM_ENTRIES) {
    const relativeDir = queue.shift() ?? '';
    const absoluteDir = path.join(root, relativeDir);
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const kind: PaletteFilesystemKind | null = entry.isDirectory()
        ? 'folder'
        : entry.isFile()
          ? 'file'
          : null;
      if (!kind) continue;
      scanned += 1;
      const nextRelative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) queue.push(nextRelative);
      if (filter && kind !== filter) continue;

      const score = Math.max(fuzzyScore(entry.name, query), fuzzyScore(nextRelative, query));
      if (score <= 0) continue;

      candidates.push({
        kind,
        name: entry.name,
        relativePath: nextRelative,
        parentRelativePath: relativeDir || null,
        score,
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, MAX_FILESYSTEM_RESULTS)
    .map((candidate) => ({
      type: 'filesystem',
      filesystemKind: candidate.kind,
      name: candidate.name,
      path: candidate.relativePath,
      subtitle: candidate.parentRelativePath,
      score: candidate.score,
    }));
}

/**
 * Search the project folder associated with `threadId` for files/folders
 * fuzzy-matching `query`. Resolves the project folder context from the
 * thread's container lineage; returns `[]` when the thread has no project
 * folder or the query is empty. Otherwise ensures the project's symlink
 * alias exists and breadth-first scans up to 2000 entries, returning the
 * top 12 scored hits (optionally restricted to `filter` kind).
 */
export async function searchProjectFilesystem(
  threadId: string | undefined,
  query: string,
  filter: PaletteFilesystemKind | null
): Promise<PaletteFilesystemResult[]> {
  const context = await getProjectFolderContext(threadId);
  if (!context || !query) return [];
  // Best-effort refresh of the ~/.snaglet/projects/<id> alias before walking it.
  await refreshProjectFolderAlias(context.projectId);
  return listFilesystemCandidates(context, query, filter);
}

/**
 * Resolve a project folder from the project id directly, rather than by
 * climbing a thread's lineage.
 *
 * Named-project scope knows the project outright, so inferring one from the
 * caller's thread would search the wrong folder — the user named a project
 * precisely so the search would leave the one they are sitting in.
 */
async function getProjectFolderContextById(
  projectId: string | undefined
): Promise<ProjectFolderContext | null> {
  if (!projectId) return null;
  const { rows } = await getDb().query<{ project_id: string; folder_path: string | null }>(
    `SELECT c.id AS project_id, c.folder_path
       FROM public.containers c
       JOIN public.nodes n ON n.id = c.id
      WHERE c.id = $1
        AND c.category = 'project'
        AND n.archived = false
      LIMIT 1`,
    [projectId]
  );

  const row = rows[0];
  if (!row?.folder_path) return null;

  return {
    projectId: row.project_id,
    folderPath: path.resolve(row.folder_path),
    aliasPath: projectAliasPath(row.project_id),
  };
}

/**
 * Filesystem search restricted to one project's folder.
 *
 * The strict counterpart of `searchProjectFilesystem`: same walk and scoring,
 * but the root comes from an explicitly named project. Returns `[]` when that
 * project has no folder on disk — a workspace-only project legitimately has no
 * files, and inventing a wider root would defeat the scope.
 */
export async function searchProjectFilesystemByProjectId(
  projectId: string | undefined,
  query: string,
  filter: PaletteFilesystemKind | null
): Promise<PaletteFilesystemResult[]> {
  const context = await getProjectFolderContextById(projectId);
  if (!context || !query) return [];
  await refreshProjectFolderAlias(context.projectId);
  return listFilesystemCandidates(context, query, filter);
}
