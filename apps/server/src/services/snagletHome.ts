/**
 * snagletHome — the per-user Snaglet config directory (`~/.snaglet`) and its required layout.
 *
 * All per-user state the desktop app keeps on disk lives under `~/.snaglet`. This
 * module owns the directories that must exist up front (REQUIRED_DIRS), so the
 * app can assume the scaffold is present from first boot. `ensureSnagletHome()` runs
 * once at startup and is best-effort: a failure to create a directory is
 * logged but never blocks boot.
 */

import { homedir } from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  writeFile,
  unlink,
  readdir,
  realpath,
  chmod,
  rename,
  rm,
  stat,
  truncate,
} from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, safeJsonParse } from '@snaglet/shared/utils';
import { resolveConfiguredPath } from '@snaglet/shared/utils/paths';
import { SERVER_ERROR_LOG_FILE, SERVER_LOG_FILE, logger } from '@server/config/logger';
import {
  ESPEAK_ARCHIVE,
  ESPEAK_DATA_DIRNAME,
  QUALITY_STT_MANIFEST,
  STT_MANIFEST,
  VAD_MANIFEST,
  VOICE_CATALOG,
} from './voice/voiceModelManifest';
import { RERANKER_MODEL_MANIFEST } from './reranking/rerankerModelManifest';
import { getDisabledLocalModels, setLocalModelEnabled } from './localModels/localModelPreferences';

const LOG_PREFIX = '[snagletHome]';

/**
 * The pointer file. Lives outside SNAGLET_HOME so it survives a home-path change.
 * Defaults to `~/.snaglet.json`; `SNAGLET_HOME_POINTER_FILE` lets a second checkout keep
 * its own pointer. `homePath` is the active override; `recentPaths` is the
 * switch history. The env value is `~`-expanded and must be absolute: dotenv
 * delivers `~/...` literally, and a cwd-relative pointer file would land in
 * whatever directory the process started in.
 */
export const SNAGLET_POINTER_FILE = resolvePointerFilePath();

function resolvePointerFilePath(): string {
  const configured = process.env.SNAGLET_HOME_POINTER_FILE?.trim();
  if (configured) return resolveConfiguredPath(configured, 'SNAGLET_HOME_POINTER_FILE');
  return path.join(homedir(), '.snaglet.json');
}

export interface SnagletPointer {
  homePath?: string;
  recentPaths?: string[];
}

/** Best-effort read of the pointer file; a missing or malformed file reads as
 *  an empty pointer. Takes the path so it is unit-testable without touching
 *  the real home. */
