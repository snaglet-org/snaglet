/**
 * fileSource — read a project file's text for embedding, safely.
 *
 * `file` nodes keep their body on the user's local disk (project.folder_path +
 * files.relative_path), not in Postgres. This module is the single place that
 * turns that pair into embeddable text, with the guards every consumer must
 * share: a path-traversal check and a size cap. The watcher and reconciliation
 * scan import the same caps so all consumers agree on what "too big to index"
 * means.
 *
 * Two read shapes:
 *   - readEmbeddableFileBody: raw utf-8 text or null, used where only literal
 *     on-disk text makes sense (grep fallback).
 *   - readEmbeddableFileContent: the indexing read step. Text files pass
 *     through unchanged; extractable files (PDF) are read as raw bytes, hashed
 *     as-is (the binary file is the content identity), and their text layer is
 *     extracted for embedding. Extraction failures are per-file non-fatal.
 */

import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isExtractableFileExtension } from '@snaglet/shared/constants';
import { logger } from '@server/config/logger';
import { extractPdfText } from '@server/services/pdfTextExtraction';
import { fileBodyHash } from './contentHash';

/**
 * Files larger than this are skipped. Embedding a large blob is wasteful and
 * usually signals generated/vendored content; the cap also bounds the memory a
 * single read can pull in. Shared by the embedding classifier, the watcher, and
 * the reconciliation scan.
 */
export const MAX_EMBED_FILE_BYTES = 256 * 1024;

/**
 * Raw-size cap for extractable (PDF) sources. Deliberately larger than
 * MAX_EMBED_FILE_BYTES: PDF bytes are mostly fonts/images/structure, so raw
 * size barely predicts text volume — a 5 MB PDF can carry a few KB of text.
 * This cap only bounds the memory one read pulls in and the CPU one parse can
 * burn; the EXTRACTED text is what competes with text files and is held to
 * MAX_EMBED_FILE_BYTES characters below.
 */
export const MAX_EXTRACT_PDF_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * Page cap for PDF extraction. The char cap (MAX_EMBED_FILE_BYTES) usually
 * binds first (~2K chars per typical page ≈ cap around page 130); this bounds
 * per-page parse CPU on pathological page counts (10K-page generated PDFs)
 * where pages carry little text and the char cap alone would never trigger.
 */
export const MAX_EXTRACT_PDF_PAGES = 200;

/**
 * Resolve `relativePath` against `folderPath`, returning the absolute path only
 * if it stays inside the folder. Returns null on traversal (a `..` segment that
 * escapes the root), so a poisoned relative_path can never read arbitrary disk.
 */
