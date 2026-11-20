/**
 * Links CRUD routes — unified context graph
 *
 * GET    /api/links              — list/filter links
 * GET    /api/links/node       — get all links touching a node id
 * POST   /api/links              — create or upsert a link
 * PATCH  /api/links/:id          — update a link
 * DELETE /api/links/edge         — delete a link by source+target+relation
 * DELETE /api/links/:id          — delete a link by ID
 * GET    /api/links/backlinks    — list links pointing to a target id
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { LINK_RELATIONS, Links } from '@snaglet/db/tables/links';
import type { LinkRelation, LinkSort } from '@snaglet/db/tables/links';
import { AppError, clampInt, isRecord } from '@snaglet/shared/utils';
import { HTTP_STATUS, ErrorCode } from '@snaglet/shared/types';

const router = Router();

/**
 * `limit` / `offset` query values, clamped to the bounds the model applies.
 * Absent or empty leaves the model default; a malformed value falls back to
 * it too instead of reaching SQL as NaN.
 */
const MAX_LINKS_PAGE = 5000;
const pageLimit = (raw: unknown): number | undefined =>
  raw === undefined || raw === '' ? undefined : clampInt(raw, 200, 1, MAX_LINKS_PAGE);
const pageOffset = (raw: unknown): number | undefined =>
  raw === undefined || raw === '' ? undefined : clampInt(raw, 0, 0, Number.MAX_SAFE_INTEGER);

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/** A write's `relation`: absent, or one of the link vocabulary. */
function parseRelation(raw: unknown): LinkRelation | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && (LINK_RELATIONS as readonly string[]).includes(raw)) {
    return raw as LinkRelation;
  }
  throw badRequest(`relation must be one of ${LINK_RELATIONS.join('|')}`);
}

/** A write's `metadata`: absent, or a JSON object. */
function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (isRecord(raw)) return raw;
  throw badRequest('metadata must be an object');
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const {
      source_id,
      target_id,
      relation,
      source_type,
      target_type,
      sort,
      limit,
      offset,
      include_types,
    } = req.query as Record<string, string>;

    const baseFilter = {
      sourceId: source_id,
      targetId: target_id,
      relation: relation as LinkRelation,
      limit: pageLimit(limit),
      offset: pageOffset(offset),
    };

    // `include_types=1` joins on `public.nodes` to add sourceType +
    // targetType to each row AND returns the total matching count so the
    // links inspector debug page can paginate. The richer envelope is
    // gated on the flag so existing callers of the lean route stay
    // unaffected.
    if (include_types === '1' || include_types === 'true') {
      const result = await Links.filterWithTypes({
        ...baseFilter,
        sourceType: source_type || undefined,
        targetType: target_type || undefined,
        sort: (sort as LinkSort) || undefined,
      });
      sendOk(res, result);
      return;
    }

    const rows = await Links.filter(baseFilter);
    sendOk(res, rows);
  })
);

router.get(
  '/node',
  asyncHandler(async (req, res) => {
    const { id, relation, limit } = req.query as Record<string, string>;

    if (!id) throw badRequest('id is required');

    const rows = await Links.forId(id, {
      relation: relation as LinkRelation,
      limit: pageLimit(limit),
    });

    sendOk(res, rows);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { source_id, target_id, relation, metadata } = (req.body ?? {}) as Record<
      string,
      unknown
    >;

    if (
      typeof source_id !== 'string' ||
      !source_id ||
      typeof target_id !== 'string' ||
      !target_id
    ) {
      throw badRequest('source_id and target_id are required');
    }

    // An unknown node is a 404 and a disallowed (source, relation, target)
    // triple a 400, both raised by the model.
    const row = await Links.upsert({
      sourceId: source_id,
      targetId: target_id,
      relation: parseRelation(relation),
      metadata: parseMetadata(metadata),
    });

    sendCreated(res, row);
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { relation, metadata } = (req.body ?? {}) as Record<string, unknown>;
    const row = await Links.update(req.params.id, {
      relation: parseRelation(relation),
      metadata: parseMetadata(metadata),
    });
    if (!row) {
      throw new AppError('Link not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, row);
  })
);

// Registered before `/:id`, which would otherwise capture "edge" as an id.
router.delete(
  '/edge',
  asyncHandler(async (req, res) => {
    const { source_id, target_id, relation } = (req.body ?? {}) as Record<string, unknown>;

    if (
      typeof source_id !== 'string' ||
      !source_id ||
      typeof target_id !== 'string' ||
      !target_id ||
      typeof relation !== 'string' ||
      !relation
    ) {
      throw badRequest('source_id, target_id, and relation are required');
    }

    const deleted = await Links.removeLink(source_id, target_id, relation as LinkRelation);

    sendOk(res, { deleted });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const deleted = await Links.delete(req.params.id);
    if (!deleted) {
      throw new AppError('Link not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, null);
  })
);

router.get(
  '/backlinks',
  asyncHandler(async (req, res) => {
    const { target_id, relation, limit } = req.query as Record<string, string>;

    if (!target_id) throw badRequest('target_id is required');

    const rows = await Links.filter({
      targetId: target_id,
      relation: relation as LinkRelation,
      limit: pageLimit(limit),
    });

    sendOk(res, rows);
  })
);

export default router;
