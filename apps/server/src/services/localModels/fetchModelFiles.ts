/**
 * fetchModelFiles — download a local-model manifest's files into the paths the
 * runtime reads (`~/.snaglet/models/...`). Shared by the reranker and embedder
 * fetchers.
 *
 * Pulls each file in the manifest from its pinned Hugging Face source,
 * verifies the sha256 before writing it into place (a mismatch throws and
 * nothing is committed to disk), and writes atomically via a temp-file rename.
 * Idempotent: a file already present with the right checksum is left untouched
 * unless `force` is set.
 *
 * The download/verify/place logic lives here (not in the CLI wrappers) so it
 * can be unit-tested with an injected `fetchImpl` + a throwaway manifest,
 * without touching the network or the real `~/.snaglet` directory.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { modelReadDir } from './modelReadPaths';
import {
  expandHome,
  hfDownloadUrl,
  modelFileAbsPath,
  type LocalModelFile,
  type LocalModelManifest,
} from './localModelManifest';

/** Minimal shape of the `fetch` response this module needs (easy to fake). */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchImpl = (url: string) => Promise<FetchResponse>;

/**
 * A single file settling to a known state during a fetch. `bytes` is the file's
 * pinned size (from the manifest), so a caller can accumulate received-vs-total
 * byte progress without re-reading the manifest. `done: 'downloaded'` was pulled
 * over the network this run; `'present'` was already on disk with a valid
 * checksum. Either way the bytes are now readable, so both count as progress.
 */
export interface ModelFileProgress {
  /** The manifest-relative path of the file, e.g. `encoder.onnx`. */
  localPath: string;
  /** The file's pinned size in bytes. */
  bytes: number;
  /** How the file reached its final on-disk state. */
  done: 'downloaded' | 'present';
}

export interface FetchModelFilesOptions {
  /** Re-download even if a valid copy already exists. */
  force?: boolean;
  /** Override the downloader (tests). Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Progress sink. Defaults to a no-op. */
  log?: (line: string) => void;
  /**
   * Structured per-file progress sink, fired once as each file settles. Unlike
   * `log` (human lines), this carries the file's byte size so callers can drive
   * a received/total progress bar. Defaults to a no-op.
   */
  onProgress?: (progress: ModelFileProgress) => void;
  /**
   * Asked after each file downloads and verifies, before it is put in place.
   * Answering false stops the fetch with {@link ModelFetchAbortedError} and
   * removes the files this run installed. Defaults to always installing.
   */
  shouldInstall?: () => Promise<boolean>;
}

/** The fetch stopped because `shouldInstall` answered false. */
export class ModelFetchAbortedError extends Error {
  override name = 'ModelFetchAbortedError';
}

export interface FetchModelFilesResult {
  /** localPaths of files downloaded this run. */
  downloaded: string[];
  /** localPaths skipped because a valid copy already existed. */
  present: string[];
  /** The expanded target directory. */
  dir: string;
}

async function sha256OfFile(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

async function hasValidCopy(dest: string, sha256: string): Promise<boolean> {
  try {
    await access(dest);
  } catch {
    return false;
  }
  return (await sha256OfFile(dest)) === sha256;
}

async function downloadVerified(
  file: LocalModelFile,
  dest: string,
  url: string,
  fetchImpl: FetchImpl,
  shouldInstall: () => Promise<boolean>
): Promise<void> {
  // Asked before the download (so a called-off fetch pulls nothing more) and
  // again before the file is placed.
  if (!(await shouldInstall())) {
    throw new ModelFetchAbortedError(`install of ${file.localPath} was called off`);
  }
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`download failed for ${file.repoPath}: HTTP ${res.status} ${res.statusText}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== file.sha256) {
    // Verify before writing — never leave a corrupt/unexpected file on disk.
    throw new Error(
      `checksum mismatch for ${file.repoPath}: expected ${file.sha256}, got ${actual}`
    );
  }
  if (!(await shouldInstall())) {
    throw new ModelFetchAbortedError(`install of ${file.localPath} was called off`);
  }

  await mkdir(path.dirname(dest), { recursive: true });
  // Per-process temp name so concurrent fetchers don't clobber each other, and a
  // crash between write and rename leaks an obvious, process-scoped artifact.
  const tmp = `${dest}.${process.pid}.download`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, dest); // atomic publish (same directory)
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Remove files a run installed, then the folders under `root` that leaves empty. */
async function removeInstalled(installed: readonly string[], root: string): Promise<void> {
  await Promise.all(installed.map((file) => rm(file, { force: true })));
  const dirs = new Set<string>();
  for (const file of installed) {
    for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) dirs.add(dir);
  }
  // Deepest first, so a parent is already emptied when it is checked. rmdir
  // refuses a folder that is no longer empty (another fetch wrote into it).
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw err;
    }
  }
}

export async function fetchModelFiles(
  manifest: LocalModelManifest,
  options: FetchModelFilesOptions = {}
): Promise<FetchModelFilesResult> {
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url) as Promise<FetchResponse>);
  const log = options.log ?? (() => {});
  const onProgress = options.onProgress ?? (() => {});
  const shouldInstall = options.shouldInstall ?? (() => Promise.resolve(true));

  const downloaded: string[] = [];
  const present: string[] = [];

  const localDir = expandHome(manifest.dir);
  const readDir = options.force ? localDir : modelReadDir(manifest);
  if (readDir !== localDir) {
    log(`✓ reusing checksum-verified model from ${readDir}`);
    // A verified shared-home copy is readable without downloading anything —
    // report every file as already present so byte progress still completes.
    for (const file of manifest.files) {
      onProgress({ localPath: file.localPath, bytes: file.bytes, done: 'present' });
    }
    return { downloaded, present: manifest.files.map((file) => file.localPath), dir: readDir };
  }

  const installed: string[] = [];
  for (const file of manifest.files) {
    const dest = modelFileAbsPath(file, manifest);
    if (!options.force && (await hasValidCopy(dest, file.sha256))) {
      log(`✓ ${file.localPath} (present)`);
      present.push(file.localPath);
      onProgress({ localPath: file.localPath, bytes: file.bytes, done: 'present' });
      continue;
    }
    log(`↓ ${file.localPath} (${(file.bytes / 1e6).toFixed(1)} MB)`);
    try {
      await downloadVerified(file, dest, hfDownloadUrl(file, manifest), fetchImpl, shouldInstall);
    } catch (err) {
      if (err instanceof ModelFetchAbortedError) await removeInstalled(installed, localDir);
      throw err;
    }
    installed.push(dest);
    log(`✓ ${file.localPath} (downloaded, sha256 verified)`);
    downloaded.push(file.localPath);
    onProgress({ localPath: file.localPath, bytes: file.bytes, done: 'downloaded' });
  }

  return { downloaded, present, dir: expandHome(manifest.dir) };
}
