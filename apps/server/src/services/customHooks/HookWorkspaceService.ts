/**
 * HookWorkspaceService — on-disk CRUD for user-defined hook folders
 * (`{hooksDir}/{hook-name}/hook.ts`), modeled on ToolWorkspaceService. Bundles
 * live under `<SNAGLET_HOME>/build/hooks/<name>/`. This service only manages files:
 * HookRegistryService's FolderScanner is the sole registration authority, so a
 * created or edited hook goes live on the watcher's next debounced pass, not
 * with the HTTP response; callers must not imply an immediate "deployed" state.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import path from 'path';
import { logger } from '@server/config/logger';
import { AppError, ConflictError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { CUSTOM_HOOKS_DIR, HOOK_REQUIRED_FILES } from './HookRegistryService';
import { SNAGLET_HOME, SNAGLET_HOOK_BUILDS_DIR } from '@server/services/snagletHome';
import { moveToSystemTrash, type HookTrashOutcome, type SystemTrashFn } from './systemTrash';

// Overridable for tests (mirrors ToolWorkspaceService's TOOL_WORKSPACES_DIR).
// Defaults to the same directory HookRegistryService's FolderScanner watches,
// so a REST-created hook folder lands exactly where the watcher will find it.
const HOOKS_DIR = process.env.HOOK_WORKSPACES_DIR ?? CUSTOM_HOOKS_DIR;

const LOG_PREFIX = '\x1b[34m[hook-workspace]\x1b[0m';

/**
 * The only file names this service will read or write inside a hook folder.
 * A hard whitelist, not a sanitizer: `fileName` / body keys arrive from HTTP
 * params and JSON bodies already percent-decoded, so `..%2f..%2fetc%2fpasswd`
 * reaches the service as `../../etc/passwd` and a naive `path.join` would walk
 * out of the sandbox (read and write). Anything not listed is a 400 before
 * any fs call.
 */
export const HOOK_WORKSPACE_FILE_NAMES = ['hook.ts'] as const;

