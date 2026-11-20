/**
 * fetchArchive — download a single sha256-pinned `.tar.bz2`, verify it, and
 * extract one member subtree into place. Used for piper's `espeak-ng-data`,
 * whose 355 model-agnostic files are impractical to pin per-file (see
 * `voiceModelManifest.ts`). Everything else in the voice model set is fetched
 * per-file via the shared `fetchModelFiles` helper.
 *
 * Mirrors `fetchModelFiles`'s contract: verify-before-place (a checksum
 * mismatch throws and nothing is committed), atomic publish via a temp-dir
 * rename, and idempotency via a sentinel file. Download + extract are injectable
 * so the logic is unit-testable without network or a real `tar`.
 */

import { archiveReadDir, archiveTreeMatches } from './archiveReadPaths';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FetchImpl, ModelFileProgress } from '../localModels/fetchModelFiles';
import type { EspeakArchiveSpec } from './voiceModelManifest';

/**
 * Extract a single member subtree from a `.tar.bz2` into `intoDir`, stripping
 * `stripComponents` leading path components. The extracted subtree keeps its
 * final path component (e.g. member `.../espeak-ng-data` with strip 1 lands at
 * `intoDir/espeak-ng-data`).
 */
export type ExtractImpl = (args: {
  archivePath: string;
  member: string;
  stripComponents: number;
  intoDir: string;
}) => Promise<void>;

export interface FetchArchiveOptions {
  /** Re-download + re-extract even if the sentinel already exists. */
  force?: boolean;
  /** Override the downloader (tests). Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Override the extractor (tests). Defaults to spawning `tar`. */
  extractImpl?: ExtractImpl;
  /** Progress sink. Defaults to a no-op. */
  log?: (line: string) => void;
  /**
   * Structured progress sink, fired once as the archive settles (counted as a
   * single `spec.bytes`-sized unit). Mirrors `fetchModelFiles`'s `onProgress`
   * so an install can aggregate archive + per-file byte progress uniformly.
   */
  onProgress?: (progress: ModelFileProgress) => void;
}

export interface FetchArchiveResult {
  /** True if the archive was downloaded + extracted this run. */
  extracted: boolean;
  /** The destination directory the member now lives in. */
  dir: string;
}

/** Default extractor: `tar xjf <archive> -C <intoDir> --strip-components=N <member>`. */
const tarExtract: ExtractImpl = ({ archivePath, member, stripComponents, intoDir }) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      'tar',
      ['xjf', archivePath, '-C', intoDir, `--strip-components=${stripComponents}`, member],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** The number of leading path components in the member before its final name. */
function stripDepthFor(member: string): number {
  // e.g. "vits-piper-en_US-amy-medium/espeak-ng-data" => strip the 1 parent
  // component so the tree lands as "espeak-ng-data/..." under intoDir.
  return member.split('/').length - 1;
}

export async function fetchArchive(
  spec: EspeakArchiveSpec,
  options: FetchArchiveOptions = {}
): Promise<FetchArchiveResult> {
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url) as ReturnType<FetchImpl>);
  const extractImpl = options.extractImpl ?? tarExtract;
  const log = options.log ?? (() => {});
  const onProgress = options.onProgress ?? (() => {});
  // One stable progress id for the archive (its member's final dir name), so a
  // caller can account for it alongside the per-file manifest entries.
  const progressPath = path.basename(spec.member);

  const readDir = options.force ? spec.destDir : archiveReadDir(spec);
  const sentinel = path.join(readDir, spec.sentinelRelPath);
  if (!options.force && (await exists(sentinel))) {
    log(`✓ ${readDir} (present)`);
    onProgress({ localPath: progressPath, bytes: spec.bytes, done: 'present' });
    return { extracted: false, dir: readDir };
  }

  log(`↓ ${spec.url.split('/').pop() ?? 'archive'} (${(spec.bytes / 1e6).toFixed(1)} MB)`);
  const res = await fetchImpl(spec.url);
  if (!res.ok) {
    throw new Error(`archive download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== spec.sha256) {
    throw new Error(`archive checksum mismatch: expected ${spec.sha256}, got ${actual}`);
  }

  // Stage the archive + extraction in a throwaway temp dir, then atomically
  // swap the finished tree into place so a crash mid-extract never leaves a
  // half-populated data dir where the runtime reads.
  const work = await mkdtemp(path.join(tmpdir(), 'snaglet-voice-espeak-'));
  const archivePath = path.join(work, 'archive.tar.bz2');
  const finalName = path.basename(spec.member); // e.g. "espeak-ng-data"
  try {
    await writeFile(archivePath, bytes);
    await extractImpl({
      archivePath,
      member: spec.member,
      stripComponents: stripDepthFor(spec.member),
      intoDir: work,
    });
    const extracted = path.join(work, finalName);
    if (!(await exists(path.join(extracted, spec.sentinelRelPath)))) {
      throw new Error(`extraction produced no ${spec.sentinelRelPath} under ${finalName}`);
    }
    if (spec.treeSha256 && !archiveTreeMatches(extracted, spec.treeSha256)) {
      throw new Error('Extracted archive tree checksum mismatch');
    }
    await mkdir(path.dirname(spec.destDir), { recursive: true });
    await rm(spec.destDir, { recursive: true, force: true });
    await rename(extracted, spec.destDir);
    log(`✓ ${path.basename(spec.destDir)} (extracted, sha256 verified)`);
    onProgress({ localPath: progressPath, bytes: spec.bytes, done: 'downloaded' });
    return { extracted: true, dir: spec.destDir };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
