/**
 * projectFolder — the on-disk link between a project and its working folder.
 *
 * Each project that has a `folder_path` gets an entry inside the Snaglet projects
 * root (`~/.snaglet/projects/`, scaffolded by snagletHome) named by the project's id:
 *
 *   ~/.snaglet/projects/<projectId>   ->   <folder_path>
 *
 * The symlink lets every consumer reach a project's working tree through one
 * stable, id-keyed path regardless of where the user actually keeps the folder
 * (see search/filesystemSearch.ts, which walks this alias). Creating the link
 * is idempotent; clearing a project's folder removes it.
 *
 * Validation lives here too: `assertFolderExists` throws a 400 AppError when
 * the user-entered path is missing or not a directory, so the projects route
 * can reject a bad path before persisting it.
 */

import path from 'path';
import { Projects } from '@snaglet/db/tables/projects';
import { lstat, mkdir, readdir, readlink, realpath, rm, stat, symlink } from 'fs/promises';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { SNAGLET_PROJECTS_DIR } from '@server/services/snagletHome';
import { logger } from '@server/config/logger';
import { expandHome } from '@server/utils/paths';

/** Absolute path of a project's alias under the Snaglet projects root. */
export function projectAliasPath(projectId: string): string {
  return path.join(SNAGLET_PROJECTS_DIR, projectId);
}

/** Expand a leading `~` to the user's home directory (the picker returns
 * absolute paths, but a hand-typed `~/code/app` should still resolve). */
/**
 * Resolve and validate a user-entered folder path. Throws a 400 AppError when
 * the path does not exist or is not a directory. Returns the absolute path on
 * success — callers persist and symlink THAT, so what we validated is exactly
 * what we link.
 */