function assertAllowedHookFile(fileName: string): void {
  if (!(HOOK_WORKSPACE_FILE_NAMES as readonly string[]).includes(fileName)) {
    throw new AppError(
      `Invalid hook file name "${fileName}" — expected one of: ${HOOK_WORKSPACE_FILE_NAMES.join(', ')}`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
}

/**
 * Containment check behind the whitelist: the resolved path must stay inside
 * the workspace dir. Defense in depth, so a future whitelist edit can never
 * silently reopen the traversal.
 */
function assertInsideDir(baseDir: string, candidatePath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolved);
  if (
    relative !== '' &&
    (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  ) {
    throw new AppError(
      'Resolved file path escapes the hook workspace',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
}

/** Rewrite an absolute path under the user's home as `~/...` for display. */
function toHomeRelative(dir: string): string {
  const home = homedir();
  if (dir === home) return '~';
  if (dir.startsWith(home + path.sep)) return `~${dir.slice(home.length)}`;
  return dir;
}

export interface HookWorkspaceFiles {
  'hook.ts': string;
}

export interface HookWorkspaceInfo {
  hookName: string;
  dir: string;
  /** `dir` rewritten relative to the user's home with a `~` prefix (e.g.
   *  `~/.snaglet/hooks/<name>`) — display-friendly for UI copy that names where
   *  the hook's code physically lives. Falls back to the absolute path when
   *  the workspace lives outside the home directory. */
  homeRelativeDir: string;
  files: string[];
  /** Whether a built bundle exists — the scanner writes this async; a fresh
   *  save always starts `false` until the watcher's next pass builds it. */
  hasBuild: boolean;
}

/** Options for {@link HookWorkspaceServiceClass.finalizeDeleteToTrash}. Every
 *  field exists so tests can run the real move logic against temp dirs with
 *  an injected fake Finder call — production callers pass nothing. */
export interface FinalizeDeleteToTrashOptions {
  /** Platform switch for the Finder path (default: `process.platform`, except
   *  under jest where the fallback path is forced unless `systemTrash` is
   *  injected — tests must never invoke the real Finder). */
  platform?: NodeJS.Platform;
  /** Finder-delete implementation (default: osascript via `moveToSystemTrash`). */
  systemTrash?: SystemTrashFn;
  /** Generated-bundle root (default: `HOOK_BUILDS_DIR` env, then Snaglet build storage). */
  buildDir?: string;
  /** Snaglet-local fallback trash root (default: `HOOK_TRASH_DIR` env, then `<SNAGLET_HOME>/trash`). */
  trashDir?: string;
}

export interface HookWorkspaceDeleteStage {
  hookName: string;
  sourcePath: string;
  /** Exact artifact created by this request, restored on pre-commit failure. */
  stagedPath: string | null;
  /** Same-hook artifacts from this or an earlier interrupted cleanup. */
  cleanupPaths: string[];
}

class HookWorkspaceServiceClass {
  private get dir(): string {
    return HOOKS_DIR;
  }

  /** Ensure the root hooks directory exists. */
  private ensureRoot(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      logger.info(`${LOG_PREFIX} Created hooks directory: ${this.dir}`);
    }
  }

  /** Get the workspace directory for a hook. Sanitizes like
   *  ToolWorkspaceService.toolDir; a name that sanitizes to nothing is a
   *  client input error → operational 400, not a generic 500. */
  private hookDir(hookName: string): string {
    const safe = hookName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) {
      throw new AppError(
        'Invalid hook name — must contain at least one letter, number, "-", or "_"',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    return path.join(this.dir, safe);
  }

  private quarantinePrefix(hookName: string): string {
    return `.snaglet-hook-delete-${Buffer.from(hookName, 'utf8').toString('hex')}--`;
  }

  private listQuarantines(hookName: string): string[] {
    this.ensureRoot();
    const prefix = this.quarantinePrefix(hookName);
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => path.join(this.dir, entry.name))
      .sort();
  }

  private assertHookQuarantine(hookName: string, candidate: string): void {
    const resolvedRoot = path.resolve(this.dir);
    const resolved = path.resolve(candidate);
    const expectedPrefix = this.quarantinePrefix(hookName);
    if (
      path.dirname(resolved) !== resolvedRoot ||
      !path.basename(resolved).startsWith(expectedPrefix)
    ) {
      throw new Error(`Refusing to touch an invalid hook quarantine path: ${candidate}`);
    }
  }

  /**
   * Create a new hook workspace and write `hook.ts`. Overwrites an existing
   * folder if called directly — the POST /api/hooks route guards collisions
   * with an `exists()` check → 409 before calling this (updateFiles is the
   * intentional overwrite path). Only writes the fixed `hook.ts` name; extra
   * keys on the (runtime-untyped) `files` object are ignored.
   */
  async create(hookName: string, files: HookWorkspaceFiles): Promise<HookWorkspaceInfo> {
    this.ensureRoot();
    const dir = this.hookDir(hookName);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path.join(dir, 'hook.ts'), files['hook.ts'], 'utf-8');

    logger.info(`${LOG_PREFIX} Created hook workspace "${hookName}" at ${dir}`);
    return this.getInfo(hookName);
  }

  /**
   * Update specific files in an existing hook workspace. Every key in
   * `files` (a raw HTTP JSON body) is validated against the whitelist before
   * any write, so a key like `"../../../../tmp/evil"` is a 400, never a write,
   * and a request mixing valid and adversarial keys is rejected atomically.
   */
  async updateFiles(
    hookName: string,
    files: Partial<HookWorkspaceFiles>
  ): Promise<HookWorkspaceInfo> {
    const dir = this.hookDir(hookName);
    if (!existsSync(dir)) {
      throw new Error(`Hook workspace "${hookName}" does not exist`);
    }

    const entries = Object.entries(files).filter(([, content]) => content !== undefined);
    for (const [name] of entries) {
      assertAllowedHookFile(name);
      assertInsideDir(dir, path.join(dir, name));
    }
    for (const [name, content] of entries) {
      writeFileSync(path.join(dir, name), content as string, 'utf-8');
    }

    return this.getInfo(hookName);
  }

  /** Get info about a hook workspace. */
  getInfo(hookName: string): HookWorkspaceInfo {
    const dir = this.hookDir(hookName);
    if (!existsSync(dir)) {
      throw new Error(`Hook workspace "${hookName}" does not exist`);
    }

    const files = readdirSync(dir).filter((f) => f !== 'dist');
    const hasBuild = existsSync(path.join(SNAGLET_HOOK_BUILDS_DIR, hookName, 'hook.cjs'));

    return { hookName, dir, homeRelativeDir: toHomeRelative(dir), files, hasBuild };
  }

  /** List all hook workspaces — only folders containing every required file
   *  (currently just `hook.ts`) count, same shape the FolderScanner itself
   *  requires before it will register a folder. */
  listAll(): HookWorkspaceInfo[] {
    this.ensureRoot();
    const entries = readdirSync(this.dir, { withFileTypes: true });
    const results: HookWorkspaceInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const info = this.getInfo(entry.name);
        const hasAllRequired = HOOK_REQUIRED_FILES.every((f) => info.files.includes(f));
        if (hasAllRequired) results.push(info);
      } catch {
        // skip unreadable workspaces
      }
    }

    return results;
  }

  /**
   * Atomically move the source folder to a hidden sibling before the database
   * delete. A missing source is valid: retries reconcile any exact same-hook
   * quarantine left after a prior post-commit cleanup failure, and orphan
   * history can be purged even when no folder remains.
   */
  stageDelete(hookName: string): HookWorkspaceDeleteStage {
    const sourcePath = this.hookDir(hookName);
    const canonicalName = path.basename(sourcePath);
    const previous = this.listQuarantines(canonicalName);
    if (existsSync(sourcePath) && previous.length > 0) {
      throw new ConflictError(
        `Hook "${canonicalName}" has both a live source folder and a pending deletion artifact. Refusing to guess which incarnation to delete; remove or reconcile the live hook first.`
      );
    }
    if (!existsSync(sourcePath)) {
      return {
        hookName: canonicalName,
        sourcePath,
        stagedPath: null,
        cleanupPaths: previous,
      };
    }

    const stagedPath = path.join(
      this.dir,
      `${this.quarantinePrefix(canonicalName)}${Date.now()}-${randomUUID()}`
    );
    this.assertHookQuarantine(canonicalName, stagedPath);
    renameSync(sourcePath, stagedPath);
    logger.info(`${LOG_PREFIX} Quarantined hook workspace "${canonicalName}" for deletion`);
    return {
      hookName: canonicalName,
      sourcePath,
      stagedPath,
      cleanupPaths: [...previous, stagedPath],
    };
  }

  /** Restore only the folder moved by this request; never overwrite a new source. */
  restoreDelete(stage: HookWorkspaceDeleteStage): void {
    if (!stage.stagedPath || !existsSync(stage.stagedPath)) return;
    this.assertHookQuarantine(stage.hookName, stage.stagedPath);
    if (existsSync(stage.sourcePath)) {
      throw new Error(
        `Cannot restore hook "${stage.hookName}" because its source folder now exists; quarantine preserved at ${stage.stagedPath}`
      );
    }
    renameSync(stage.stagedPath, stage.sourcePath);
    logger.info(`${LOG_PREFIX} Restored hook workspace "${stage.hookName}" after failed deletion`);
  }

  /** Permanently remove only validated, exact same-hook quarantine artifacts. */
  finalizeDelete(stage: HookWorkspaceDeleteStage): void {
    for (const candidate of stage.cleanupPaths) {
      this.assertHookQuarantine(stage.hookName, candidate);
      if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
    }
  }

  /**
   * Like finalizeDelete, but moves every same-hook artifact (quarantines and
   * build output) to the OS Trash. On macOS each quarantine is renamed back to
   * `<hooksDir>/<name>` first so Finder's "Put Back" restores it; the caller
   * must hold the registry's managed-delete gate so that reappearance is not
   * scanned as a live hook. Elsewhere, or if osascript fails, artifacts move
   * into `<trashDir>/<timestamp>-<name>/`. Idempotent; fs failures throw.
   */
  async finalizeDeleteToTrash(
    stage: HookWorkspaceDeleteStage,
    opts: FinalizeDeleteToTrashOptions = {}
  ): Promise<HookTrashOutcome> {
    const buildRoot = opts.buildDir ?? process.env.HOOK_BUILDS_DIR ?? SNAGLET_HOOK_BUILDS_DIR;
    const trashRoot =
      opts.trashDir ?? process.env.HOOK_TRASH_DIR ?? path.join(SNAGLET_HOME, 'trash');
    // Under jest the real Finder must never run: force the fallback path
    // unless the test explicitly injected its own systemTrash fake.
    const platform =
      opts.platform ??
      (process.env.NODE_ENV === 'test' && !opts.systemTrash ? 'linux' : process.platform);
    const systemTrash = opts.systemTrash ?? moveToSystemTrash;
    const useFinder = platform === 'darwin';

    let fallbackDir: string | null = null;
    const ensureFallbackDir = (): string => {
      if (!fallbackDir) {
        fallbackDir = path.join(trashRoot, `${Date.now()}-${stage.hookName}`);
        mkdirSync(fallbackDir, { recursive: true });
      }
      return fallbackDir;
    };
    const moveToFallback = (from: string, preferredName: string): void => {
      const dir = ensureFallbackDir();
      let dest = path.join(dir, preferredName);
      for (let n = 2; existsSync(dest); n += 1) dest = path.join(dir, `${preferredName}-${n}`);
      renameSync(from, dest);
    };

    let moved = 0;
    let fellBack = 0;
    const trashOne = async (from: string, preferredName: string): Promise<void> => {
      moved += 1;
      if (useFinder) {
        try {
          await systemTrash(from);
          return;
        } catch (err) {
          logger.warn(
            `${LOG_PREFIX} Finder trash failed for ${from}; using Snaglet trash folder instead: ${getErrorMessage(err)}`
          );
        }
      }
      fellBack += 1;
      moveToFallback(from, preferredName);
    };

    // Quarantined source folder(s) — the request's own plus any left by an
    // earlier interrupted cleanup. Same validation gate as finalizeDelete.
    for (const candidate of stage.cleanupPaths) {
      this.assertHookQuarantine(stage.hookName, candidate);
      if (!existsSync(candidate)) continue;
      let target = candidate;
      if (useFinder && !existsSync(stage.sourcePath)) {
        // Give the Trash item its real name + location so "Put Back" lands
        // in the hooks folder (managed-delete gate keeps the scanner away).
        renameSync(candidate, stage.sourcePath);
        target = stage.sourcePath;
      }
      await trashOne(target, stage.hookName);
    }

    // Generated build output. Renamed to `<name>.build` first so the Trash
    // never holds two identical `<name>` items; the sanitizer strips dots
    // from hook names, so `<name>.build` can never collide with a real hook.
    const buildPath = path.join(buildRoot, stage.hookName);
    if (existsSync(buildPath)) {
      let target = buildPath;
      if (useFinder) {
        let staged = path.join(buildRoot, `${stage.hookName}.build`);
        for (let n = 2; existsSync(staged); n += 1) {
          staged = path.join(buildRoot, `${stage.hookName}.build-${n}`);
        }
        renameSync(buildPath, staged);
        target = staged;
      }
      await trashOne(target, `${stage.hookName}.build`);
    }

    if (moved === 0) return { disposition: 'none', fallbackDir: null };
    const disposition = fellBack > 0 ? 'snaglet-trash' : 'system-trash';
    logger.info(
      `${LOG_PREFIX} Moved hook "${stage.hookName}" artifacts to ${
        disposition === 'system-trash' ? 'the system Trash' : `Snaglet trash (${fallbackDir})`
      }`
    );
    return { disposition, fallbackDir };
  }

  /** Check if a workspace exists. */
  exists(hookName: string): boolean {
    return existsSync(this.hookDir(hookName));
  }

  /** True when a prior committed delete still needs quarantine cleanup. */
  hasPendingDelete(hookName: string): boolean {
    const canonicalName = path.basename(this.hookDir(hookName));
    return this.listQuarantines(canonicalName).length > 0;
  }

  /** Canonical folder/registry name after applying the existing route sanitizer. */
  canonicalName(hookName: string): string {
    return path.basename(this.hookDir(hookName));
  }

  /**
   * Read a file from a hook workspace. Absence is an `AppError` NOT_FOUND
   * (404), not a plain Error (500): the hook builder's Code tab starts empty
   * on a 404 and blocks editing on anything else, so a transient failure is
   * never mistaken for an empty file and overwritten on save. `fileName` is
   * whitelisted first (400): it arrives percent-decoded from a route param,
   * so `../`-style values must never reach the fs.
   */
  readFile(hookName: string, fileName: string): string {
    assertAllowedHookFile(fileName);
    const dir = this.hookDir(hookName);
    const filePath = path.join(dir, fileName);
    assertInsideDir(dir, filePath);
    if (!existsSync(filePath)) {
      throw new AppError(
        `File "${fileName}" not found in hook workspace "${hookName}"`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    return readFileSync(filePath, 'utf-8');
  }

  /** Get the hook workspaces root directory. */
  getWorkspacesDir(): string {
    return this.dir;
  }
}

export const hookWorkspaceService = new HookWorkspaceServiceClass();
