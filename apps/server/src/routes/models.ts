/**
 * Models API routes
 *
 * GET    /api/models                          — list all models, in picker order
 * GET    /api/models/:providerId              — list active models for a provider, in picker order
 * GET    /api/models/:providerId/available    — live catalog from the provider's /models API
 * POST   /api/models                          — create a custom model
 * POST   /api/models/bulk                     — bulk-import discovered models
 * PATCH  /api/models/:id                      — update editable model fields
 * DELETE /api/models/:id                      — deactivate a model
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { Models } from '@snaglet/db/tables/models';
import { Providers } from '@snaglet/db/tables/providers';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import type { ModelMetadata } from '@snaglet/shared/types';
import { discoverModels } from '@server/services/ProviderModelDiscoveryService';
import {
  isEntitlementReconcilable,
  reconcileCopilotEntitlements,
  reconcileEntitlements,
} from '@server/services/ProviderModelDiscoveryService/entitlements';
import { logger } from '@server/config/logger';
import { emitModelsChanged } from '@server/realtime/surfaces/models';
import { sortModels } from '@snaglet/shared/utils';

const router = Router();

// GET /api/models — list all models
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const models = await Models.listAll();
    sendOk(res, sortModels(models));
  })
);

// POST /api/models — create a custom model
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { providerId, modelId, displayName, metadata, contextWindowTokens, maxOutputTokens } =
      req.body as {
        providerId?: string;
        modelId?: string;
        displayName?: string;
        metadata?: ModelMetadata;
        contextWindowTokens?: number | null;
        maxOutputTokens?: number | null;
      };
    if (!providerId || !modelId) {
      throw new AppError(
        'providerId and modelId are required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    // Checked before the insert so bad input is a 400/404, not a failed
    // integer cast or provider foreign key surfacing as a 500.
    validateOptionalTokenCount(contextWindowTokens, 'contextWindowTokens');
    validateOptionalTokenCount(maxOutputTokens, 'maxOutputTokens');
    if (!(await Providers.findProvider(providerId))) {
      throw new AppError(
        `Provider '${providerId}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    const model = await Models.createModel(
      providerId,
      modelId,
      displayName,
      metadata,
      contextWindowTokens,
      maxOutputTokens
    );
    emitModelsChanged(providerId);
    sendCreated(res, model);
  })
);

// POST /api/models/bulk — import a batch of models under a single provider
router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const { providerId, models } = req.body as {
      providerId?: string;
      models?: Array<{
        modelId: string;
        displayName?: string;
        description?: string;
        family?: string | null;
        contextWindowTokens?: number | null;
        maxOutputTokens?: number | null;
        supportsTools?: boolean;
        supportsVision?: boolean;
        supportsReasoning?: boolean;
        metadata?: ModelMetadata;
      }>;
    };

    if (!providerId || !Array.isArray(models) || models.length === 0) {
      throw new AppError(
        'providerId and a non-empty models array are required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const rows = await Models.bulkUpsert(providerId, models);
    emitModelsChanged(providerId);
    sendCreated(res, rows);
  })
);

// PATCH /api/models/:id — update editable model fields
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { displayName, contextWindowTokens, maxOutputTokens } = req.body as {
      displayName?: string;
      contextWindowTokens?: number | null;
      maxOutputTokens?: number | null;
    };

    validateOptionalTokenCount(contextWindowTokens, 'contextWindowTokens');
    validateOptionalTokenCount(maxOutputTokens, 'maxOutputTokens');

    // A person's edit: a limit set here is stamped so discovery keeps it.
    const model = await Models.updateModel(
      req.params.id,
      {
        displayName,
        ...(Object.prototype.hasOwnProperty.call(req.body, 'contextWindowTokens')
          ? { contextWindowTokens }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(req.body, 'maxOutputTokens')
          ? { maxOutputTokens }
          : {}),
      },
      { byUser: true }
    );
    if (!model) {
      throw new AppError('Model not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    emitModelsChanged(model.providerId);
    sendOk(res, model);
  })
);

// DELETE /api/models/:id — deactivate a model
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // Built-in local runtimes (the ONNX embedder + MiniLM reranker) are
    // Snaglet-managed and required by the app — never user-deletable. They live
    // under `type = 'runtime'` providers and are re-seeded on boot anyway.
    if ((await Models.providerTypeOf(req.params.id)) === 'runtime') {
      throw new AppError(
        'Built-in local models are managed by Snaglet and cannot be removed.',
        ErrorCode.FORBIDDEN,
        HTTP_STATUS.FORBIDDEN
      );
    }
    // User-initiated removal: stamp deactivatedBy:'user' so reconciliation
    // passes never auto-resurrect a model the user deliberately removed.
    const providerId = await Models.deactivateByUser(req.params.id);
    if (!providerId) {
      throw new AppError('Model not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    emitModelsChanged(providerId);
    sendOk(res, { success: true });
  })
);

// GET /api/models/:providerId — list active models for a provider
router.get(
  '/:providerId',
  asyncHandler(async (req, res) => {
    const models = await Models.listActiveByProviderId(req.params.providerId);
    sendOk(res, sortModels(models));
  })
);

// GET /api/models/:providerId/available — live catalog of chat models from the
// provider's /models API. Snaglet embeds with its built-in local model, so embedding
// models are never listed.
router.get(
  '/:providerId/available',
  asyncHandler(async (req, res) => {
    const result = await discoverModels(req.params.providerId);

    // A Copilot discovery refresh is also the moment to re-evaluate entitlement
    // statuses (non-probing): reactivate auto-deactivated rows
    // and re-mark plan_blocked/available from the payload. Best-effort — a
    // reconcile failure must not fail the catalog fetch.
    if (req.params.providerId === 'copilot') {
      await reconcileCopilotEntitlements(result.models).catch((err) =>
        logger.warn('Copilot entitlement reconcile during discovery failed', {
          err: getErrorMessage(err),
        })
      );
    }

    sendOk(res, result);
  })
);

// POST /api/models/:providerId/reconcile — reconcile the picker with the
// account's real entitlements. codex/together entitlement-PROBE each candidate
// (1-token request) and deactivate what's blocked. Copilot is non-probing (a
// probe would burn premium quota): it reactivates auto-deactivated
// rows and re-marks plan_blocked/available from the /models payload, never
// deactivating. Pass ?force=1 to re-probe cached verdicts (probe providers).
router.post(
  '/:providerId/reconcile',
  asyncHandler(async (req, res) => {
    const providerId = req.params.providerId;
    if (!isEntitlementReconcilable(providerId)) {
      throw new AppError(
        `Entitlement reconciliation is not supported for provider "${providerId}"`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (providerId === 'copilot') {
      const summary = await reconcileCopilotEntitlements();
      sendOk(res, summary);
      return;
    }
    const force = req.query.force === '1' || req.query.force === 'true';
    const summary = await reconcileEntitlements(providerId, { force });
    sendOk(res, summary);
  })
);

function validateOptionalTokenCount(value: unknown, name: string): void {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AppError(
      `${name} must be a non-negative integer`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
}

export default router;
