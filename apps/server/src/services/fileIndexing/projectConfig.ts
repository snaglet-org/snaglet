/**
 * projectConfig — read/write the MANAGED portion of a folder's `snaglet.config.json`
 * from the UI, without ever clobbering the parts Snaglet doesn't own.
 *
 * This is the write-side counterpart to watchConfig.ts (which only reads the
 * gate). Editing the file from the app has three hard requirements:
 *
 *   1. Preserve unknown keys. The file is the USER's — a hand-added top-level
 *      key, or a custom field inside `embeddings`, must survive a round-trip
 *      through the settings UI untouched. We re-read the full parsed object,
 *      merge only the fields we manage, and write the whole thing back.
 *   2. Atomic writes. A save writes a sibling temp file then renames it over the
 *      target, so a crash mid-write can never leave a half-written (and thus
 *      unparseable → indexing-disabled) config. Same filesystem ⇒ rename is
 *      atomic.
 *   3. Never destroy content we can't parse. If the on-disk file exists but is
 *      malformed JSON, we refuse to write (throwing) rather than overwrite it —
 *      the user may be mid-edit or have recoverable content. The UI surfaces the
 *      parse error instead of silently resetting their file.
 *
 * The managed fields all live under `embeddings`: `enabled`, `includePaths`,
 * `ignorePaths`, `ignoreFileTypes`. Everything else is opaque and passed through.
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, getErrorMessage, isRecord, safeJsonParse } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import { WATCH_CONFIG_FILENAME, watchConfigPath } from './watchConfig';

/** The subset of `embeddings.*` fields the settings UI can edit. Any field left
 * `undefined` is not touched on write (existing on-disk value is preserved). */
export interface IndexConfigEdits {
  enabled?: boolean;
  includePaths?: string[];
  ignorePaths?: string[];
  ignoreFileTypes?: string[];
}

/** The managed config as the UI sees it, plus provenance flags so the UI can
 * tell "no file yet" from "file present" and warn on an unparseable file. */
export interface IndexConfigView {
  /** Whether `snaglet.config.json` currently exists on disk. */
  configExists: boolean;
  /** File exists but is not valid JSON — editing is blocked until fixed by hand. */
  parseError: boolean;
  enabled: boolean;
  includePaths: string[];
  ignorePaths: string[];
  ignoreFileTypes: string[];
}

/** Keep only the trimmed, non-empty string entries; drop blanks and dupes while
 * preserving the user's ordering. Used for `ignorePaths` / `ignoreFileTypes`. */
function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface RawConfig {
  root: Record<string, unknown>;
  existed: boolean;
  parseError: boolean;
}

/**
 * Read the full parsed `snaglet.config.json` object (every key, not just the gate).
 * A missing file → empty root, `existed: false`. A present-but-malformed file →
 * empty root, `existed: true`, `parseError: true` (the caller must not write
 * over it). Only a valid JSON object yields the real root for edit-and-preserve.
 */
async function readRawConfig(folderPath: string): Promise<RawConfig> {
  let raw: string;
  try {
    raw = await readFile(watchConfigPath(folderPath), 'utf8');
  } catch {
    return { root: {}, existed: false, parseError: false };
  }
  const parsed = safeJsonParse<unknown>(raw, undefined);
  if (isRecord(parsed)) return { root: parsed, existed: true, parseError: false };
  return { root: {}, existed: true, parseError: true };
}

/** Project a raw root object into the UI view of the managed fields. */
function viewFromRoot(raw: RawConfig): IndexConfigView {
  const embeddings = isRecord(raw.root.embeddings) ? raw.root.embeddings : {};
  return {
    configExists: raw.existed,
    parseError: raw.parseError,
    enabled: embeddings.enabled === true,
    includePaths: cleanStringList(embeddings.includePaths),
    ignorePaths: cleanStringList(embeddings.ignorePaths),
    ignoreFileTypes: cleanStringList(embeddings.ignoreFileTypes),
  };
}

/** Read a folder's managed indexing config for display. Fail-safe: a missing or
 * malformed file reads as disabled with empty rules (see {@link IndexConfigView}). */
export async function readIndexConfig(folderPath: string): Promise<IndexConfigView> {
  return viewFromRoot(await readRawConfig(folderPath));
}

/** Result of a write: the post-write view, plus whether this call created the file. */
export interface WriteIndexConfigResult extends IndexConfigView {
  created: boolean;
}

/**
 * Apply `edits` to a folder's `snaglet.config.json`, preserving all unmanaged keys,
 * and write it back atomically. Creates the file (with `embeddings.enabled`
 * defaulting to true) when absent. Throws {@link AppError} 409 when the existing
 * file is unparseable, so a hand-broken file is never silently clobbered.
 */
export async function writeIndexConfig(
  folderPath: string,
  edits: IndexConfigEdits
): Promise<WriteIndexConfigResult> {
  const current = await readRawConfig(folderPath);
  if (current.parseError) {
    throw new AppError(
      `${WATCH_CONFIG_FILENAME} is not valid JSON — fix it by hand before editing indexing settings here`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.CONFLICT
    );
  }

  const { root } = current;
  const embeddings: Record<string, unknown> = isRecord(root.embeddings)
    ? { ...root.embeddings }
    : {};

  if (edits.enabled !== undefined) embeddings.enabled = edits.enabled;
  // Opt-in on by default only when creating the file (absent on disk). Editing an
  // existing file whose `embeddings` lacks `enabled` must not flip indexing on —
  // that folder is gated off (readWatchConfig/GET treat missing `enabled` as
  // disabled), and a rules edit alone must not silently enable it.
  else if (!current.existed && embeddings.enabled === undefined) embeddings.enabled = true;
  if (edits.includePaths !== undefined) {
    embeddings.includePaths = cleanStringList(edits.includePaths);
  }
  if (edits.ignorePaths !== undefined) embeddings.ignorePaths = cleanStringList(edits.ignorePaths);
  if (edits.ignoreFileTypes !== undefined) {
    embeddings.ignoreFileTypes = cleanStringList(edits.ignoreFileTypes);
  }

  root.embeddings = embeddings;
  const serialized = `${JSON.stringify(root, null, 2)}\n`;
  await atomicWriteFile(watchConfigPath(folderPath), serialized);

  return {
    created: !current.existed,
    ...viewFromRoot({ root, existed: true, parseError: false }),
  };
}

/**
 * Write `contents` to `target` atomically: write a uniquely-named sibling temp
 * file, then rename it over the target (atomic on the same filesystem). The temp
 * name is a dotfile so the folder watcher's own dotfile exclusion ignores it,
 * and it's cleaned up on any failure.
 */
async function atomicWriteFile(target: string, contents: string): Promise<void> {
  // Dotfile temp name so the folder watcher's dotfile exclusion never indexes it
  // during the brief window before the rename.
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await writeFile(tmp, contents, 'utf8');
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch((cleanupErr) => {
      logger.warn(
        `[fileIndexing] could not remove failed temp write ${tmp}: ${getErrorMessage(cleanupErr)}`
      );
    });
    logger.warn(`[fileIndexing] atomic write failed for ${target}: ${getErrorMessage(err)}`);
    throw err;
  }
}