export function resolveWithinFolder(folderPath: string, relativePath: string): string | null {
  const root = path.resolve(folderPath);
  const abs = path.resolve(root, relativePath);
  const relative = path.relative(root, abs);
  if (
    relative !== '' &&
    (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  ) {
    return null;
  }
  return abs;
}

/** True when the path names an extractable document (PDF) rather than raw text. */
export function isExtractableSourceFile(absOrRelPath: string): boolean {
  return isExtractableFileExtension(path.extname(absOrRelPath));
}

/**
 * Read a file's text for embedding, or null when it should be skipped: missing,
 * not a regular file, over the size cap, unreadable, or binary (a NUL byte
 * survives utf-8 decode). Never throws — callers must treat null as "skip this
 * one", because the embedding classifier's buildEmbeddingTarget contract is that
 * a thrown error aborts the whole batch.
 */
export async function readEmbeddableFileBody(absPath: string): Promise<string | null> {
  const read = await readTextBody(absPath);
  return 'body' in read ? read.body : null;
}

/** Why a text file was skipped; `binary` and `too-large` hold until the file changes. */
type TextSkipReason = 'binary' | 'too-large' | 'unreadable';

async function readTextBody(absPath: string): Promise<{ body: string } | { skip: TextSkipReason }> {
  try {
    const info = await stat(absPath);
    if (!info.isFile()) return { skip: 'unreadable' };
    if (info.size > MAX_EMBED_FILE_BYTES) return { skip: 'too-large' };
    const body = await readFile(absPath, 'utf8');
    if (body.includes('\u0000')) return { skip: 'binary' }; // NUL after utf-8 decode
    return { body };
  } catch {
    return { skip: 'unreadable' }; // missing, permission, I/O: may pass next time
  }
}

/** Result of the indexing read step (see {@link readEmbeddableFileContent}). */
export type EmbeddableFileRead =
  | {
      status: 'ok';
      /** Text to embed: the utf-8 body, or the extracted text layer for PDFs. */
      content: string;
      /** Content identity: sha256 of the on-disk bytes (see fileBodyHash). */
      contentHash: string;
      /** Stored on the files row: utf-8 body bytes for text, raw size for PDFs. */
      sizeBytes: number;
    }
  /** The on-disk bytes hash matches the caller's `knownHash` — nothing to do
   * (and for PDFs, extraction was skipped entirely). */
  | { status: 'unchanged'; contentHash: string }
  /**
   * Missing / oversized / binary / no text layer / unreadable — skip this file.
   * `reason` is set only for a text file skipped for its bytes or size alone,
   * which holds until the file changes.
   */
  | { status: 'skipped'; reason?: 'binary' | 'too-large' };

/**
 * Bounded negative cache for extractable files whose last extraction produced
 * nothing embeddable (no text layer, or corrupt/encrypted). Keyed by absolute
 * path and validated by (size, mtime): the periodic reconcile re-walks every
 * project file, and without this a scanned-image PDF would be re-parsed on
 * every pass forever. A change to the file (new size/mtime) drops the entry and
 * re-attempts extraction.
 */
const unembeddableExtractableCache = new Map<string, { sizeBytes: number; mtimeMs: number }>();
const UNEMBEDDABLE_CACHE_MAX = 512;

function rememberUnembeddable(absPath: string, sizeBytes: number, mtimeMs: number): void {
  if (unembeddableExtractableCache.size >= UNEMBEDDABLE_CACHE_MAX) {
    const oldest = unembeddableExtractableCache.keys().next().value;
    if (oldest !== undefined) unembeddableExtractableCache.delete(oldest);
  }
  unembeddableExtractableCache.set(absPath, { sizeBytes, mtimeMs });
}

/** Test hook: reset the negative-extraction cache. */
export function clearUnembeddableExtractableCache(): void {
  unembeddableExtractableCache.clear();
}

/**
 * The indexing read step shared by ingest (files-table upsert) and the
 * embedding classifier, so the two can never disagree on a file's content,
 * identity hash, or skip decision. Never throws.
 *
 * `knownHash` (the files row's current content_hash, when the caller has one)
 * enables the change-detection shortcut: the on-disk bytes are hashed first and
 * an identical hash returns 'unchanged' without decoding or extracting —
 * which is what keeps the periodic reconcile cheap for indexed PDFs.
 */
export async function readEmbeddableFileContent(
  absPath: string,
  options: { knownHash?: string | null } = {}
): Promise<EmbeddableFileRead> {
  const knownHash = options.knownHash ?? null;
  try {
    if (!isExtractableSourceFile(absPath)) {
      const text = await readTextBody(absPath);
      if (!('body' in text)) {
        return text.skip === 'unreadable'
          ? { status: 'skipped' }
          : { status: 'skipped', reason: text.skip };
      }
      const body = text.body;
      const contentHash = fileBodyHash(body);
      if (knownHash && knownHash === contentHash) return { status: 'unchanged', contentHash };
      return {
        status: 'ok',
        content: body,
        contentHash,
        sizeBytes: Buffer.byteLength(body, 'utf8'),
      };
    }

    const info = await stat(absPath);
    if (!info.isFile() || info.size > MAX_EXTRACT_PDF_SOURCE_BYTES) return { status: 'skipped' };

    const cached = unembeddableExtractableCache.get(absPath);
    if (cached) {
      if (cached.sizeBytes === info.size && cached.mtimeMs === info.mtimeMs) {
        return { status: 'skipped' }; // known text-less/unreadable, unchanged since
      }
      unembeddableExtractableCache.delete(absPath); // file changed — re-attempt
    }

    const raw = await readFile(absPath);
    // The binary file IS the identity; extracted text is derived from it. Same
    // bytes anywhere → same hash → the content-addressed chunk set is shared.
    const contentHash = fileBodyHash(raw);
    if (knownHash && knownHash === contentHash) return { status: 'unchanged', contentHash };

    const extraction = await extractPdfText(raw, {
      maxPages: MAX_EXTRACT_PDF_PAGES,
      maxChars: MAX_EMBED_FILE_BYTES,
    });
    if (!extraction.ok) {
      rememberUnembeddable(absPath, info.size, info.mtimeMs);
      if (extraction.reason === 'no-text') {
        logger.info(
          `[fileSource] skipping ${absPath}: PDF has no extractable text layer (scanned/image-only; OCR is not attempted)`
        );
      } else {
        logger.warn(
          `[fileSource] skipping ${absPath}: PDF could not be parsed${extraction.error ? ` (${extraction.error})` : ''}`
        );
      }
      return { status: 'skipped' };
    }
    if (extraction.truncated) {
      logger.info(
        `[fileSource] ${absPath}: PDF text capped at ${extraction.extractedPages}/${extraction.totalPages} page(s) / ${MAX_EMBED_FILE_BYTES} chars for indexing`
      );
    }
    return { status: 'ok', content: extraction.text, contentHash, sizeBytes: info.size };
  } catch {
    return { status: 'skipped' };
  }
}
