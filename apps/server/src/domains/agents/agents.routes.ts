/**
 * Agents domain routes — CRUD and model configs.
 *
 * Exports:
 *   default      → agent CRUD     (mount at /api/agents)
 *   modelsRouter → agent-model CRUD (mount at /api/agent-models)
 */

import { Router } from 'express';
import { agentService } from '@server/services/AgentService';
import type { CursorSpec } from '@snaglet/shared/cursor';
import type { SnagletAgentUpdate } from '@server/services/AgentService';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { normalizeProviderId } from '@server/services/ProviderCredentialService/normalization';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants';
import { validateAgentCursorFields } from './agentCursorValidation';
import { z } from 'zod';
import { validateBody } from '@server/middleware/validation';
import { SkillAssignmentService } from '@server/services/skills/SkillAssignmentService';

/**
 * Resolve the provider for an agent from its credential. The credential row is
 * authoritative — it knows which provider it belongs to — so a caller that
 * supplies `credentialId` + `modelId` gets a working agent without repeating
 * the provider. An explicit `provider` is allowed but must agree with the
 * credential (compared after alias normalization); a mismatch or an unknown
 * credential is a 400. Without this derivation, model resolution sees an empty
 * provider and yields zero candidates ("No model configured").
 */
async function resolveProviderFromCredential(
  credentialId: string,
  explicitProvider: string
): Promise<string> {
  const credential = await providerCredentialService.getSafeById(credentialId);
  if (!credential) {
    throw new AppError(
      `Credential '${credentialId}' not found`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  const requested = explicitProvider.trim();
  if (requested && normalizeProviderId(requested) !== credential.providerId) {
    throw new AppError(
      `provider '${requested}' does not match credential '${credentialId}' ` +
        `(its provider is '${credential.providerId}')`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return credential.providerId;
}

// Agent CRUD

const router = Router();

// `?includeArchived=true` surfaces archived agents alongside live ones —
// used by the ArchivedDrawer and any admin / restore surface. Default
// (omitted or false) filters them out.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    const agents = await agentService.list({ includeArchived });
    sendOk(res, agents);
  })
);

// Snapshot of in-flight agent work (live runs + executing hooks). Seeds the
// status bar's active-agents indicator before `agent.work_*` workspace events
// stream in — same pattern as /api/threads/active-runs. Must be registered
// before `/:id`.
router.get(
  '/active-work',
  asyncHandler(async (_req, res) => {
    const { activeWorkRegistry } = await import('@server/services/ActiveWorkRegistry');
    sendOk(res, { items: activeWorkRegistry.snapshot() });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const agent = await agentService.get(req.params.id);
    if (!agent) {
      throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, agent);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body as {
      name?: string;
      role?: string;
      avatarUrl?: string;
      credentialId?: string | null;
      modelId?: string | null;
      provider?: string | null;
      identity?: string | null;
      systemPrompt?: string;
      voice?: string | null;
      cursorFlower?: string | null;
      cursorColor?: string | null;
      cursorSpec?: CursorSpec | null;
    };
    const {
      name,
      role,
      avatarUrl,
      credentialId,
      modelId,
      provider,
      identity,
      systemPrompt,
      voice,
      cursorFlower,
      cursorColor,
      cursorSpec,
    } = body;
    validateAgentCursorFields({ cursorFlower, cursorColor, cursorSpec });
    if (!name) {
      throw new AppError('name is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    // Provider resolution: a supplied credential wins (validated against any
    // explicit provider); otherwise the explicit provider is used as-is after
    // alias normalization; absent both, empty string (prior behavior).
    const requestedProvider = typeof provider === 'string' ? provider : '';
    const resolvedProvider = credentialId
      ? await resolveProviderFromCredential(credentialId, requestedProvider)
      : normalizeProviderId(requestedProvider);
    // Store identity and systemPrompt in config_json as inline values
    const agent = await agentService.create({
      name,
      role,
      avatarUrl,
      credentialId: credentialId ?? null,
      modelId: modelId ?? null,
      provider: resolvedProvider,
      identity: identity ?? null,
      rawSystemPrompt: systemPrompt ?? null,
      systemPrompt: '',
      voice: voice ?? null,
      cursorFlower: cursorFlower ?? null,
      cursorColor: cursorColor ?? null,
      cursorSpec: cursorSpec ?? null,
      toolAccessMode: null,
      toolAccessAllowList: null,
      toolAccessDenyList: null,
      toolAccessAdvertiseAllowedOnly: false,
      mcpServers: null,
      toolOverrides: null,
      trustedToolCalls: false,
      maxToolCallsPerTurn: null,
      maxDurationSeconds: null,
      fallbacks: null,
      disableModelFallback: false,
    });

    // agentService.create emits the realtime roster invalidation.
    sendCreated(res, agent);
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Same contract as POST: assigning a credential derives (or validates) the
    // provider from the credential row, so a credential+model PATCH can never
    // strand the agent with a provider that doesn't match its credential.
    // Clearing the credential (null) leaves the provider untouched.
    if (body.trustedToolCalls !== undefined && typeof body.trustedToolCalls !== 'boolean') {
      throw new AppError(
        'trustedToolCalls must be a boolean',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (body.dmEnabled !== undefined && typeof body.dmEnabled !== 'boolean') {
      throw new AppError(
        'dmEnabled must be a boolean',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    validateAgentCursorFields(body);
    let patch = body as SnagletAgentUpdate;
    const requestedCredentialId =
      typeof body.credentialId === 'string' && body.credentialId ? body.credentialId : null;
    if (requestedCredentialId) {
      const derivedProvider = await resolveProviderFromCredential(
        requestedCredentialId,
        typeof body.provider === 'string' ? body.provider : ''
      );
      patch = { ...patch, provider: derivedProvider };
    }

    // agentService.update emits `agent.updated` for the fields that actually
    // changed, so tool-driven edits reach other windows too.
    const updated = await agentService.update(req.params.id, patch);
    if (!updated) {
      throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, updated);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // Deleting an agent is the ghost purge: it destroys the agent's
    // memories / thread summaries, repoints every kept reference
    // (messages, runs, attribution) to the permanent `ghost` system agent, then
    // deletes the agent + member rows for real — history never goes authorless.
    // Idempotent: a missing (already-deleted) agent yields null → 404.
    //
    // Ghost is undeletable — route-layer guard (belt); the service and a DB
    // trigger guard too. agentService.purge throws for ghost regardless.
    if (req.params.id === GHOST_AGENT_ID) {
      throw new AppError(
        'The ghost system agent is permanent and cannot be deleted',
        ErrorCode.FORBIDDEN,
        HTTP_STATUS.FORBIDDEN
      );
    }
    const purged = await agentService.purge(req.params.id);
    if (!purged) {
      throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, null);
  })
);

// Skills: the agent's general skill defaults

const ReplaceSkillsSchema = z.object({ skillIds: z.array(z.string().min(1)).max(200) }).strict();

async function requireAgent(id: string): Promise<void> {
  if (!(await agentService.get(id))) {
    throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
}

router.get(
  '/:id/skills',
  asyncHandler(async (req, res) => {
    await requireAgent(req.params.id);
    sendOk(res, { skillIds: await SkillAssignmentService.listGeneral(req.params.id) });
  })
);

router.put(
  '/:id/skills',
  validateBody(ReplaceSkillsSchema),
  asyncHandler(async (req, res) => {
    await requireAgent(req.params.id);
    const { skillIds } = req.body as z.infer<typeof ReplaceSkillsSchema>;
    sendOk(res, { skillIds: await SkillAssignmentService.replaceGeneral(req.params.id, skillIds) });
  })
);

export default router;
