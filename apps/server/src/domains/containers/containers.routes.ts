/**
 * Containers API routes
 *
 * GET    /api/containers              — list containers (root by default, or ?parentId=X)
 * GET    /api/containers/roots        — list root-level containers (parent_id IS NULL)
 * POST   /api/containers              — create a container { name, parentId? }
 * GET    /api/containers/:id          — fetch one container
 * PATCH  /api/containers/:id          — update name, parentId, category
 *                                       (category cannot change into or out of
 *                                       'project')
 * DELETE /api/containers/:id          — delete container (cascades children and,
 *                                       for a project, its threads)
 *
 * Body and response shapes are camelCase, matching ContainerRow.
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { asNonEmptyString, AppError } from '@snaglet/shared/utils';
import { HTTP_STATUS, ErrorCode } from '@snaglet/shared/types';
import { CONTAINER_CATEGORIES, isContainerCategory } from '@snaglet/shared/constants';
import type { ContainerCategory } from '@snaglet/shared/constants';
import { Containers } from '@snaglet/db';
import { getCurrentActor } from '@server/realtime/actorContext';
import {
  emitTreeNodeCreated,
  emitTreeNodeUpdated,
  emitTreeNodeDeleted,
  snapshotFromContainer,
} from '@server/realtime/surfaces/tree';
import { buildContainerTree } from './ContainerTreeService';
import {
  announceProjectTablesDrop,
  dropTablesOfDeletedContainer,
  type ProjectTablesDrop,
} from '@server/domains/tables/tableLifecycle';
import { hooks } from '@server/services/HookService';
import {
  listThreadIdsInNodeSubtree,
  lockThreadIdsInNodeSubtree,
  withThreadExecutionPurge,
} from '@server/services/ThreadExecutionPurgeService';

/**
 * Parse the optional `category` field from a request body. `undefined` = not
 * supplied (leave unchanged); `null`/'' = explicit clear; a string is
 * validated against the shared value list — only 'project' exists (the DB
 * CHECK is the backstop).
 */
