import express, { Router, type RequestHandler } from 'express';
import { Images } from '@snaglet/db/tables/images';
import { Threads } from '@snaglet/db/tables/threads';
import { getCurrentActor } from '@server/realtime/actorContext';
import { renameRefusal } from '@server/utils/fsRefusal';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import {
  AppError,
  IMAGE_NAME_MAX_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIZE_LABEL,
  generateId,
  imageNameProblem,
  imageSizeProblem,
} from '@snaglet/shared/utils';
import { isBodyTooLarge } from '@server/middleware/jsonBody';
import {
  emitTreeNodeCreated,
  emitTreeNodeUpdated,
  snapshotFromImage,
} from '@server/realtime/surfaces/tree';

const router = Router();
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

function toImageDto(row: {
  id: string;
  containerId: string | null;
  name: string;
  description: string | null;
  tags: string[];
  mimeType: string;
  sizeBytes: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    containerId: row.containerId,
    name: row.name,
    description: row.description,
    tags: row.tags,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: `/api/images/${row.id}/content`,
  };
}

/**
 * Upload bodies carry the image as a Base64 data URL, 4/3 of the file's size,
 * so the route parses its own body with room for a MAX_IMAGE_BYTES file and
 * the other fields. The API-wide JSON parser skips this route (see
 * middleware/jsonBody.ts) so this one runs after auth.
 */
const UPLOAD_BODY_LIMIT_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024;
const parseUploadJson = express.json({ limit: UPLOAD_BODY_LIMIT_BYTES });

/** The upload body parser, with its over-limit error turned into a message people can read. */
const uploadBody: RequestHandler = (req, res, next) => {
  parseUploadJson(req, res, (err?: unknown) => {
    if (isBodyTooLarge(err)) {
      next(
        new AppError(
          `This image is too large. Images can be up to ${MAX_IMAGE_SIZE_LABEL}.`,
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.PAYLOAD_TOO_LARGE
        )
      );
      return;
    }
    next(err);
  });
};

/** The `data:<type>;base64` header must close within this many characters. */
const DATA_URL_HEADER_MAX_CHARS = 128;
const DATA_URL_HEADER_RE = /^data:([^;,]+);base64$/;
// Checked one character at a time: an anchored `[…]+` run over a
// multi-megabyte payload can overflow V8's regexp backtrack stack.
const NON_BASE64_CHAR_RE = /[^A-Za-z0-9+/=\r\n]/;

