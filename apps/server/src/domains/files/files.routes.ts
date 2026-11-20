/**
 * Files API routes - access to a project's indexed file nodes, plus in-place
 * rename of a file in a linked folder.
 *
 * POST /api/files/rename          - rename one file in its folder (images only
 *                                   for now); its index row moves with it.
 * GET /api/files?projectId=<id>   - flat list of the project's indexed files
 *                                   (id + relative_path + size + mtime), for the
 *                                   sidebar file tree. The UI builds the folder
 *                                   hierarchy from relative_path client-side.
 * GET /api/files/:id/content      - read one file's text off disk for the pane.
 * GET /api/files/:id/raw          - stream one file's raw bytes (by node id) for
 *                                   visual previewers (the in-app PDF viewer
 *                                   and audio player) that render binary
 *                                   content the text route reports as
 *                                   not-previewable.
 * GET /api/files/raw?path=<abs>   - the same raw-byte stream by absolute path,
 *                                   for path-based previews (file: chips /
 *                                   filesystem search hits), gated by the same
 *                                   project-folder containment as /preview.
 *
 * File bodies are not stored in Postgres (only metadata + a content hash), so
 * content is read live from `project.folder_path + relative_path`.
 *
 * Ownership: a folder tree is indexed by exactly one "owner" project (see
 * fileIndexing/ownership). A request scoped to a satellite project redirects to
 * the owner and is narrowed to the satellite's subtree, mirroring the search
 * read-path, so the tree shows files even for projects that don't index directly.
 */

