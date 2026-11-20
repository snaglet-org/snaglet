/**
 * ingest — the single write path shared by the watcher and the reconciliation
 * scan. Turning a (project, relative path) into a files-table row goes through
 * here so both callers apply the same exclusions, size cap, hashing, and
 * skip-if-unchanged logic.
 *
 * The body never lands in Postgres — only its hash (change detection) and size.
 * An upsert bumps nodes.updated_at, which the EmbeddingWorker sweep then
 * re-embeds off disk via buildEmbeddingTarget('file').
 */

import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Files, type FileRow } from '@snaglet/db/tables/files';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import {
  readEmbeddableFileContent,
  resolveWithinFolder,
  type EmbeddableFileRead,
} from '@server/services/embedding/fileSource';
import { shouldExcludePath, type IgnoreRules } from './exclusions';
import { emitFileEmbeddingCoverageChanged } from '@server/realtime/surfaces/fileEmbeddings';
import {
  cachedRead,
  forgetHashedStat,
  readStatClock,
  rememberRead,
  type CachedRead,
} from './hashedStatCache';

export type IngestStatus = 'upserted' | 'unchanged' | 'excluded' | 'skipped';

interface IngestOptions {
  /** The file's row, already loaded by the caller (null: no row), so ingest skips its lookup. */
  existing?: FileRow | null;
  /**
   * Settle the file from a stat that matches the hashed-stat cache, without
   * reading. The reconcile sets it; a watcher event always re-reads.
   */
  trustUnchangedStat?: boolean;
}

/** A read worth remembering: a hash, or a skip that holds until the file changes. */
function cacheableOutcome(read: EmbeddableFileRead): CachedRead | null {
  if (read.status !== 'skipped') return { kind: 'hashed', contentHash: read.contentHash };
  return read.reason ? { kind: 'skipped' } : null;
}

async function statRegularFile(absPath: string): Promise<Stats | null> {
  try {
    const info = await stat(absPath);
    return info.isFile() ? info : null;
  } catch {
    return null; // missing or unreadable: the read below reports it as skipped
  }
}

/**
 * Read one file off disk and reconcile it into the files table. Idempotent:
 * unchanged content (same on-disk-bytes hash) is a no-op — no upsert, no node
 * touch, no re-embed; for PDFs the hash shortcut also skips text extraction.
 * New or changed content upserts by (project, relativePath) and bumps the
 * node's updated_at. Never throws; unreadable/oversized/binary/missing files —
 * and PDFs with no extractable text layer — resolve to 'skipped'.
 * `relativePath` must be project-relative.
 */
export async function ingestFile(
  project: ProjectRow,
  relativePath: string,
  rules?: IgnoreRules,
  options: IngestOptions = {}
): Promise<IngestStatus> {
  if (!project.folderPath) return 'skipped';
  if (shouldExcludePath(relativePath, rules)) return 'excluded';

  const abs = resolveWithinFolder(project.folderPath, relativePath);
  if (!abs) return 'skipped'; // path traversal — refused

  const existing =
    options.existing === undefined
      ? await Files.byProjectAndPath(project.id, relativePath)
      : options.existing;
  // Clock, then stat, then read: a write landing after the stat pairs the older
  // stat with the newer bytes, which the next scan re-reads. The other order
  // would pair a new stat with old bytes and hide the change.
  const statAt = readStatClock();
  const info = await statRegularFile(abs);
  if (options.trustUnchangedStat && info) {
    const cached = cachedRead(project.id, relativePath, info);
    if (cached?.kind === 'skipped') return 'skipped';
    if (cached?.kind === 'hashed' && cached.contentHash === existing?.contentHash) {
      return 'unchanged';
    }
  }

  // The read step shares fileBodyHash with the embedding path so
  // files.content_hash and the content-addressed file_embeddings key can never
  // disagree. Passing the existing row's hash lets it answer 'unchanged'
  // straight from the bytes (no utf-8 decode, no PDF extraction).
  const read = await readEmbeddableFileContent(abs, { knownHash: existing?.contentHash ?? null });
  const outcome = cacheableOutcome(read);
  if (info && outcome) {
    rememberRead(project.id, project.folderPath, relativePath, info, statAt, outcome);
  } else {
    forgetHashedStat(project.id, relativePath);
  }
  if (read.status === 'skipped') return 'skipped';
  if (read.status === 'unchanged') return 'unchanged';

  await Files.upsertByPath({
    projectId: project.id,
    relativePath,
    contentHash: read.contentHash,
    sizeBytes: read.sizeBytes,
    containerId: project.containerId,
  });
  emitFileEmbeddingCoverageChanged();
  return 'upserted';
}

/** Remove one file by path (offline/online delete). Drops the row (an
 * embedding reference); orphaned chunk sets are reaped by the GC pass. */
export async function removeFile(project: ProjectRow, relativePath: string): Promise<boolean> {
  forgetHashedStat(project.id, relativePath);
  const removed = await Files.deleteByPath(project.id, relativePath);
  if (removed) emitFileEmbeddingCoverageChanged();
  return removed;
}
