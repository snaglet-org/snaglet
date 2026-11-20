import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { safeJsonParse } from '@snaglet/shared/utils';

export type FolderMarkerResult =
  | { status: 'found'; path: string }
  | { status: 'missing' | 'ambiguous' | 'incomplete' };

export function readProjectMarker(raw: string): Record<string, unknown> | null {
  const parsed = safeJsonParse<unknown>(raw, null);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Bounded, conservative discovery. A partial scan cannot establish uniqueness.
 * Never traverse symlinks, hidden folders or dependency/build trees. */
export async function findProjectFolderByMarker(
  projectId: string,
  roots: string[] = [
    homedir(),
    ...['Projects', 'Desktop', 'Documents', 'Developer', 'code'].map((name) =>
      path.join(homedir(), name)
    ),
  ]
): Promise<FolderMarkerResult> {
  const deadline = Date.now() + 1500;
  const visited = new Map<string, number>();
  const matches = new Set<string>();
  const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'Library']);
  let incomplete = false;
  let count = 0;
  const queue = roots.map((root) => ({ root: path.resolve(root), depth: 0 }));
  for (let i = 0; i < queue.length; i++) {
    if (Date.now() >= deadline || ++count > 5000) {
      incomplete = true;
      break;
    }
    const { root, depth } = queue[i];
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true;
      continue;
    }
    const previous = visited.get(canonical);
    if (previous !== undefined && previous <= depth) continue;
    visited.set(canonical, depth);
    try {
      const raw = await readFile(path.join(canonical, 'snaglet.config.json'), 'utf8');
      if (readProjectMarker(raw)?.projectId === projectId) matches.add(canonical);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true;
    }
    if (matches.size > 1) return { status: 'ambiguous' };
    if (depth === 3) continue;
    try {
      const entries = await readdir(canonical, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name)) {
          queue.push({ root: path.join(canonical, entry.name), depth: depth + 1 });
        }
      }
    } catch {
      incomplete = true;
    }
  }
  if (Date.now() >= deadline || incomplete) return { status: 'incomplete' };
  const [found] = matches;
  return found ? { status: 'found', path: found } : { status: 'missing' };
}