import { Router, type Response } from 'express';
import path from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { AppError, asNonEmptyString, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { Files, Projects } from '@snaglet/db';
import type { FileRow } from '@snaglet/db/tables/files';
import { getFileSearchScope } from '@server/services/fileIndexing';
import { canonicalFolder, isAncestorOrSame } from '@server/services/fileIndexing/ownership';
import {
  resolveWithinFolder,
  MAX_EMBED_FILE_BYTES,
  MAX_EXTRACT_PDF_SOURCE_BYTES,
} from '@server/services/embedding/fileSource';
import { realFileWithin, relativeFileTarget } from './previewPaths';
import { activeProjectRoots as activeProjectFolders, renameProjectFile } from './renameProjectFile';
import { logger } from '@server/config/logger';

const router = Router();

/** Cap previewed file size at the same bound used for embedding so the pane
 * never pulls an unbounded blob into memory or the response. */
const MAX_PREVIEW_BYTES = MAX_EMBED_FILE_BYTES;
/** A NUL byte surviving utf-8 decode signals binary content (not previewable). */
const NUL_CHAR = String.fromCharCode(0);

/**
 * Cap for the raw-bytes routes. Deliberately larger than MAX_PREVIEW_BYTES: the
 * visual PDF viewer must handle real documents (a scanned PDF is mostly image
 * data and easily dwarfs the text-preview cap), so this reuses the same bound
 * the PDF text-extraction path already accepts as a source. It still bounds the
 * memory a single read pulls in; anything over it is rejected with 413.
 */
const MAX_RAW_FILE_BYTES = MAX_EXTRACT_PDF_SOURCE_BYTES;

/**
 * Content-Type by extension for the raw routes: the PDF viewer requests `.pdf`,
 * the audio player the four audio types (the webview needs the right type on
 * the blob it plays). Unknown types fall back to octet-stream so a mislabeled
 * body is never sniffed into an executable type by the browser.
 */
const RAW_CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

function rawContentType(nameOrPath: string): string {
  const ext = path.extname(nameOrPath).slice(1).toLowerCase();
  return RAW_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Read a file off disk and send its raw bytes with a correct Content-Type, or
 * throw the right structured error: 404 when the resolved path is null (traversal
 * rejected by resolveWithinFolder), missing, or not a regular file; 413 when it
 * exceeds {@link MAX_RAW_FILE_BYTES}. The size is checked before the read, so an
 * over-cap file never pulls its bytes into memory. Shared by the by-id and
 * by-path raw routes.
 */
async function sendRawFile(res: Response, abs: string | null, nameForType: string): Promise<void> {
  if (!abs) {
    throw new AppError('file not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new AppError('file not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  if (!info.isFile()) {
    throw new AppError('file not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  if (info.size > MAX_RAW_FILE_BYTES) {
    throw new AppError(
      'file is too large to preview',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.PAYLOAD_TOO_LARGE
    );
  }
  const data = await readFile(abs);
  res.setHeader('Content-Type', rawContentType(nameForType));
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  );
  // Local file bodies can change on disk, so never let a stale copy be cached.
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(data);
}

interface FileListItem {
  id: string;
  /** Path relative to the requesting project's folder root (for the tree). */
  relativePath: string;
  /** Absolute on-disk path — what a dragged file chip references so it parses
   * out as `/abs/path`, not a project-relative path or a node id. */
  absolutePath: string;
  sizeBytes: number;
  updatedAt: string;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = asNonEmptyString(req.query.projectId);
    if (!projectId) {
      throw new AppError(
        'projectId query param is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Redirect to the folder tree's owner; satellites are narrowed to their
    // subtree. Falls back to the project itself when ownership isn't known
    // (e.g. a worker-less instance with a cold ownership map).
    const scope = getFileSearchScope(projectId);
    const ownerId = scope?.projectId ?? projectId;
    const prefix = scope?.pathPrefix ?? '';

    const rows = await Files.listByProject(ownerId);
    const scoped = prefix
      ? rows.filter((r) => r.relativePath === prefix || r.relativePath.startsWith(`${prefix}/`))
      : rows;

    // Owner folder root resolves each file's absolute on-disk path. r.relativePath
    // here is owner-relative (before the satellite prefix strip below), so joining
    // it onto the owner's folder yields the true absolute path.
    const ownerFolder = (await Projects.findById(ownerId))?.folderPath ?? null;

    // For a satellite, return tree paths relative to its own folder (strip the
    // owner-subtree prefix) so the tree renders rooted at the project; the
    // absolute path is unaffected by that strip.
    const items: FileListItem[] = scoped.map((r) => ({
      id: r.id,
      relativePath: prefix ? r.relativePath.slice(prefix.length + 1) : r.relativePath,
      absolutePath: ownerFolder ? path.join(ownerFolder, r.relativePath) : r.relativePath,
      sizeBytes: r.sizeBytes,
      updatedAt: r.updatedAt,
    }));
    items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    sendOk(res, items);
  })
);

/**
 * GET /api/files/count?projectId=<id> — number of indexed file rows owned by
 * this project. Powers the demote-from-project confirmation modal ("this will
 * delete N indexed file entries and their embeddings"). Deliberately not
 * ownership-redirected: the demote deletes rows where files.project_id = the
 * container id, so the count must reflect exactly those (satellites own none).
 */
router.get(
  '/count',
  asyncHandler(async (req, res) => {
    const projectId = asNonEmptyString(req.query.projectId);
    if (!projectId) {
      throw new AppError(
        'projectId query param is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const count = await Files.countByProject(projectId);
    sendOk(res, { count });
  })
);

type PreviewReason = 'binary' | 'too_large' | 'missing';

interface PreviewResult {
  content: string | null;
  previewable: boolean;
  reason?: PreviewReason;
  /** Actual on-disk size when stat succeeded; undefined otherwise. */
  sizeBytes?: number;
}

/**
 * Read a file's text for preview, never throwing. Returns a structured result
 * distinguishing too-large / binary from a genuine read failure (which is
 * bucketed as `missing`). Shared by the by-id and by-path routes.
 */
async function readPreview(abs: string | null): Promise<PreviewResult> {
  if (!abs) return { content: null, previewable: false, reason: 'missing' };
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { content: null, previewable: false, reason: 'missing' };
    if (info.size > MAX_PREVIEW_BYTES) {
      return { content: null, previewable: false, reason: 'too_large', sizeBytes: info.size };
    }
    const text = await readFile(abs, 'utf8');
    if (text.includes(NUL_CHAR)) {
      return { content: null, previewable: false, reason: 'binary', sizeBytes: info.size };
    }
    return { content: text, previewable: true, sizeBytes: info.size };
  } catch (err) {
    logger.warn(`[files] preview read failed for ${abs}: ${getErrorMessage(err)}`);
    return { content: null, previewable: false, reason: 'missing' };
  }
}

/**
 * The linked folders of every live (non-archived) project: the only roots a
 * path-addressed read (/preview, /raw, /relative) or a rename may resolve
 * inside. One helper, so those routes cannot drift on which projects count.
 */
async function activeProjectRoots(): Promise<string[]> {
  return (await activeProjectFolders()).map((p) => p.folderPath);
}

/** The real path of `target` inside some live project's folder, or null. */
async function realFileInActiveProject(target: string): Promise<string | null> {
  const roots = await activeProjectRoots();
  const hits = await Promise.all(roots.map((root) => realFileWithin(root, target)));
  return hits.find((hit) => hit !== null) ?? null;
}

/**
 * The linked folder of a live (non-archived) project, or null. The id-addressed
 * reads (/:id/content, /:id/raw, /relative from a file id) resolve against this,
 * so an archived project's files read as missing there too, as on the path routes.
 */
async function activeProjectFolder(projectId: string): Promise<string | null> {
  const project = await Projects.findById(projectId);
  return project && !project.archived ? project.folderPath : null;
}

/**
 * The real path of an indexed file node's body, or null when its project is
 * unknown, archived or folderless, or its relative_path escapes the folder.
 * file.projectId is the owner (only owners hold file nodes), so its
 * folder_path + relative_path locate the body on disk.
 */
async function realFileNodePath(
  file: Pick<FileRow, 'projectId' | 'relativePath'>
): Promise<string | null> {
  const folderPath = await activeProjectFolder(file.projectId);
  const candidate = folderPath ? resolveWithinFolder(folderPath, file.relativePath) : null;
  return folderPath && candidate ? realFileWithin(folderPath, candidate) : null;
}

/**
 * GET /api/files/preview?path=<absolutePath> — read a file by its absolute path,
 * for the chip preview modal (file chips reference a path, not a node id). The
 * path must resolve inside a live (non-archived) project's folder, so a crafted
 * `file:` ref can never read arbitrary disk. `..` is collapsed by canonicalFolder
 * before the containment check, so it can't escape.
 */
router.get(
  '/preview',
  asyncHandler(async (req, res) => {
    const requested = asNonEmptyString(req.query.path);
    if (!requested) {
      throw new AppError(
        'path query param is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const target = canonicalFolder(requested);
    const fileName = path.basename(target);
    const base = { id: requested, relativePath: fileName };

    const resolved = await realFileInActiveProject(target);
    if (!resolved) {
      // Outside every live project folder — treat as not previewable rather
      // than reading it (security) or leaking which paths exist.
      sendOk(res, { ...base, sizeBytes: 0, content: null, previewable: false, reason: 'missing' });
      return;
    }

    const result = await readPreview(resolved);
    sendOk(res, {
      ...base,
      sizeBytes: result.sizeBytes ?? 0,
      content: result.content,
      previewable: result.previewable,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  })
);

/**
 * GET /api/files/raw?path=<absolutePath> — raw bytes of a file addressed by its
 * absolute path, for path-based previews (file: chips, filesystem search hits).
 * Containment mirrors /preview exactly: `..` is collapsed by canonicalFolder and
 * the path must resolve inside a live (non-archived) project's folder, so a
 * crafted ref can never read arbitrary disk. Anything outside every live project
 * folder is reported as not-found (never read, and without leaking which paths
 * exist).
 */
router.get(
  '/raw',
  asyncHandler(async (req, res) => {
    const requested = asNonEmptyString(req.query.path);
    if (!requested) {
      throw new AppError(
        'path query param is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const target = canonicalFolder(requested);
    const resolved = await realFileInActiveProject(target);
    if (!resolved) {
      throw new AppError('file not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    await sendRawFile(res, resolved, target);
  })
);

/**
 * POST /api/files/rename { path, name } — rename a file in a linked project
 * folder, in place (see renameProjectFile for the containment, no-overwrite
 * and index rules). Only image files for now (isRenamableProjectFile).
 */
router.post(
  '/rename',
  asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      path?: unknown;
      name?: unknown;
    };
    if (typeof body.path !== 'string' || !body.path.trim()) {
      throw new AppError('path is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    if (typeof body.name !== 'string') {
      throw new AppError('name is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    sendOk(res, await renameProjectFile(body.path, body.name));
  })
);

/** Relative Markdown resources stay inside a registered project root. Initial
 * path previews select the most specific root. Navigation may retain an enclosing
 * registered root: that root is already authorized by the path-preview API.
 * Both source and target must still pass realpath containment in the chosen root. */
router.get(
  '/relative',
  asyncHandler(async (req, res) => {
    const source = asNonEmptyString(req.query.source);
    const href = asNonEmptyString(req.query.href);
    const fail = () =>
      new AppError(
        'Linked file is missing or outside the project folder',
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    if (!source || !href) throw fail();
    let sourcePath: string;
    let root: string | null = null;
    if (path.isAbsolute(source)) {
      sourcePath = source;
      const roots = (await activeProjectRoots())
        .filter((p) => isAncestorOrSame(path.resolve(p), path.resolve(source)))
        .sort((a, b) => b.length - a.length);
      root = roots[0] ?? null;
    } else {
      const file = await Files.findById(source);
      if (!file) throw fail();
      root = await activeProjectFolder(file.projectId);
      sourcePath = root ? path.resolve(root, file.relativePath) : '';
    }
    const pinnedRoot = asNonEmptyString(req.query.root);
    if (pinnedRoot) {
      // Never trust a client-supplied filesystem ancestor. It must exactly match
      // an active registered project, including when a chain retains its parent
      // project while visiting files in a separately linked nested project.
      if (!path.isAbsolute(pinnedRoot)) throw fail();
      const registered = (await activeProjectRoots()).find(
        (p) => path.resolve(p) === path.resolve(pinnedRoot)
      );
      if (!registered) throw fail();
      root = registered;
    }
    if (!root || !(await realFileWithin(root, sourcePath))) throw fail();
    const target = relativeFileTarget(sourcePath, href);
    const resolved = target ? await realFileWithin(root, target) : null;
    if (!resolved) throw fail();
    if (req.query.raw === '1') {
      await sendRawFile(res, resolved, target!);
      return;
    }
    const result = await readPreview(resolved);
    sendOk(res, {
      id: target,
      relativePath: path.relative(root, target!),
      projectRoot: root,
      sizeBytes: result.sizeBytes ?? 0,
      ...result,
    });
  })
);

router.get(
  '/:id/content',
  asyncHandler(async (req, res) => {
    const file = await Files.findById(req.params.id);
    if (!file) {
      throw new AppError('file not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    // An archived project's file reads exactly like a missing body.
    const result = await readPreview(await realFileNodePath(file));
    sendOk(res, {
      id: file.id,
      relativePath: file.relativePath,
      sizeBytes: result.sizeBytes ?? file.sizeBytes,
      content: result.content,
      previewable: result.previewable,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  })
);

/**
 * GET /api/files/:id/raw — raw bytes of an indexed file node, for visual
 * previewers (the in-app PDF viewer). Path resolution + containment reuse the
 * exact same folder_path + relative_path + resolveWithinFolder guards as
 * /:id/content, so this can never serve a body outside the owning project's
 * folder even if a relative_path were poisoned with `..`, and an archived
 * project's file 404s like a missing one.
 */
router.get(
  '/:id/raw',
  asyncHandler(async (req, res) => {
    const file = await Files.findById(req.params.id);
    if (!file) {
      throw new AppError('file not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    await sendRawFile(res, await realFileNodePath(file), file.relativePath);
  })
);

export default router;