export function readSnagletPointer(pointerFile: string = SNAGLET_POINTER_FILE): SnagletPointer {
  try {
    const parsed = safeJsonParse<unknown>(readFileSync(pointerFile, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed as SnagletPointer;
  } catch {
    // No pointer file yet, or unreadable.
  }
  return {};
}

/**
 * Resolve SNAGLET_HOME from the three sources, in precedence order. Pure: takes the
 * env value, the resolved pointer, and the default so it can be exercised in
 * isolation. The module-level `SNAGLET_HOME` is computed from the real sources.
 *
 * Both configured sources are `~`-expanded and must be absolute (see
 * `resolveConfiguredPath`): dotenv never shell-expands, and a cwd-relative
 * value would create stray homes like `<repo>/~/.snaglet`, each with its own
 * PostgreSQL cluster. A relative value throws, failing boot closed.
 */
export function resolveHomeFrom(
  env: string | undefined,
  pointer: SnagletPointer,
  defaultHome: string
): string {
  // 1. Explicit env var — wins. In the packaged app the Rust shell resolves the
  //    path (incl. ~/.snaglet.json) and injects SNAGLET_HOME, so this branch covers it too.
  const fromEnv = env?.trim();
  if (fromEnv) return resolveConfiguredPath(fromEnv, 'SNAGLET_HOME');
  // 2. `~/.snaglet.json` homePath — set by Settings → Profile; effective after restart.
  //    Only reached when Node runs without the Rust shell (e.g. `pnpm dev`).
  const configured = pointer.homePath?.trim();
  if (configured) return resolveConfiguredPath(configured, 'homePath in the Snaglet pointer file');
  // 3. Default.
  return defaultHome;
}

function resolveSnagletHome(): string {
  return resolveHomeFrom(
    process.env.SNAGLET_HOME,
    readSnagletPointer(),
    path.join(homedir(), '.snaglet')
  );
}

/** Root of the per-user Snaglet config directory: `~/.snaglet` (or the current override). */
export const SNAGLET_HOME = resolveSnagletHome();

/** Per-project folder aliases live here: `~/.snaglet/projects/<projectId>`. */
export const SNAGLET_PROJECTS_DIR = path.join(SNAGLET_HOME, 'projects');

/** Database snapshots live here: `~/.snaglet/backups/`. */
export const SNAGLET_BACKUPS_DIR = path.join(SNAGLET_HOME, 'backups');

/** User-installed external tools live here: `~/.snaglet/tools/`. */
export const SNAGLET_TOOLS_DIR = path.join(SNAGLET_HOME, 'tools');

/** User-defined lifecycle hooks live here: `~/.snaglet/hooks/`. */
export const SNAGLET_HOOKS_DIR = path.join(SNAGLET_HOME, 'hooks');
/** Personal skills: `<snaglet-home>/skills/<slug>/SKILL.md`. */
export const SNAGLET_SKILLS_DIR = path.join(SNAGLET_HOME, 'skills');

/** Generated artifacts are kept out of user-authored tool/hook folders. */
const SNAGLET_BUILDS_DIR = path.join(SNAGLET_HOME, 'build');
export const SNAGLET_HOOK_BUILDS_DIR = path.join(SNAGLET_BUILDS_DIR, 'hooks');
export const SNAGLET_RUNTIME_DIR = path.join(SNAGLET_HOME, 'runtime');
export const SNAGLET_SDK_RUNTIME_DIR = path.join(SNAGLET_RUNTIME_DIR, 'sdk');

/** Agent-captured & uploaded image bytes live here: `~/.snaglet/images/`. */
const SNAGLET_IMAGES_DIR = path.join(SNAGLET_HOME, 'images');
const SNAGLET_MODELS_DIR = path.join(SNAGLET_HOME, 'models');
const SNAGLET_LOGS_DIR = path.join(SNAGLET_HOME, 'logs');
const SNAGLET_TEMP_DIR = path.join(SNAGLET_HOME, 'temp');

const SNAGLET_HOME_MANIFEST = 'home.json';
const SNAGLET_HOME_SCHEMA_VERSION = 1;
const STALE_DOWNLOAD_AGE_MS = 24 * 60 * 60 * 1_000;

export interface SnagletHomeManifest {
  schemaVersion: number;
  installationId: string;
  createdByVersion: string;
  lastOpenedByVersion: string;
  databaseMode: 'managed' | 'external';
}

/**
 * Directories that must exist from first boot, independent of whether any one
 * subsystem has touched them yet. Add to this list as fresh-launch bootstrap grows.
 */
const REQUIRED_DIRS: readonly string[] = [
  SNAGLET_PROJECTS_DIR,
  SNAGLET_BACKUPS_DIR,
  SNAGLET_TOOLS_DIR,
  SNAGLET_HOOKS_DIR,
  SNAGLET_SKILLS_DIR,
  SNAGLET_HOOK_BUILDS_DIR,
  SNAGLET_SDK_RUNTIME_DIR,
  SNAGLET_IMAGES_DIR,
  SNAGLET_MODELS_DIR,
  SNAGLET_LOGS_DIR,
  SNAGLET_TEMP_DIR,
];

/**
 * Result of validating a candidate home path. On success, `path` is the
 * canonical (realpath-resolved) form the caller must persist so downstream
 * exact-string comparisons (recentPaths dedupe, pointer/DB-lock equality) stay
 * consistent regardless of input casing or symlinks. On failure, `reason` is a
 * user-facing message and `code` lets the UI distinguish guardable cases.
 */
export type HomePathValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string; code?: 'invalid' | 'not_writable' | 'not_snaglet_home' };

/** Files/dirs whose presence marks a folder as an existing Snaglet home. */
const SNAGLET_HOME_MARKERS: readonly string[] = ['projects', 'postgres'];

/**
 * Canonicalize a path for storage and comparison: resolve symlinks/case via
 * realpath when the target exists, otherwise fall back to a normalized absolute
 * path (a not-yet-created folder has no realpath). This is the single point
 * where a path becomes canonical before it is persisted.
 */
export async function canonicalizeHomePath(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch {
    return path.normalize(absolute);
  }
}

/**
 * Is `dir` safe to adopt as a Snaglet home? An empty (or absent) folder is fine, and
 * a folder already shaped like a Snaglet home is fine. A non-empty folder that lacks
 * Snaglet-home markers is rejected — adopting it would scatter Snaglet data (projects/,
 * backups/, a blank DB) into unrelated content such as a source repo.
 */
async function isAdoptableHomeDir(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return true; // doesn't exist yet → will be created empty
  }
  const visible = entries.filter((e) => !e.startsWith('.') || e === '.snaglet');
  if (visible.length === 0) return true; // empty → fine
  return SNAGLET_HOME_MARKERS.some((m) => entries.includes(m)); // existing Snaglet home → fine
}