function parseDataUrl(dataUrl: string): { mimeType: string; data: Buffer } {
  const comma = dataUrl.slice(0, DATA_URL_HEADER_MAX_CHARS).indexOf(',');
  const header = comma > 0 ? DATA_URL_HEADER_RE.exec(dataUrl.slice(0, comma)) : null;
  const payload = comma > 0 ? dataUrl.slice(comma + 1) : '';
  if (!header || !payload || NON_BASE64_CHAR_RE.test(payload)) {
    throw new AppError(
      'Invalid image payload. Expected data URL with base64 encoding.',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }

  const declaredType = header[1].toLowerCase();
  // `image/jpg` is not a registered type; providers only take `image/jpeg`.
  const mimeType = declaredType === 'image/jpg' ? 'image/jpeg' : declaredType;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new AppError(
      'Unsupported image type. Allowed: png, jpeg, webp, gif, svg.',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }

  const data = Buffer.from(payload, 'base64');
  if (!data.length) {
    throw new AppError(
      'Uploaded image is empty.',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  const sizeProblem = imageSizeProblem(data.length);
  if (sizeProblem) {
    throw new AppError(sizeProblem, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.PAYLOAD_TOO_LARGE);
  }

  return { mimeType, data };
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const images = await Images.listImages();
    sendOk(res, images.map(toImageDto));
  })
);

router.get(
  '/:id/content',
  asyncHandler(async (req, res) => {
    const image = await Images.findImageById(req.params.id);
    if (!image) {
      throw new AppError('Image not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    const payload = Buffer.isBuffer(image.data) ? image.data : Buffer.from(image.data);
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Content-Length', String(payload.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(payload);
  })
);

router.post(
  '/',
  uploadBody,
  asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      name?: string;
      dataUrl?: string;
      threadId?: string;
      containerId?: string | null;
      description?: string | null;
      tags?: unknown;
      sortOrder?: unknown;
    };
    if (!body.dataUrl || typeof body.dataUrl !== 'string') {
      throw new AppError(
        'dataUrl is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Presence is the signal, not truthiness. An absent property means "not a
    // thread upload"; a present one is a promise the caller intends to keep,
    // so a blank string, null, or a number is a client bug and gets a 400
    // rather than silently degrading into a root-level workspace upload the
    // user never asked for.
    const threadIdGiven = Object.prototype.hasOwnProperty.call(body, 'threadId');
    let threadId = '';
    if (threadIdGiven) {
      if (typeof body.threadId !== 'string' || body.threadId.trim().length === 0) {
        throw new AppError(
          'threadId must be a non-empty string when provided.',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      threadId = body.threadId.trim();
    }

    // Matches the existing contract for explicit placement: a non-empty
    // trimmed string is a container, anything else is "no placement given".
    const explicitContainerGiven =
      typeof body.containerId === 'string' && body.containerId.trim().length > 0;

    // Mutually exclusive, and rejected rather than resolved by precedence.
    // Honoring one and dropping the other would let a caller believe it had
    // placed the image somewhere it did not, with no error to notice.
    if (threadId && explicitContainerGiven) {
      throw new AppError(
        'Pass threadId or containerId, not both — a thread upload is placed by its thread.',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const { mimeType, data } = parseDataUrl(body.dataUrl);
    const cleanName =
      (body.name || 'Untitled image').trim().slice(0, IMAGE_NAME_MAX_LENGTH) || 'Untitled image';
    const description =
      typeof body.description === 'string' && body.description.trim().length > 0
        ? body.description.trim()
        : null;
    // Tags: accept a string[] on the wire; coerce to a trimmed, deduped,
    // length-capped list so a malformed client payload can't write
    // arbitrary jsonb-ish garbage into the column.
    const tags = Array.isArray(body.tags)
      ? Array.from(
          new Set(
            body.tags
              .filter((t): t is string => typeof t === 'string')
              .map((t) => t.trim())
              .filter((t) => t.length > 0 && t.length <= 60)
          )
        )
      : [];
    // Positional drop support (tree drag-between-rows). Omitted/invalid →
    // append at the end of the bucket (createImage resolves MAX+1).
    const sortOrder =
      typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder) && body.sortOrder >= 0
        ? Math.trunc(body.sortOrder)
        : undefined;

    // Placement resolves last, just before create. Everything above is pure
    // parsing, so the gap between reading the thread's project and writing the
    // image is as small as it gets without a transaction: the image goes to the
    // project this read saw, and a later project move never reparents it. It
    // also runs before any write, so a rejected upload leaves nothing behind.
    // A thread upload never trusts client placement: the client sends only the
    // threadId, and the image lands in the thread's project (or the root for a
    // flat thread). Other callers place it explicitly.
    let containerId: string | null = explicitContainerGiven
      ? (body.containerId as string).trim()
      : null;
    if (threadId) {
      const thread = await Threads.findById(threadId);
      // A missing id and an id belonging to another node kind both land here
      // (the lookup is scoped to threads), so the response cannot be used to
      // probe whether some other node exists.
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      if (thread.archived) {
        // An archived thread is read-only: the message that would carry this
        // image could never be sent, so accepting the upload would create an
        // orphan node and charge the user for a failure they get later.
        throw new AppError(
          'This thread is archived and cannot accept new attachments.',
          ErrorCode.CONFLICT,
          HTTP_STATUS.CONFLICT
        );
      }
      containerId = thread.projectId;
    }

    const image = await Images.createImage({
      id: generateId('image'),
      containerId,
      name: cleanName,
      description,
      tags,
      mimeType,
      data,
      sizeBytes: data.length,
      sortOrder,
    });

    emitTreeNodeCreated(snapshotFromImage(image));
    sendCreated(res, toImageDto(image));
  })
);

/**
 * The trimmed new name from a PATCH body, or undefined when none was sent.
 * `expectedName` is the name the caller last saw; a stale one is a 409.
 */
function parseRename(body: {
  name?: unknown;
  expectedName?: unknown;
}): { name: string; expectedName?: string } | undefined {
  if (!('name' in body)) return undefined;
  if (typeof body.name !== 'string') {
    throw new AppError(
      'name must be a string',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  const problem = imageNameProblem(body.name);
  if (problem) throw new AppError(problem, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
  if (body.expectedName !== undefined && typeof body.expectedName !== 'string') {
    throw new AppError(
      'expectedName must be a string',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return {
    name: body.name.trim(),
    ...(body.expectedName !== undefined ? { expectedName: body.expectedName } : {}),
  };
}

// PATCH /api/images/:id — move/reorder, rename, and/or replace searchable
// metadata. Placement routes through Images.moveTo; a rename through
// Images.rename, which renames the stored file too; metadata through the
// model's canonical update+vector-invalidation transaction.
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      containerId?: unknown;
      sortOrder?: unknown;
      name?: unknown;
      expectedName?: unknown;
      description?: unknown;
      tags?: unknown;
    };
    const rename = parseRename(body);

    // `containerId` uses key-present semantics: omitted = leave container,
    // present = move there (empty string → null = workspace root).
    const containerId =
      body.containerId === undefined
        ? undefined
        : typeof body.containerId === 'string' && body.containerId.trim().length > 0
          ? body.containerId.trim()
          : null;
    const sortOrder =
      typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder) && body.sortOrder >= 0
        ? Math.trunc(body.sortOrder)
        : undefined;
    const metadataPatch: { description?: string | null; tags?: string[] } = {};
    if ('description' in body) {
      if (body.description !== null && typeof body.description !== 'string') {
        throw new AppError(
          'description must be a string or null',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      const description = typeof body.description === 'string' ? body.description.trim() : null;
      metadataPatch.description = description || null;
    }
    if ('tags' in body) {
      if (!Array.isArray(body.tags)) {
        throw new AppError(
          'tags must be an array of strings',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      if (body.tags.some((tag) => typeof tag !== 'string')) {
        throw new AppError(
          'tags must contain only strings',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      const trimmedTags = (body.tags as string[]).map((tag) => tag.trim());
      if (trimmedTags.some((tag) => tag.length > 60)) {
        throw new AppError(
          'tags must be 60 characters or fewer',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      metadataPatch.tags = Array.from(new Set(trimmedTags.filter((tag) => tag.length > 0)));
    }
    const hasMetadataPatch =
      metadataPatch.description !== undefined || metadataPatch.tags !== undefined;
    const hasPlacementPatch = containerId !== undefined || sortOrder !== undefined;

    if (hasPlacementPatch && (hasMetadataPatch || rename)) {
      throw new AppError(
        'Update image placement and its name or metadata in separate requests',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    if (!hasPlacementPatch && !hasMetadataPatch && !rename) {
      throw new AppError(
        'containerId, sortOrder, name, description, or tags is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const existing = await Images.findMetaById(req.params.id);
    if (!existing) {
      throw new AppError('Image not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    let updated = existing;
    let renamed = false;
    if (rename) {
      const outcome = await Images.rename(req.params.id, rename.name, {
        expectedName: rename.expectedName,
      }).catch((err: unknown) => {
        throw renameRefusal(err, existing.name || 'this image') ?? err;
      });
      if (outcome.status === 'missing') {
        throw new AppError('Image not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      if (outcome.status === 'conflict') {
        throw new AppError(
          `This image was renamed to "${outcome.currentName}"`,
          ErrorCode.CONFLICT,
          HTTP_STATUS.CONFLICT,
          true,
          { name: outcome.currentName }
        );
      }
      renamed = outcome.status === 'renamed';
      updated = outcome.image;
    }
    if (hasPlacementPatch) {
      // Omitted container = a pure reorder within the image's current bucket.
      const targetContainer = containerId === undefined ? existing.containerId : containerId;
      const moved = await Images.moveTo(
        req.params.id,
        targetContainer,
        sortOrder,
        getCurrentActor()?.actorId ?? null
      );
      if (!moved) {
        throw new AppError('Image not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      updated = moved;
    }
    if (hasMetadataPatch) {
      const metadataUpdated = await Images.updateMetadata(req.params.id, metadataPatch);
      if (!metadataUpdated) {
        throw new AppError('Image not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      updated = metadataUpdated;
    }

    emitTreeNodeUpdated({
      id: updated.id,
      kind: 'image',
      ...(renamed ? { title: updated.name } : {}),
      ...(hasPlacementPatch
        ? { parentId: updated.containerId, sortKey: String(updated.sortOrder) }
        : {}),
      ...(hasMetadataPatch ? { description: updated.description, tags: updated.tags } : {}),
      updatedAt: updated.updatedAt,
    });
    sendOk(res, toImageDto(updated));
  })
);

export default router;
