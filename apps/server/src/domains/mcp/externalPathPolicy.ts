/**
 * externalPathPolicy — host-filesystem confinement for external MCP callers.
 *
 * An API-key client reaches the host filesystem only through the search
 * tool's `kind:"code"` (ripgrep) and `kind:"files"` arms. Both take a
 * caller-chosen `path`, so both are confined here to the folders the user
 * deliberately linked to projects. Containment is decided on canonical paths
 * (fs.realpath), because a lexical check passes `<project>/link -> ~/.ssh`
 * while the tool would happily follow the link. Snaglet's own storage
 * (tokens under `runtime/`, backups, the managed database) is refused even
 * when a project folder happens to contain it.
 */

import path from 'path';
import { realpath } from 'fs/promises';

/** Canonical absolute path, or null when the path does not exist. */
export async function canonicalPath(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
}

/** True when `target` is `root` or inside it. Both must already be canonical. */
export function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export type ConfinementResult =
  | { ok: true; root: string; target: string }
  | { ok: false; reason: string };

/**
 * Resolve `candidate` to a canonical path that lies inside one of the
 * canonical `roots` and outside `snagletHome`. Roots missing on disk are ignored.
 */
export async function confineToRoots(
  candidate: string,
  roots: readonly string[],
  snagletHome: string
): Promise<ConfinementResult> {
  const target = await canonicalPath(candidate);
  if (!target) return { ok: false, reason: 'path does not exist on the Snaglet machine' };

  const home = (await canonicalPath(snagletHome)) ?? path.resolve(snagletHome);
  if (isWithinRoot(home, target)) {
    return { ok: false, reason: "path is inside Snaglet's own storage" };
  }
  if (isWithinRoot(target, home)) {
    // A recursive search from here would walk into Snaglet's storage.
    return { ok: false, reason: "path contains Snaglet's own storage; pick a narrower folder" };
  }

  for (const root of roots) {
    const canonicalRoot = await canonicalPath(root);
    if (canonicalRoot && isWithinRoot(canonicalRoot, target)) {
      return { ok: true, root: canonicalRoot, target };
    }
  }
  return { ok: false, reason: 'path is outside every linked project folder' };
}