/**
 * Validate that `candidate` can serve as a Snaglet home dir: it can be created if
 * absent and is actually writable. "Valid" means writable, not merely existing —
 * this catches read-only locations and unplugged drives that a bare existence
 * check would miss. Non-destructive: it removes its own write probe.
 */
export async function validateHomePath(candidate: string): Promise<HomePathValidation> {
  const target = candidate.trim();
  if (!target) return { ok: false, reason: 'Path is empty.', code: 'invalid' };
  if (!path.isAbsolute(target)) {
    return { ok: false, reason: 'Path must be absolute.', code: 'invalid' };
  }

  // Suitability: refuse to adopt a populated folder that isn't already a Snaglet
  // home. Checked before mkdir so a rejected target is never partially seeded.
  if (!(await isAdoptableHomeDir(target))) {
    return {
      ok: false,
      reason: `Folder ${target} is not empty and isn't an existing Snaglet home. Choose an empty folder or an existing Snaglet home to avoid mixing Snaglet data with other files.`,
      code: 'not_snaglet_home',
    };
  }

  try {
    await mkdir(target, { recursive: true });
  } catch {
    return { ok: false, reason: `Cannot create folder at ${target}.`, code: 'invalid' };
  }
  const probe = path.join(target, '.snaglet-write-probe');
  try {
    await writeFile(probe, '');
    await unlink(probe);
  } catch {
    return { ok: false, reason: `Folder ${target} is not writable.`, code: 'not_writable' };
  }

  // Persist the canonical form so downstream exact-string comparisons stay
  // consistent regardless of input casing or symlinks.
  return { ok: true, path: await canonicalizeHomePath(target) };
}

/**
 * Ensure the required directory structure exists under `home` (defaults to the
 * resolved SNAGLET_HOME). Idempotent and best-effort — each directory is created
 * with `{ recursive: true }`, and any failure is logged rather than thrown so
 * it can never block server startup. Existing folders are reused; only missing
 * subdirectories are created (partial folders are completed, not clobbered).
 */
export async function ensureSnagletHome(home: string = SNAGLET_HOME): Promise<void> {
  await mkdir(home, { recursive: true });
  await secureDirectory(home);
  await ensureHomeManifest(home);
  const requiredDirs = REQUIRED_DIRS.map((dir) =>
    path.join(home, path.relative(SNAGLET_HOME, dir))
  );
  await Promise.all(
    requiredDirs.map(async (dir) => {
      try {
        await mkdir(dir, { recursive: true });
        await secureDirectory(dir);
      } catch (err) {
        logger.warn(`${LOG_PREFIX} could not create ${dir}`, err);
      }
    })
  );
  await cleanupStaleDownloads(path.join(home, 'models'));
  logger.info(`${LOG_PREFIX} config directory ready`, { home, required: requiredDirs });
}

