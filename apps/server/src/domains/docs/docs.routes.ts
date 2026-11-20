/**
 * Docs API routes under /api/docs: create, import an uploaded file
 * (md/txt/json/pdf/…), read, update and delete, plus version snapshots (list,
 * create, read, restore with a safety copy, delete one, clear all) and the
 * transclusion loop check. Bodies and responses are camelCase, matching
 * DocRow. Content writes go through DocModel, which refuses transclusion loops.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import {
  AppError,
  asNonEmptyString,
  MAX_DOC_IMPORT_BYTES,
  splitDocRef,
} from '@snaglet/shared/utils';
import { convertFileToDoc } from './docImport';
import { HTTP_STATUS, ErrorCode } from '@snaglet/shared/types';
import { isDocPriority } from '@snaglet/shared/constants';
import type { DocPriority } from '@snaglet/shared/constants';
import {
  Docs,
  Containers,
  assertNoTransclusionLoop,
  assertTimestampInput,
  findTransclusionLoop,
  getDb,
} from '@snaglet/db';
import { syncContentRefLinks } from '@server/services/contentRefs';
import { getCurrentActor } from '@server/realtime/actorContext';
import { stampDocEdit } from '@server/services/embedding/docSettleReembed';
import {
  emitTreeNodeCreated,
  emitTreeNodeUpdated,
  emitTreeNodeDeleted,
  emitDocBodySaved,
  snapshotFromDoc,
} from '@server/realtime/surfaces/tree';
import { embedDocNow } from '@server/services/embedding/embedDoc';
import { hooks } from '@server/services/HookService';

// doc_snapshots requires explicit `id` and `content_bytes` — no DB
// default for either. Mirrors the id format used by the workspace-
// snapshot-doc tool so manual and tool-driven snapshots share a shape.
function nextSnapshotId(): string {
  return `snap-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

const router = Router();

/** Nullable string field: undefined = unchanged; null/'' = clear; else the string. */
function parseNullableString(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Parse an optional due date. `undefined` = unchanged; `null`/'' = clear; any
 * other value must be an ISO 8601 date or date-time. Checked before any write
 * so a bad value is a 400 rather than a failure after a positional move has
 * already landed.
 */
function parseDueAt(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  assertTimestampInput('dueAt', raw);
  return raw;
}

/**
 * Parse an optional work-item priority. `undefined` = unchanged; `null`/''
 * = clear; a string is validated against the shared list (mirrors the
 * category route validation so bad UI/tool input fails fast rather than
 * persisting a junk value the kanban chip renderer can't map).
 */
function parsePriority(raw: unknown): DocPriority | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (!isDocPriority(raw)) {
    throw new AppError(
      'priority must be one of urgent|high|medium|low',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return raw;
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { title, containerId, content, dueAt, assignedTo, priority } = req.body as Record<
      string,
      unknown
    >;
    const cleanTitle = asNonEmptyString(title);
    if (!cleanTitle) {
      throw new AppError('title is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    // Validate container existence before the DB write so a bad containerId
    // returns a clean 404 instead of an unhandled Postgres FK error reaching
    // the generic 500 branch (which would leak internals/stack in development).
    if (typeof containerId === 'string' && containerId.length > 0) {
      const container = await Containers.findById(containerId);
      if (!container) {
        throw new AppError('container not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
    }
    const doc = await Docs.create({
      title: cleanTitle,
      containerId: typeof containerId === 'string' && containerId.length > 0 ? containerId : null,
      content: typeof content === 'string' ? content : '',
      dueAt: parseDueAt(dueAt),
      assignedTo: parseNullableString(assignedTo),
      priority: parsePriority(priority),
      // created_by is not accepted from the request — DocModel.create stamps it
      // from the resolved ambient actor (a creation stamp is derived, not set).
    });
    syncContentRefLinks(doc.id, doc.content ?? null);
    emitTreeNodeCreated(snapshotFromDoc(doc));
    embedDocNow(doc.id, doc.title, doc.content);
    sendCreated(res, doc);
  })
);

router.post(
  '/import',
  asyncHandler(async (req, res) => {
    const body = req.body as {
      name?: unknown;
      dataUrl?: unknown;
      containerId?: unknown;
      sortOrder?: unknown;
    };
    const name = asNonEmptyString(body.name);
    if (!name) {
      throw new AppError('name is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
    // Mime in the data URL is ignored — the extension on `name` decides
    // the conversion (browsers report "" or octet-stream for .md/.yaml).
    const match = dataUrl.match(/^data:[^;,]*;base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) {
      throw new AppError(
        'dataUrl must be a base64-encoded data URL',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const data = Buffer.from(match[1]!, 'base64');
    if (!data.length) {
      throw new AppError('file is empty', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    if (data.length > MAX_DOC_IMPORT_BYTES) {
      throw new AppError(
        `File is too large. Max import size is ${MAX_DOC_IMPORT_BYTES} bytes.`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const { title, content } = await convertFileToDoc(name, data);

    const containerId = typeof body.containerId === 'string' ? body.containerId : null;
    const sortOrder =
      typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder) && body.sortOrder >= 0
        ? Math.trunc(body.sortOrder)
        : undefined;
    const doc = await Docs.create({ title, containerId, content, sortOrder });
    syncContentRefLinks(doc.id, doc.content ?? null);
    emitTreeNodeCreated(snapshotFromDoc(doc));
    embedDocNow(doc.id, doc.title, doc.content);
    sendCreated(res, doc);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await Docs.findById(req.params.id);
    if (!row) {
      throw new AppError('doc not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, row);
  })
);

/**
 * GET /api/docs/:id/transclusion-loop?target=doc-… — the loop transcluding
 * `target` into this doc would close (`{ loop: [{ id, title }, …] }`), or
 * `{ loop: null }`. The editor asks before it turns a link into a
 * transclusion; saves are refused by the same guard either way.
 */
router.get(
  '/:id/transclusion-loop',
  asyncHandler(async (req, res) => {
    const target = typeof req.query.target === 'string' ? splitDocRef(req.query.target).id : '';
    if (!target) {
      throw new AppError('target is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    const doc = await Docs.findById(req.params.id);
    if (!doc) {
      throw new AppError('doc not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const loop = await findTransclusionLoop(getDb(), doc.id, [target], { title: doc.title });
    sendOk(res, { loop });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { title, content, containerId, sortOrder, dueAt, assignedTo, priority } =
      req.body as Record<string, unknown>;
    const update: {
      title?: string;
      content?: string;
      containerId?: string | null;
      dueAt?: string | null;
      assignedTo?: string | null;
      priority?: string | null;
    } = {};

    if (title !== undefined) {
      const trimmed = asNonEmptyString(title);
      if (!trimmed) {
        throw new AppError(
          'title cannot be empty',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      update.title = trimmed;
    }
    if (content !== undefined && typeof content === 'string') {
      update.content = content;
    }
    if (containerId !== undefined) {
      update.containerId = typeof containerId === 'string' ? containerId : null;
    }
    // Field edits — never triggered by a move (the moveTo path below carries
    // only placement).
    const parsedDueAt = parseDueAt(dueAt);
    if (parsedDueAt !== undefined) update.dueAt = parsedDueAt;
    const parsedAssignedTo = parseNullableString(assignedTo);
    if (parsedAssignedTo !== undefined) update.assignedTo = parsedAssignedTo;
    const parsedPriority = parsePriority(priority);
    if (parsedPriority !== undefined) update.priority = parsedPriority;

    // Positional intent — `sortOrder` set OR `containerId` changed — routes
    // through `Docs.moveTo`, which atomically bumps siblings at the target
    // slot (and beyond) by +1. When sortOrder is omitted but the container
    // is changing, moveTo falls back to `MAX(sort_order) + 1` so a pure
    // "drop inside" gesture appends to the end of the new bucket instead
    // of carrying the doc's old position across.
    const parsedSortOrder =
      typeof sortOrder === 'number' && Number.isInteger(sortOrder) && sortOrder >= 0
        ? sortOrder
        : undefined;
    const isPositionalMove = parsedSortOrder !== undefined || update.containerId !== undefined;

    if (isPositionalMove) {
      const existing = await Docs.findById(req.params.id);
      if (!existing) {
        throw new AppError('doc not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const targetContainer =
        update.containerId !== undefined ? update.containerId : existing.containerId;
      // The move commits on its own, so a body that would loop is refused
      // before it rather than after.
      if (update.content !== undefined) {
        await assertNoTransclusionLoop(getDb(), {
          id: req.params.id,
          content: update.content,
          previous: existing.content ?? '',
        });
      }
      const movedBy = getCurrentActor()?.actorId ?? null;
      const moved = await Docs.moveTo(req.params.id, targetContainer, parsedSortOrder, movedBy);
      if (!moved) {
        throw new AppError('doc not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const followup: {
        title?: string;
        content?: string;
        dueAt?: string | null;
        assignedTo?: string | null;
        priority?: string | null;
      } = {};
      if (update.title !== undefined) followup.title = update.title;
      if (update.content !== undefined) followup.content = update.content;
      if (update.dueAt !== undefined) followup.dueAt = update.dueAt;
      if (update.assignedTo !== undefined) followup.assignedTo = update.assignedTo;
      if (update.priority !== undefined) followup.priority = update.priority;
      const finalRow =
        Object.keys(followup).length > 0 ? await Docs.update(req.params.id, followup) : moved;
      if (update.content !== undefined) {
        syncContentRefLinks(req.params.id, update.content);
      }
      const emitted = finalRow ?? moved;
      // Positional move: emit patch with the parent/sort change + any title
      // change. Body changes go through the dedicated `doc.saved` event so
      // `workspace.updated` payloads stay small for tree-only consumers.
      emitTreeNodeUpdated({
        id: emitted.id,
        kind: 'doc',
        title: update.title,
        parentId: emitted.containerId,
        sortKey: String(emitted.sortOrder),
        updatedAt: emitted.updatedAt,
      });
      if (existing.containerId !== emitted.containerId) {
        hooks.emit('doc:move', {
          id: emitted.id,
          fromContainerId: existing.containerId,
          toContainerId: emitted.containerId,
        });
      }
      if (update.title !== undefined && existing.title !== emitted.title) {
        hooks.emit('doc:rename', {
          id: emitted.id,
          oldTitle: existing.title,
          newTitle: emitted.title,
        });
      }
      if (update.content !== undefined) {
        hooks.emit('doc:edit', {
          id: emitted.id,
          editor: getCurrentActor()?.actorId ?? null,
          charsDelta: (emitted.content ?? '').length - (existing.content ?? '').length,
          backupSnapshotId: null,
        });
        emitDocBodySaved(
          emitted.id,
          emitted.content ?? '',
          emitted.updatedAt,
          emitted.lastEditedBy
        );
        // Stamp settle-state; the settle sweep re-embeds once the doc goes
        // quiet (per-keystroke autosave must not re-embed each save).
        void stampDocEdit(emitted.id, emitted.title, emitted.content);
      }
      // Human doc-body autosave is intentionally not embedded inline — the
      // 1-min staleness sweep (EmbeddingWorker) re-embeds edited docs.
      sendOk(res, emitted);
      return;
    }

    const existing =
      update.title !== undefined || update.content !== undefined
        ? await Docs.findById(req.params.id)
        : null;
    const row = await Docs.update(req.params.id, update);
    if (!row) {
      throw new AppError('doc not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (update.content !== undefined) {
      syncContentRefLinks(req.params.id, update.content);
    }
    if (update.title !== undefined && existing && existing.title !== row.title) {
      hooks.emit('doc:rename', {
        id: row.id,
        oldTitle: existing.title,
        newTitle: row.title,
      });
    }
    // Plain update path: the title is tree-visible, while content goes through
    // `doc.saved` and container/sort through the positional branch above.
    if (update.title !== undefined) {
      emitTreeNodeUpdated({
        id: row.id,
        kind: 'doc',
        title: row.title,
        updatedAt: row.updatedAt,
      });
    }
    if (update.content !== undefined) {
      hooks.emit('doc:edit', {
        id: row.id,
        editor: getCurrentActor()?.actorId ?? null,
        charsDelta: (row.content ?? '').length - (existing?.content ?? '').length,
        backupSnapshotId: null,
      });
      emitDocBodySaved(row.id, row.content ?? '', row.updatedAt, row.lastEditedBy);
      // Stamp settle-state; the settle sweep re-embeds once the doc goes
      // quiet (per-keystroke autosave must not re-embed each save).
      void stampDocEdit(row.id, row.title, row.content);
    }
    // Human doc-body autosave defers to the 1-min staleness sweep (not embedded inline).
    sendOk(res, row);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await Docs.delete(req.params.id);
    if (!ok) {
      throw new AppError('doc not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    emitTreeNodeDeleted(req.params.id, 'doc');
    sendOk(res, null);
  })
);

/**
 * GET /api/docs/:id/snapshots — list prior versions of a doc.
 * Returns metadata only (no content blobs) ordered newest-first, capped
 * at the 200 most recent rows. `count` is the TRUE total for the doc
 * (a separate COUNT(*), not the page length) so the Versions button can
 * show a real number even when the history is longer than one page.
 * Powers the docs editor "Versions" dropdown.
 */
router.get(
  '/:id/snapshots',
  asyncHandler(async (req, res) => {
    const doc = await Docs.findById(req.params.id);
    if (!doc) {
      throw new AppError('doc not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const pool = getDb();
    const result = await pool.query(
      `SELECT id, label, reason, created_by, created_at, octet_length(content) AS content_bytes
         FROM doc_snapshots
        WHERE doc_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [req.params.id]
    );
    // COUNT(*) is a bigint on the wire (string in node-postgres); the
    // ::int cast plus Number() keeps the response a plain JSON number.
    const countResult = await pool.query<{ total: number | string }>(
      `SELECT COUNT(*)::int AS total FROM doc_snapshots WHERE doc_id = $1`,
      [req.params.id]
    );
    sendOk(res, {
      doc_id: req.params.id,
      count: Number(countResult.rows[0]?.total ?? 0),
      snapshots: result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        label: row.label ?? null,
        reason: row.reason ?? null,
        created_by: row.created_by ?? null,
        created_at: row.created_at,
        content_bytes:
          typeof row.content_bytes === 'string'
            ? Number(row.content_bytes)
            : (row.content_bytes ?? 0),
      })),
    });
  })
);

/**
 * POST /api/docs/:id/snapshots: snapshot the doc's current content, with an
 * optional `label` shown in the Versions dropdown. Empty docs are rejected.
 * Reason is `'manual'`, so the dropdown can tell these from automatic
 * pre-restore and pre-edit snapshots.
 */
router.post(
  '/:id/snapshots',
  asyncHandler(async (req, res) => {
    const doc = await Docs.findById(req.params.id);
    if (!doc) {
      throw new AppError('doc not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const content = doc.content ?? '';
    if (content.length === 0) {
      throw new AppError(
        'Cannot snapshot an empty doc',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const rawLabel = (req.body as Record<string, unknown> | undefined)?.label;
    const label =
      typeof rawLabel === 'string' && rawLabel.trim().length > 0
        ? rawLabel.trim().slice(0, 200)
        : null;
    const snapshotId = nextSnapshotId();
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const result = await getDb().query<{
      id: string;
      label: string | null;
      reason: string | null;
      created_by: string | null;
      created_at: string;
    }>(
      `INSERT INTO doc_snapshots (id, doc_id, content, content_bytes, label, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, label, reason, created_by, created_at`,
      [snapshotId, doc.id, content, contentBytes, label, 'manual', null]
    );
    const row = result.rows[0];
    sendOk(res, {
      snapshot: {
        id: row.id,
        label: row.label ?? null,
        reason: row.reason ?? null,
        created_by: row.created_by ?? null,
        created_at: row.created_at,
        content_bytes: contentBytes,
      },
    });
  })
);

/**
 * GET /api/docs/:id/snapshots/:snapshotId — fetch a single snapshot's
 * full content. Powers the docs editor "version preview" mode: clicking
 * a row in the Versions dropdown calls this to render that point-in-time
 * content read-only in the editor surface.
 *
 * 404s if either the doc or the snapshot (scoped to that doc) is missing.
 */
router.get(
  '/:id/snapshots/:snapshotId',
  asyncHandler(async (req, res) => {
    const doc = await Docs.findById(req.params.id);
    if (!doc) {
      throw new AppError(
        `Doc not found: ${req.params.id}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    const pool = getDb();
    const { rows } = await pool.query(
      `SELECT id, doc_id, content, label, reason, created_by, created_at,
              octet_length(content) AS content_bytes
         FROM doc_snapshots
        WHERE id = $1 AND doc_id = $2`,
      [req.params.snapshotId, req.params.id]
    );
    const row = rows[0];
    if (!row) {
      throw new AppError(
        `Snapshot not found: ${req.params.snapshotId}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    sendOk(res, {
      snapshot: {
        id: row.id,
        doc_id: row.doc_id,
        content: row.content,
        label: row.label,
        reason: row.reason,
        created_by: row.created_by,
        created_at: row.created_at,
        content_bytes:
          typeof row.content_bytes === 'string'
            ? Number(row.content_bytes)
            : (row.content_bytes ?? 0),
      },
    });
  })
);

/**
 * POST /api/docs/:id/snapshots/:snapshotId/restore — restore a doc to
 * the content of a prior snapshot.
 *
 * Safety: before overwriting, takes an implicit snapshot of the current
 * doc body (reason: "pre-restore") so the restore itself is reversible.
 * Then updates the doc body to the snapshot's content and returns the
 * updated doc. The client then re-renders in normal (live) mode.
 */
router.post(
  '/:id/snapshots/:snapshotId/restore',
  asyncHandler(async (req, res) => {
    const doc = await Docs.findById(req.params.id);
    if (!doc) {
      throw new AppError(
        `Doc not found: ${req.params.id}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    const pool = getDb();
    const { rows: snapRows } = await pool.query(
      `SELECT id, content FROM doc_snapshots
        WHERE id = $1 AND doc_id = $2`,
      [req.params.snapshotId, req.params.id]
    );
    const snap = snapRows[0];
    if (!snap) {
      throw new AppError(
        `Snapshot not found: ${req.params.snapshotId}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    // A snapshot that would bring back a transclusion loop is refused before
    // anything, its safety snapshot included, is written.
    const currentContent = doc.content ?? '';
    await assertNoTransclusionLoop(pool, {
      id: doc.id,
      title: doc.title,
      content: snap.content ?? '',
      previous: currentContent,
    });
    // 1. Safety snapshot of current content (so restore is reversible).
    //    Skip if doc is empty — nothing to preserve. doc_snapshots
    //    requires explicit id + content_bytes (no DB defaults), so they
    //    must be passed here. Match the manual-snapshot endpoint's shape.
    let backupSnapshotId: string | null = null;
    if (currentContent.length > 0) {
      backupSnapshotId = nextSnapshotId();
      await pool.query(
        `INSERT INTO doc_snapshots (id, doc_id, content, content_bytes, label, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          backupSnapshotId,
          doc.id,
          currentContent,
          Buffer.byteLength(currentContent, 'utf8'),
          `pre-restore of ${req.params.snapshotId}`,
          'pre-restore',
          null,
        ]
      );
    }
    // 2. Overwrite the doc body with the snapshot's content, then announce it
    //    the way PATCH announces a body edit: content-ref links, the
    //    `doc.saved` event open editors listen for, the doc:edit hook and the
    //    settle-state stamp. Docs.update itself emits nothing.
    const updated = await Docs.update(doc.id, { content: snap.content });
    if (!updated) {
      throw new AppError(
        `Doc not found: ${req.params.id}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    syncContentRefLinks(updated.id, updated.content ?? null);
    hooks.emit('doc:edit', {
      id: updated.id,
      editor: getCurrentActor()?.actorId ?? null,
      charsDelta: (updated.content ?? '').length - currentContent.length,
      backupSnapshotId,
    });
    emitDocBodySaved(updated.id, updated.content ?? '', updated.updatedAt, updated.lastEditedBy);
    void stampDocEdit(updated.id, updated.title, updated.content);
    sendOk(res, { doc: updated });
  })
);

/**
 * DELETE /api/docs/:id/snapshots/:snapshotId: permanently delete one snapshot.
 * Scoped to the doc, so a stray snapshotId cannot remove another doc's version.
 * 404 when the doc or the snapshot (in that doc) is missing.
 */
router.delete(
  '/:id/snapshots/:snapshotId',
  asyncHandler(async (req, res) => {
    const doc = await Docs.findById(req.params.id);
    if (!doc) {
      throw new AppError(
        `Doc not found: ${req.params.id}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    const result = await getDb().query<{ id: string }>(
      `DELETE FROM doc_snapshots
        WHERE id = $1 AND doc_id = $2
        RETURNING id`,
      [req.params.snapshotId, req.params.id]
    );
    if (result.rows.length === 0) {
      throw new AppError(
        `Snapshot not found: ${req.params.snapshotId}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    sendOk(res, { deleted: true, id: req.params.snapshotId, doc_id: req.params.id });
  })
);

/**
 * DELETE /api/docs/:id/snapshots ("Clear all versions"): one statement scoped to
 * the doc; the live doc is untouched. 404 when the doc is missing; an empty
 * history succeeds with `deleted_count: 0`, so the call is idempotent.
 */
router.delete(
  '/:id/snapshots',
  asyncHandler(async (req, res) => {
    const doc = await Docs.findById(req.params.id);
    if (!doc) {
      throw new AppError(
        `Doc not found: ${req.params.id}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    const result = await getDb().query<{ id: string }>(
      `DELETE FROM doc_snapshots
        WHERE doc_id = $1
        RETURNING id`,
      [req.params.id]
    );
    sendOk(res, { deleted: true, doc_id: req.params.id, deleted_count: result.rows.length });
  })
);

export default router;