function parseCategory(raw: unknown): ContainerCategory | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (!isContainerCategory(raw)) {
    throw new AppError(
      `category must be one of ${CONTAINER_CATEGORIES.join('|')}`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return raw;
}

const router = Router();

/**
 * GET /api/containers/tree
 *
 * Returns the full workspace container tree, optionally scoped to a project
 * subtree via `?projectId=<id>`.
 */
router.get(
  '/tree',
  asyncHandler(async (req, res) => {
    const rawProjectId = req.query.projectId;
    const projectId =
      typeof rawProjectId === 'string' && rawProjectId.trim().length > 0
        ? rawProjectId.trim()
        : null;
    const tree = await buildContainerTree(projectId);
    if (tree === null) {
      // Unknown or detached project — return empty.
      sendOk(res, []);
      return;
    }
    sendOk(res, tree);
  })
);

/**
 * GET /api/containers/roots
 *
 * Returns root-level containers (parent_id IS NULL).
 */
router.get(
  '/roots',
  asyncHandler(async (_req, res) => {
    const rows = await Containers.listRoots();
    sendOk(res, rows);
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const parentId = req.query.parentId;
    if (parentId === undefined || parentId === 'null' || parentId === '') {
      const rows = await Containers.listRoots();
      sendOk(res, rows);
      return;
    }
    if (typeof parentId !== 'string') {
      throw new AppError(
        'parentId must be a string',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const rows = await Containers.listByParent(parentId);
    sendOk(res, rows);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, parentId, category } = req.body as Record<string, unknown>;
    const cleanName = asNonEmptyString(name);
    if (!cleanName) {
      throw new AppError('name is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    const parsedCategory = parseCategory(category);
    // Validate parent existence before the DB write so a bad parentId returns
    // a clean 404 instead of an unhandled Postgres FK error reaching the
    // generic 500 branch (which would leak internals/stack in development).
    if (typeof parentId === 'string' && parentId.length > 0) {
      const parent = await Containers.findById(parentId);
      if (!parent) {
        throw new AppError(
          'parent container not found',
          ErrorCode.NOT_FOUND,
          HTTP_STATUS.NOT_FOUND
        );
      }
    }
    const container = await Containers.create({
      name: cleanName,
      parentId: typeof parentId === 'string' && parentId.length > 0 ? parentId : null,
      category: parsedCategory ?? null,
    });
    emitTreeNodeCreated(snapshotFromContainer(container));
    sendCreated(res, container);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await Containers.findById(req.params.id);
    if (!row) {
      throw new AppError('container not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, row);
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { name, parentId, category, sortOrder } = req.body as Record<string, unknown>;

    const update: {
      name?: string;
      parentId?: string | null;
      category?: ContainerCategory | null;
    } = {};

    if (name !== undefined) {
      const trimmed = asNonEmptyString(name);
      if (!trimmed) {
        throw new AppError(
          'name cannot be empty',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      update.name = trimmed;
    }
    if (parentId !== undefined) {
      update.parentId = typeof parentId === 'string' ? parentId : null;
    }
    const parsedCategory = parseCategory(category);
    if (parsedCategory !== undefined) update.category = parsedCategory;

    // Positional intent — `sortOrder` set OR `parentId` changed — routes
    // through `Containers.moveTo`, which atomically bumps siblings at the
    // target slot (and beyond) by +1. When sortOrder is omitted but the
    // parent is changing, moveTo falls back to `MAX(sort_order) + 1` so a
    // pure "drop inside" gesture appends to the end of the new parent
    // instead of carrying the container's old position across.
    const parsedSortOrder =
      typeof sortOrder === 'number' && Number.isInteger(sortOrder) && sortOrder >= 0
        ? sortOrder
        : undefined;
    const isPositionalMove = parsedSortOrder !== undefined || update.parentId !== undefined;

    const existing =
      isPositionalMove || update.category !== undefined
        ? await Containers.findById(req.params.id)
        : null;
    if ((isPositionalMove || update.category !== undefined) && !existing) {
      throw new AppError('container not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    // A plain folder may be promoted to a project (NULL → 'project'): no
    // thread or table scopes to a folder, so nothing needs rehoming. A
    // project can never be demoted — its threads and tables point at it.
    // Refused before any write — a move in the same request must not commit
    // ahead of the refusal (the model and the database repeat the check for
    // other callers).
    if (
      existing &&
      update.category !== undefined &&
      existing.category === 'project' &&
      update.category !== 'project'
    ) {
      throw new AppError(
        `Container ${existing.id} category cannot change out of 'project': its threads and tables are scoped to it; move or delete them first`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    if (isPositionalMove && existing) {
      const targetParent = update.parentId !== undefined ? update.parentId : existing.parentId;

      // Projects nest freely: a container (a project included) may hold any
      // number of project children.
      const movedBy = getCurrentActor()?.actorId ?? null;
      const moved = await Containers.moveTo(req.params.id, targetParent, parsedSortOrder, movedBy);
      if (!moved) {
        throw new AppError('container not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const followup: {
        name?: string;
        category?: ContainerCategory | null;
      } = {};
      if (update.name !== undefined) followup.name = update.name;
      if (update.category !== undefined) followup.category = update.category;
      const finalRow =
        Object.keys(followup).length > 0 ? await Containers.update(req.params.id, followup) : moved;
      const emitted = finalRow ?? moved;
      if (existing.parentId !== emitted.parentId) {
        hooks.emit('container:move', {
          id: emitted.id,
          fromParentId: existing.parentId,
          toParentId: emitted.parentId,
        });
      }
      if (Object.keys(followup).length > 0) {
        hooks.emit('container:update', { id: emitted.id, changed: Object.keys(followup) });
      }
      emitTreeNodeUpdated({
        id: emitted.id,
        kind: 'container',
        title: update.name,
        parentId: emitted.parentId,
        sortKey: String(emitted.sortOrder),
        category: emitted.category,
        updatedAt: emitted.updatedAt,
      });
      sendOk(res, emitted);
      return;
    }

    const row = await Containers.update(req.params.id, update);
    if (!row) {
      throw new AppError('container not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    // A body with nothing to change writes nothing, so it announces nothing.
    const changed = Object.keys(update);
    if (changed.length > 0) hooks.emit('container:update', { id: row.id, changed });
    // Non-positional update: emit only if a tree-visible field changed. A
    // category edit is tree-visible (project badge), so it emits too.
    if (update.name !== undefined || update.category !== undefined) {
      emitTreeNodeUpdated({
        id: row.id,
        kind: 'container',
        title: update.name !== undefined ? row.name : undefined,
        category: row.category,
        updatedAt: row.updatedAt,
      });
    }
    sendOk(res, row);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const clear = req.query.clearReferences;
    if (clear !== undefined && clear !== 'true' && clear !== 'false')
      throw new AppError(
        'clearReferences must be true or false',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    const threadIds = await listThreadIdsInNodeSubtree(req.params.id);
    let tables: ProjectTablesDrop | null = null;
    await withThreadExecutionPurge(
      threadIds,
      async ({ tx }) => {
        // The custom tables of the projects it takes along go too (409 while
        // other tables link to them, unless clearReferences).
        tables = await dropTablesOfDeletedContainer(
          req.params.id,
          { clearReferences: clear === 'true' },
          tx
        );
        const ok = await Containers.delete(req.params.id, tx);
        if (!ok) {
          // Throw inside the transaction: a concurrent owner disappearance must
          // roll back any execution rows purged for the preflight cohort.
          throw new AppError('container not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
      },
      {
        lockAndListThreadIds: (tx) => lockThreadIdsInNodeSubtree(req.params.id, tx),
      }
    );
    if (tables) announceProjectTablesDrop(tables);
    emitTreeNodeDeleted(req.params.id, 'container');
    sendOk(res, null);
  })
);

export default router;