export interface SnagletStorageCategory {
  key: 'database' | 'backups' | 'models' | 'images' | 'logs' | 'tools' | 'hooks' | 'build' | 'temp';
  path: string;
  bytes: number;
  removable: boolean;
  /** What the category's Clear button does, in user-facing words; null when it has none. */
  clearDescription: string | null;
}

type SnagletStorageSpec = { key: SnagletStorageCategory['key']; dir: string } & (
  | { removable: false }
  | { removable: true; clearDescription: string }
);

/**
 * Every storage category under the Snaglet home. Only reconstructable data is
 * removable, and each removable one says what clearing it does: what goes,
 * and how it comes back (see clearSnagletStorageCategory and DELETE
 * /api/snaglet-home/storage/:key).
 */
const SNAGLET_STORAGE_SPECS: readonly SnagletStorageSpec[] = [
  { key: 'database', dir: 'postgres', removable: false },
  { key: 'backups', dir: 'backups', removable: false },
  {
    key: 'models',
    dir: 'models',
    removable: true,
    clearDescription:
      'Deletes downloaded local models for search, search ranking and voice. The search ' +
      'model downloads again when Snaglet needs it. Search ranking and voice models come back ' +
      'with Enable and download under Local models.',
  },
  { key: 'images', dir: 'images', removable: false },
  {
    key: 'logs',
    dir: 'logs',
    removable: true,
    clearDescription:
      'Deletes what Snaglet has logged so far. Logs are only used for troubleshooting, so this is ' +
      'safe, and new entries keep being written.',
  },
  { key: 'tools', dir: 'tools', removable: false },
  { key: 'hooks', dir: 'hooks', removable: false },
  {
    key: 'build',
    dir: 'build',
    removable: true,
    clearDescription:
      'Deletes the compiled copies of your custom hooks. Your hook code is untouched, and ' +
      'Snaglet rebuilds each hook from it right away. Use this to free space or force a clean ' +
      'rebuild.',
  },
  {
    key: 'temp',
    dir: 'temp',
    removable: true,
    clearDescription:
      "Deletes scratch files in Snaglet's temp folder, such as voice debug recordings. Nothing " +
      'in Snaglet depends on them, so this is safe.',
  },
];

export interface SnagletVoiceStorageModel {
  id: string;
  component: 'reranker' | 'stt' | 'vad' | 'tts' | 'shared';
  name: string;
  description: string;
  path: string;
  bytes: number;
  expectedBytes: number;
  installed: boolean;
  removable: boolean;
  disabled: boolean;
}

async function directoryBytes(root: string): Promise<number> {
  const info = await stat(root).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    total += await directoryBytes(path.join(root, entry.name));
  }
  return total;
}

export async function getSnagletStorage(
  home: string = SNAGLET_HOME
): Promise<SnagletStorageCategory[]> {
  return Promise.all(
    SNAGLET_STORAGE_SPECS.map(async (spec) => {
      const absolute = path.join(home, spec.dir);
      return {
        key: spec.key,
        path: absolute,
        bytes: await directoryBytes(absolute),
        removable: spec.removable,
        clearDescription: spec.removable ? spec.clearDescription : null,
      };
    })
  );
}

function modelPath(home: string, manifestDir: string): string {
  return path.join(home, manifestDir.replace(/^~\/\.snaglet\/?/, ''));
}

async function voiceStorageEntry(
  home: string,
  disabled: ReadonlySet<string>,
  input: Omit<SnagletVoiceStorageModel, 'path' | 'bytes' | 'installed' | 'disabled'> & {
    dir: string;
  }
): Promise<SnagletVoiceStorageModel> {
  const absolute = modelPath(home, input.dir);
  const bytes = await directoryBytes(absolute);
  return {
    ...input,
    path: absolute,
    bytes,
    installed: bytes > 0,
    disabled: disabled.has(input.id),
  };
}

