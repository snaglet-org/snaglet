import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { Tools } from '@snaglet/db/tables/tools';
import { AppError, canonicalToolName } from '@snaglet/shared/utils';
import { isRetiredToolRow } from '@server/services/ToolService/lib/canonicalToolRows';
import { decorateToolRow } from './helpers';

const router = Router();

/**
 * The row to show for `id`. An alias id (e.g. `get_node` in an older chip or
 * link) opens the tool it names (`node`), not the row still stored under the
 * alias. A removal tombstone has no successor and keeps its own row.
 */
async function findShownTool(id: string) {
  if (isRetiredToolRow(id)) {
    const shown = canonicalToolName(id);
    const successor = shown.aliasedFrom ? await Tools.findById(shown.id) : null;
    if (successor) return successor;
  }
  return Tools.findById(id);
}

// PATCH /api/tools/:id/enabled — flip per-tool admin policy.
// This is the durable per-tool visibility flag. Integration availability is
// resolved separately from provider state and credentials.
router.patch(
  '/:id/enabled',
  asyncHandler(async (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      throw new AppError(
        'enabled (boolean) is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const updated = await Tools.setEnabled(req.params.id, enabled);
    if (!updated) {
      throw new AppError(
        `Tool '${req.params.id}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    sendOk(res, await decorateToolRow(updated));
  })
);

// GET /api/tools/:id — get one tool (an old id answers with its canonical tool)
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const tool = await findShownTool(req.params.id);
    if (!tool) {
      throw new AppError('Tool not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, await decorateToolRow(tool));
  })
);

// PUT /api/tools/:id — update a tool (external only)
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await Tools.findById(req.params.id);
    if (!existing) {
      throw new AppError('Tool not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (existing.type === 'builtin') {
      throw new AppError(
        'Cannot modify builtin tools',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const updated = await Tools.update(req.params.id, req.body);
    sendOk(res, updated);
  })
);

// DELETE /api/tools/:id — delete a custom tool
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await Tools.findById(req.params.id);
    if (!existing) {
      throw new AppError('Tool not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (existing.type === 'builtin') {
      throw new AppError(
        'Cannot delete builtin tools',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    await Tools.delete(req.params.id);
    sendOk(res, null);
  })
);

export default router;