export async function assertFolderExists(folderPath: string): Promise<string> {
  const resolved = path.resolve(expandHome(folderPath.trim()));
  let entry;
  try {
    entry = await stat(resolved);
  } catch {
    throw new AppError(
      `Folder not found: ${resolved}`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  if (!entry.isDirectory()) {
    throw new AppError(
      `Not a directory: ${resolved}`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return resolved;
}

/**
 * Create or refresh the `~/.snaglet/projects/<projectId>` symlink so it points at
 * `folderPath`. Idempotent — a link already pointing at the right target is
 * left untouched; a stale link is replaced, while an unexpected file or
 * directory is preserved rather than risking deletion of user data.
 *
 * Does not validate that `folderPath` exists (symlinks may legitimately point
 * at a not-yet-created target); call `assertFolderExists` first when the path
 * came from user input. Returns the alias path.
 */
export async function linkProjectFolder(projectId: string, folderPath: string): Promise<string> {
  const aliasPath = projectAliasPath(projectId);
  const target = path.resolve(folderPath);
  await mkdir(path.dirname(aliasPath), { recursive: true });
  try {
    const existing = await lstat(aliasPath);
    if (existing.isSymbolicLink()) {
      const current = await readlink(aliasPath);
      const currentResolved = path.resolve(path.dirname(aliasPath), current);
      if (await pathsReferToSameFolder(currentResolved, target)) return aliasPath;
      await rm(aliasPath, { force: true });
    } else {
      throw new Error(`Project alias path is not a link and will not be replaced: ${aliasPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Windows directory symlinks require privileges in many normal-user setups;
  // junctions do not and still provide the stable local directory alias we need.
  await symlink(target, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
  return aliasPath;
}

async function pathsReferToSameFolder(left: string, right: string): Promise<boolean> {
  if (left === right) return true;
  try {
    // Existing folders get filesystem identity rather than case folding. This
    // preserves distinct entries in a case-sensitive Windows directory.
    return (await realpath(left)) === (await realpath(right));
  } catch {
    // A not-yet-created target cannot be realpathed. Native relative-path
    // semantics cover drive letters and UNC roots without string-prefix bugs.
    return path.relative(left, right) === '';
  }
}

/** Remove a project's alias symlink. Best-effort — used when a project's
 * folder path is cleared. */
export async function unlinkProjectFolder(projectId: string): Promise<void> {
  const aliasPath = projectAliasPath(projectId);
  const info = await lstat(aliasPath).catch((err) => {
    logger.warn(
      `[projectFolder] could not inspect alias for ${projectId}: ${getErrorMessage(err)}`
    );
    return null;
  });
  if (!info) return;
  if (!info.isSymbolicLink()) {
    logger.warn(`[projectFolder] refused to remove non-link alias for ${projectId}: ${aliasPath}`);
    return;
  }
  await rm(aliasPath, { force: true }).catch((err) => {
    // best-effort: not worth failing the request, but leave a trace for debugging
    logger.warn(`[projectFolder] could not remove alias for ${projectId}: ${getErrorMessage(err)}`);
  });
}

/**
 * Boot-time reconcile of `~/.snaglet/projects` aliases. A project's id is its
 * container id; older homes may still hold `~/.snaglet/projects/project-…` alias
 * directories, which must move to the container-keyed name so the id-keyed
 * working-tree path (see filesystemSearch) resolves.
 *
 * There is no stored mapping from a `project-…` id to its container, so each
 * such alias is matched by comparing its symlink target to each project
 * container's folder_path. On a match, the container-id alias is ensured and
 * the `project-…` alias dropped; unmatched aliases are left untouched.
 * Idempotent and logged; failures are swallowed per-entry.
 */
export async function reconcileProjectFolderSymlinks(): Promise<void> {
  return Projects.withFolderWriteLock(async (tx) => {
    const projects = (await Projects.listAll(tx)).filter((project) => !project.archived);
    await reconcileAliases(projects);
  });
}

/** Search must not repoint an alias from a context snapshot taken before a relink. */
export async function refreshProjectFolderAlias(projectId: string): Promise<void> {
  return Projects.withFolderWriteLock(async (tx) => {
    const project = await Projects.findById(projectId, tx);
    if (project && !project.archived && project.folderPath) {
      await linkProjectFolder(projectId, project.folderPath);
    } else {
      await unlinkProjectFolder(projectId);
    }
  });
}

async function reconcileAliases(
  projects: ReadonlyArray<{ id: string; folderPath: string | null }>
): Promise<void> {
  // resolved folder path → project container id
  for (const p of projects) {
    const folder = p.folderPath?.trim();
    if (!folder) continue;
    const resolved = path.resolve(folder);
    // Ensure the canonical container-id alias exists (idempotent).
    await linkProjectFolder(p.id, resolved).catch((err) => {
      logger.warn(`[projectFolder] could not ensure alias for ${p.id}: ${getErrorMessage(err)}`);
    });
  }

  const liveIds = new Set(
    projects.filter((project) => project.folderPath?.trim()).map((project) => project.id)
  );
  let entries: string[];
  try {
    entries = await readdir(SNAGLET_PROJECTS_DIR);
  } catch {
    return; // projects dir not scaffolded yet — nothing to migrate
  }

  for (const name of entries) {
    if (name.startsWith('container-') && !liveIds.has(name)) {
      const stalePath = path.join(SNAGLET_PROJECTS_DIR, name);
      const info = await lstat(stalePath).catch(() => null);
      if (info?.isSymbolicLink()) {
        await rm(stalePath, { force: true });
        logger.info(`[projectFolder] removed stale alias ${name}`);
      }
      continue;
    }
    if (!name.startsWith('project-')) continue; // only `project-…` marker-id aliases
    const legacyPath = path.join(SNAGLET_PROJECTS_DIR, name);
    try {
      const info = await lstat(legacyPath);
      if (!info.isSymbolicLink()) continue;
      const target = path.resolve(path.dirname(legacyPath), await readlink(legacyPath));
      let containerId: string | undefined;
      for (const project of projects) {
        const folder = project.folderPath?.trim();
        if (folder && (await pathsReferToSameFolder(target, path.resolve(folder)))) {
          containerId = project.id;
          break;
        }
      }
      // Only migrate when the `project-…` alias points at a folder owned by a
      // live project container. Prefix difference guarantees containerId !== name.
      if (containerId) {
        await rm(legacyPath, { recursive: true, force: true });
        logger.info(
          `[projectFolder] migrated legacy alias ${name} → ${containerId} (folder ${target})`
        );
      } else {
        await rm(legacyPath, { force: true });
        logger.info(`[projectFolder] removed orphaned legacy alias ${name}`);
      }
    } catch (err) {
      logger.warn(`[projectFolder] reconcile skipped alias ${name}: ${getErrorMessage(err)}`);
    }
  }
}