export async function getSnagletVoiceStorage(
  home: string = SNAGLET_HOME
): Promise<SnagletVoiceStorageModel[]> {
  const manifestBytes = (manifest: { files: readonly { bytes: number }[] }): number =>
    manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  const disabled = await getDisabledLocalModels();
  return Promise.all([
    voiceStorageEntry(home, disabled, {
      id: 'reranker',
      component: 'reranker',
      name: 'Workspace reranker',
      description: 'Local precision ranking model used by workspace search.',
      dir: RERANKER_MODEL_MANIFEST.dir,
      expectedBytes: manifestBytes(RERANKER_MODEL_MANIFEST),
      removable: true,
    }),
    voiceStorageEntry(home, disabled, {
      id: 'stt-streaming',
      component: 'stt',
      name: 'Streaming speech recognition',
      description: 'Low-latency model for live voice transcripts.',
      dir: STT_MANIFEST.dir,
      expectedBytes: manifestBytes(STT_MANIFEST),
      removable: true,
    }),
    voiceStorageEntry(home, disabled, {
      id: 'stt-quality',
      component: 'stt',
      name: 'Quality speech recognition',
      description: 'Casing and punctuation pass for finalized transcripts.',
      dir: QUALITY_STT_MANIFEST.dir,
      expectedBytes: manifestBytes(QUALITY_STT_MANIFEST),
      removable: true,
    }),
    voiceStorageEntry(home, disabled, {
      id: 'vad',
      component: 'vad',
      name: 'Voice activity detection',
      description: 'Detects speech boundaries during voice sessions.',
      dir: VAD_MANIFEST.dir,
      expectedBytes: manifestBytes(VAD_MANIFEST),
      removable: true,
    }),
    voiceStorageEntry(home, disabled, {
      id: 'tts-espeak',
      component: 'shared',
      name: 'Piper phonemizer data',
      description: 'Shared pronunciation data used by every local voice.',
      dir: `~/.snaglet/models/tts/${ESPEAK_DATA_DIRNAME}`,
      expectedBytes: ESPEAK_ARCHIVE.bytes,
      removable: true,
    }),
    ...VOICE_CATALOG.map((voice) =>
      voiceStorageEntry(home, disabled, {
        id: `tts:${voice.id}`,
        component: 'tts',
        name: voice.label,
        description: voice.description,
        dir: voice.manifest.dir,
        expectedBytes: manifestBytes(voice.manifest),
        removable: true,
      })
    ),
  ]);
}

/**
 * Delete a local model's files and mark it disabled. Bad input throws an
 * AppError (unknown id → 404, a model that can't be removed → 400); anything
 * else that fails is an internal error.
 */
export async function clearSnagletVoiceStorageModel(
  id: string,
  home: string = SNAGLET_HOME
): Promise<void> {
  const model = (await getSnagletVoiceStorage(home)).find((entry) => entry.id === id);
  if (!model) {
    throw new AppError('Unknown local model.', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  if (!model.removable) {
    throw new AppError(
      'This local model cannot be removed.',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  const homeRoot = path.resolve(home);
  const target = path.resolve(model.path);
  if (!target.startsWith(`${homeRoot}${path.sep}`)) throw new Error('Invalid local model path.');
  await rm(target, { recursive: true, force: true });
  await setLocalModelEnabled(id, false);
}

export async function getSnagletVoiceStorageModel(
  id: string,
  home: string = SNAGLET_HOME
): Promise<SnagletVoiceStorageModel> {
  const model = (await getSnagletVoiceStorage(home)).find((entry) => entry.id === id);
  if (!model) throw new Error('Unknown local model.');
  return model;
}

/**
 * Log files a running Snaglet keeps open: the server logger's own files, and the
 * desktop shell's capture of the server's stdout/stderr (`CONSOLE_LOG_NAME` in
 * apps/desktop/src-tauri/src/sidecar.rs). All are written in append mode, so
 * truncating one in place makes the next line land at its start. Deleting one
 * instead would send every later line to an unlinked file, lost and still
 * taking disk space, until Snaglet restarts.
 */
const OPEN_LOG_FILES: ReadonlySet<string> = new Set([
  SERVER_LOG_FILE,
  SERVER_ERROR_LOG_FILE,
  'sidecar.console.log',
]);

/** Empty the logs folder: truncate the open log files, delete everything else. */
async function clearLogsDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) => {
      const target = path.join(dir, entry.name);
      return entry.isFile() && OPEN_LOG_FILES.has(entry.name)
        ? truncate(target, 0)
        : rm(target, { recursive: true, force: true });
    })
  );
}

