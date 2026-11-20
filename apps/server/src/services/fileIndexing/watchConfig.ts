/**
 * watchConfig — the per-folder opt-in gate and ignore rules for file indexing.
 * A project's folder is indexed only when its `snaglet.config.json` has
 * `embeddings.enabled === true`; `includePaths`, `ignorePaths` and
 * `ignoreFileTypes` in the same object narrow what gets indexed. Ignore rules
 * only add to the denylist in exclusions.ts, never relax it. Parsing is
 * fail-safe: a missing, unreadable or malformed config means "do not watch".
 * The filename has no leading dot so the watcher's dotfile exclusion never
 * hides the gate from the liveness watcher.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { readProjectMarker } from '../projectFolderIdentity';
import type { ProjectIndexConfigStatus } from '@snaglet/shared/types';
import { logger } from '@server/config/logger';

export const WATCH_CONFIG_FILENAME = 'snaglet.config.json';

/** The gate file written for a folder that has none yet. Indexing opt-in is on
 * by default so setting a folder path "just works" without a manual second step. */
const DEFAULT_WATCH_CONFIG = `${JSON.stringify({ embeddings: { enabled: true } }, null, 2)}\n`;

/** Absolute path to a folder's gate file. */
export function watchConfigPath(folderPath: string): string {
  return path.join(folderPath, WATCH_CONFIG_FILENAME);
}

/**
 * Create `folderPath/snaglet.config.json` with embeddings enabled, only if no gate
 * file exists yet. An existing valid config may gain a projectId, but a
 * deliberate `embeddings.enabled: false` keeps its opt-out. Fail-soft: `wx`
 * makes "already exists" a no-op, and other write errors are logged and
 * swallowed (the folder path still saves; indexing stays off). Returns true
 * when this call created the file.
 */
export async function ensureWatchConfig(folderPath: string, projectId?: string): Promise<boolean> {
  try {
    const initial = projectId
      ? `${JSON.stringify({ projectId, embeddings: { enabled: true } }, null, 2)}\n`
      : DEFAULT_WATCH_CONFIG;
    await writeFile(watchConfigPath(folderPath), initial, { flag: 'wx' });
    logger.info(`[fileIndexing] wrote default ${WATCH_CONFIG_FILENAME} to ${folderPath}`);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      if (projectId) await ensureProjectMarker(folderPath, projectId);
      return false;
    }
    logger.warn(
      `[fileIndexing] could not auto-create ${WATCH_CONFIG_FILENAME} in ${folderPath}: ${getErrorMessage(err)}`
    );
    return false;
  }
}

/** Add identity only to a valid, unclaimed config. Never change indexing consent. */
async function ensureProjectMarker(folderPath: string, projectId: string): Promise<void> {
  try {
    const filename = watchConfigPath(folderPath);
    const raw = await readFile(filename, 'utf8');
    const config = readProjectMarker(raw);
    if (!config || config.projectId !== undefined) return;
    // Recheck before writing so a normal intervening user edit is not overwritten.
    if ((await readFile(filename, 'utf8')) !== raw) return;
    await writeFile(filename, `${JSON.stringify({ ...config, projectId }, null, 2)}\n`);
  } catch (err) {
    logger.warn(`[fileIndexing] could not persist project identity: ${getErrorMessage(err)}`);
  }
}

/** Parsed `embeddings` gate config. Arrays are always present (possibly empty)
 * so callers never have to null-check. See {@link readWatchConfig}. */
export interface WatchConfig {
  /**
   * Provenance of the gate file. Every non-`present` status reads as
   * `enabled: false`, but the lifecycle treats them very differently:
   * `missing` (folder exists, file removed/never created) is the intentionally
   * destructive unconfigure signal, while `invalid` (unparseable/wrong-shaped
   * JSON) and `unreadable` (folder unreachable, permission error) must fail
   * safe — stop indexing but never destroy data over ambiguity.
   */
  status: ProjectIndexConfigStatus;
  enabled: boolean;
  /** Empty means all paths are eligible before exclusions are applied. */
  includePaths: string[];
  /** Raw path/glob patterns to skip (compiled by exclusions.compileIgnoreRules). */
  ignorePaths: string[];
  /** Raw file extensions to skip (with or without leading dot; normalized later). */
  ignoreFileTypes: string[];
}

function disabled(status: ProjectIndexConfigStatus): WatchConfig {
  return { status, enabled: false, includePaths: [], ignorePaths: [], ignoreFileTypes: [] };
}

/** Keep only the string entries of a value that should be a string array. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Read and parse a folder's gate file. Fail-safe: a missing, unreadable,
 * malformed or wrong-shaped config resolves to disabled, never "index
 * everything". Invalid `ignorePaths` / `ignoreFileTypes` entries are dropped
 * rather than rejecting the whole file. `status` says why a config reads as
 * disabled (see WatchConfig.status); a root without an `embeddings` object is
 * still `present`, just not opted in.
 */
export async function readWatchConfig(folderPath: string): Promise<WatchConfig> {
  let raw: string;
  try {
    raw = await readFile(watchConfigPath(folderPath), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // ENOENT alone can't tell "user removed snaglet.config.json" from "the whole
      // folder is gone/unmounted". Only report the destructive `missing` when
      // the folder itself is demonstrably still there.
      try {
        const folder = await stat(folderPath);
        return disabled(folder.isDirectory() ? 'missing' : 'unreadable');
      } catch {
        return disabled('unreadable');
      }
    }
    return disabled('unreadable');
  }
  const parsed = safeJsonParse<unknown>(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return disabled('invalid');
  }
  const embeddings = (parsed as { embeddings?: unknown }).embeddings;
  if (typeof embeddings !== 'object' || embeddings === null) return disabled('present');
  const e = embeddings as {
    enabled?: unknown;
    includePaths?: unknown;
    ignorePaths?: unknown;
    ignoreFileTypes?: unknown;
  };
  return {
    status: 'present',
    enabled: e.enabled === true,
    includePaths: toStringArray(e.includePaths),
    ignorePaths: toStringArray(e.ignorePaths),
    ignoreFileTypes: toStringArray(e.ignoreFileTypes),
  };
}

/**
 * True only if `folderPath/snaglet.config.json` exists, is valid JSON, and has
 * `embeddings.enabled === true`. Thin wrapper over {@link readWatchConfig}.
 */
export async function isWatchEnabled(folderPath: string): Promise<boolean> {
  return (await readWatchConfig(folderPath)).enabled;
}
