/**
 * ownership — decide which project indexes a folder tree when several projects
 * point into the same tree.
 *
 * Indexing is keyed on the project, but the natural unit is the FOLDER: a tree's
 * content is identical no matter how many projects reference it. Nested
 * sub-projects that inherit a parent's folder path (or a subfolder of it) would
 * otherwise each walk + embed the same files — N× the embeddings, N× the cost,
 * the same file N times in search. This module collapses that: each folder tree
 * is owned (indexed) by exactly one project; the rest are "satellites" that
 * reuse the owner's index (the read path redirects their file scope to the
 * owner + a subpath prefix).
 *
 * Ownership is pure path math over the set of indexing-eligible projects, so it
 * is deterministic and easy to test. The indexer recomputes it whenever folders
 * or gates change.
 */

import path from 'node:path';

export interface ProjectFolderRef {
  id: string;
  /** Absolute folder path (as stored on the project row). */
  folderPath: string;
  /** ISO timestamp; tie-breaks ownership when two projects share one folder. */
  createdAt?: string;
}

export interface FolderOwnership {
  /** Project that actually indexes the tree this project's folder lives in. */
  ownerProjectId: string;
  /** True when this project IS the owner (it indexes its own tree). */
  isOwner: boolean;
  /** POSIX subpath from the owner's folder down to this project's folder; ''
   * when they are the same folder. Used to scope a satellite's reads to its
   * slice of the owner's index. */
  prefix: string;
}

/** Normalize a folder path for comparison: absolute, no trailing separators.
 * (Symlink collapse via realpath is deferred — paths are stored already-resolved
 * by assertFolderExists, and the project alias symlinks point at those targets.) */
export function canonicalFolder(folderPath: string): string {
  // This lexical reducer intentionally does not fold case. Callers that need
  // filesystem identity must realpath existing folders first; link maintenance
  // does this so case-sensitive Windows directories remain distinct.
  const resolved = path.resolve(folderPath.trim());
  // Do not turn `C:\\` or a UNC share root into a drive-relative path.
  return resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/, '');
}

/** True if `ancestor` is the same folder as, or an ancestor of, `descendant`.
 * Both must be canonical (see {@link canonicalFolder}). */
export function isAncestorOrSame(ancestor: string, descendant: string): boolean {
  const relative = path.relative(ancestor, descendant);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export interface FolderOverlap {
  projectId: string;
  projectName: string | null;
  /** How the candidate folder relates to the other project's folder. */
  relation: 'same' | 'inside' | 'contains';
}

/**
 * Pure path math for the link-time overlap warning: which other projects'
 * folders are the same as, contain, or sit inside `targetFolder`. Overlapping
 * links are ALLOWED (embeddings are content-addressed and ownership collapses
 * nested trees to one indexing owner) — the caller warns, never blocks.
 */
export function findFolderOverlaps(
  targetFolder: string,
  others: Array<{ id: string; name?: string | null; folderPath: string | null }>
): FolderOverlap[] {
  const target = canonicalFolder(targetFolder);
  const out: FolderOverlap[] = [];
  for (const other of others) {
    if (!other.folderPath || other.folderPath.trim().length === 0) continue;
    const canon = canonicalFolder(other.folderPath);
    const relation =
      canon === target
        ? 'same'
        : isAncestorOrSame(canon, target)
          ? 'inside'
          : isAncestorOrSame(target, canon)
            ? 'contains'
            : null;
    if (relation) {
      out.push({ projectId: other.id, projectName: other.name ?? null, relation });
    }
  }
  return out;
}

/** Human-readable, non-blocking warning for {@link findFolderOverlaps} hits. */
export function folderOverlapWarning(overlaps: FolderOverlap[]): string | null {
  if (overlaps.length === 0) return null;
  const first = overlaps[0];
  const label = first.projectName ? `"${first.projectName}"` : first.projectId;
  const relationText =
    first.relation === 'same'
      ? `is the same folder as project ${label}`
      : first.relation === 'inside'
        ? `is inside project ${label}'s folder`
        : `contains project ${label}'s folder`;
  const more = overlaps.length > 1 ? ` (and ${overlaps.length - 1} more)` : '';
  return `This folder ${relationText}${more} — overlapping files will be shared, not re-indexed.`;
}

interface CanonRef extends ProjectFolderRef {
  canon: string;
}

/** Stable order for projects sharing one folder: earliest created wins, then id. */
function tieBreakLess(a: CanonRef, b: CanonRef): boolean {
  const ac = a.createdAt ?? '';
  const bc = b.createdAt ?? '';
  if (ac !== bc) return ac < bc;
  return a.id < b.id;
}

/**
 * Compute folder ownership for every project in `projects`. Pass only the
 * indexing-eligible set (gate enabled) so a project nested under a parent whose
 * indexing is off still owns its own subtree.
 *
 * Owner of project P = the candidate whose canonical folder is the shallowest
 * ancestor-or-equal of P's folder (the topmost folder that contains P). Among
 * candidates that all contain P, "shallowest" is simply the shortest canonical
 * path; an exact-length tie can only be an identical folder, resolved by
 * {@link tieBreakLess}. A project with no containing folder owns itself.
 */
export function resolveOwnership(projects: ProjectFolderRef[]): Map<string, FolderOwnership> {
  const refs: CanonRef[] = projects
    .filter((p) => p.folderPath && p.folderPath.trim().length > 0)
    .map((p) => ({ ...p, canon: canonicalFolder(p.folderPath) }));

  const out = new Map<string, FolderOwnership>();
  for (const p of refs) {
    let best: CanonRef | null = null;
    for (const q of refs) {
      if (!isAncestorOrSame(q.canon, p.canon)) continue;
      if (best === null || q.canon.length < best.canon.length) {
        best = q;
      } else if (q.canon.length === best.canon.length && tieBreakLess(q, best)) {
        best = q; // identical folder — deterministic owner
      }
    }
    const owner = best ?? p; // self always matches, so best is never null in practice
    const prefix =
      owner.canon === p.canon ? '' : path.relative(owner.canon, p.canon).split(path.sep).join('/');
    out.set(p.id, { ownerProjectId: owner.id, isOwner: owner.id === p.id, prefix });
  }
  return out;
}