export async function clearSnagletStorageCategory(
  key: 'models' | 'logs' | 'build' | 'temp',
  home: string = SNAGLET_HOME
): Promise<void> {
  const target = path.join(
    home,
    { models: 'models', logs: 'logs', build: 'build', temp: 'temp' }[key]
  );
  if (key === 'logs') {
    await clearLogsDirectory(target);
  } else {
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
  }
  await secureDirectory(target);
}

function appVersion(): string {
  return (
    process.env.SNAGLET_APP_VERSION?.trim() || process.env.npm_package_version?.trim() || '0.1.0'
  );
}

async function secureDirectory(dir: string): Promise<void> {
  if (process.platform !== 'win32') await chmod(dir, 0o700);
}

/**
 * Manifest-local view of how this process reached its database. Deliberately
 * does not call `resolveDatabaseMode()`, which throws on a malformed URL: this
 * runs unguarded at the start of `startServer()`, so a bad `SNAGLET_DATABASE_URL`
 * would kill boot before anything could report it. Validity is enforced by
 * the database layer at connect time.
 */
function resolveManifestDatabaseMode(): SnagletHomeManifest['databaseMode'] {
  return process.env.SNAGLET_DATABASE_URL?.trim() ? 'external' : 'managed';
}

/**
 * Create/update the non-secret Snaglet-home identity file. A newer or malformed
 * manifest fails closed: opening it with older code could corrupt user data.
 * A home without a manifest is adopted in place without moving data.
 */
export async function ensureHomeManifest(home: string): Promise<SnagletHomeManifest> {
  const manifestPath = path.join(home, SNAGLET_HOME_MANIFEST);
  const version = appVersion();
  let manifest: SnagletHomeManifest;
  if (existsSync(manifestPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error(`Snaglet home manifest is malformed: ${manifestPath}`);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as SnagletHomeManifest).schemaVersion !== 'number' ||
      typeof (parsed as SnagletHomeManifest).installationId !== 'string'
    ) {
      throw new Error(`Snaglet home manifest is invalid: ${manifestPath}`);
    }
    manifest = parsed as SnagletHomeManifest;
    if (manifest.schemaVersion > SNAGLET_HOME_SCHEMA_VERSION) {
      throw new Error(
        `Snaglet home schema ${manifest.schemaVersion} is newer than this app supports (${SNAGLET_HOME_SCHEMA_VERSION})`
      );
    }
    manifest.lastOpenedByVersion = version;
    manifest.databaseMode = resolveManifestDatabaseMode();
  } else {
    manifest = {
      schemaVersion: SNAGLET_HOME_SCHEMA_VERSION,
      installationId: randomUUID(),
      createdByVersion: version,
      lastOpenedByVersion: version,
      databaseMode: resolveManifestDatabaseMode(),
    };
  }
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, manifestPath);
  if (process.platform !== 'win32') await chmod(manifestPath, 0o600);
  return manifest;
}

/** Remove only abandoned, process-scoped model downloads. Published model
 * files and user-authored content are never touched. */
export async function cleanupStaleDownloads(modelsDir: string, now = Date.now()): Promise<number> {
  if (!existsSync(modelsDir)) return 0;
  let removed = 0;
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (/\.\d+\.download$/.test(entry.name)) {
        const info = await stat(absolute);
        if (now - info.mtimeMs >= STALE_DOWNLOAD_AGE_MS) {
          await rm(absolute, { force: true });
          removed += 1;
        }
      }
    }
  };
  await visit(modelsDir);
  if (removed > 0) logger.info(`${LOG_PREFIX} removed stale model downloads`, { removed });
  return removed;
}
