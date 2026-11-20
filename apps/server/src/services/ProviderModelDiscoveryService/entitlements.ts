/**
 * Entitlement wiring — binds each provider's candidate source (its `/models`
 * catalog or curated list) and its live 1-token probe to the generic
 * reconciler. Currently the two credential-gated providers: Copilot (plan-
 * blocked models leak into the catalog) and Codex (a ChatGPT account runs only
 * a slice of the catalog). Kept separate from `reconcile.ts` so that module
 * stays pure + unit-testable with an injected probe.
 */

import { Models } from '@snaglet/db/tables/models';
import type { ModelRow } from '@snaglet/db/tables/models';
import type { ModelEntitlementMeta } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { probeCodexModel } from '@server/services/ProviderChatService/providers/codex';
import { probeTogetherModel } from '@server/services/ProviderChatService/providers/together';
import { discoverCopilotModels } from './normalizers/copilot';
import { discoverCodexModels } from './normalizers/codex';
import { reconcileProviderEntitlements, type ModelProbe, type ReconcileSummary } from './reconcile';
import type { DiscoveredModel } from './types';

// Copilot is deliberately absent here: its entitlement is never probed (a probe
// would burn premium quota without consent). It reconciles via the non-probing
// `reconcileCopilotEntitlements` below instead.
const PROBES: Record<string, ModelProbe> = {
  codex: (id) => probeCodexModel(id),
  together: (id) => probeTogetherModel(id),
};

const CANDIDATE_SOURCES: Record<string, () => Promise<DiscoveredModel[]>> = {
  codex: discoverCodexModels,
  together: togetherPickerCandidates,
};

/**
 * Together's `/v1/models` listing carries no per-model serverless flag, so we
 * can't prune dedicated-only models at discovery time. Instead reconciliation
 * probes only the models the user has actually imported (their live picker) —
 * not Together's full multi-hundred-model catalog — and deactivates the ones
 * that come back "non-serverless" with Together's own reason. New serverless
 * models are still imported the normal way (discovery + bulk import); this
 * binding is a pruning pass over what's already in the picker.
 */
async function togetherPickerCandidates(): Promise<DiscoveredModel[]> {
  const rows = await Models.listActiveByProviderId('together');
  return rows.map(rowToCandidate);
}

const COPILOT_PROVIDER_ID = 'copilot';

/** Providers whose picker is entitlement-gated and can be reconciled. */
export function isEntitlementReconcilable(providerId: string): boolean {
  return providerId === COPILOT_PROVIDER_ID || providerId in PROBES;
}

function rowToCandidate(row: ModelRow): DiscoveredModel {
  return {
    modelId: row.modelId,
    displayName: row.displayName,
    description: row.description || undefined,
    family: row.family,
    contextWindowTokens: row.contextWindowTokens,
    maxOutputTokens: row.maxOutputTokens,
    supportsTools: row.supportsTools,
    supportsVision: row.supportsVision,
    supportsReasoning: row.supportsReasoning,
    alreadyImported: true,
    existingModelId: row.id,
  };
}

/**
 * Probe every candidate for `providerId` and reconcile the picker: import/keep
 * models that pass, deactivate models that fail (recording the reason). The
 * candidate set is the live catalog plus any active rows missing from it, so a
 * stale plan-blocked model still gets pruned.
 */
export async function reconcileEntitlements(
  providerId: string,
  opts?: { force?: boolean; concurrency?: number }
): Promise<ReconcileSummary> {
  const probe = PROBES[providerId];
  const source = CANDIDATE_SOURCES[providerId];
  if (!probe || !source) {
    throw new Error(`Entitlement reconciliation is not supported for provider "${providerId}"`);
  }

  const discovered = await source();
  const discoveredIds = new Set(discovered.map((m) => m.modelId));

  const activeRows = await Models.listActiveByProviderId(providerId);
  const extras = activeRows.filter((r) => !discoveredIds.has(r.modelId)).map(rowToCandidate);

  const candidates = [...discovered, ...extras];

  return reconcileProviderEntitlements({
    providerId,
    candidates,
    probe,
    force: opts?.force,
    concurrency: opts?.concurrency,
  });
}

export interface CopilotReconcileSummary {
  providerId: 'copilot';
  /** Total copilot rows examined (including skipped ones). */
  total: number;
  /** How many were flipped back to active. */
  reactivated: number;
  /** Model ids now marked plan_blocked. */
  planBlocked: string[];
  /** Model ids now marked available. */
  available: string[];
  /** Model ids left untouched because the user deliberately removed them. */
  skippedUserRemoved: string[];
  /** Model ids left untouched because the live catalog does not list them. */
  skippedNotInCatalog: string[];
}

/**
 * Non-probing entitlement reconciliation for Copilot: never sends a request
 * that could consume premium quota. Skips rows the user removed
 * (`metadata.deactivatedBy === 'user'`; only a re-add clears it) and rows the
 * live catalog does not list (left exactly as they are). Reactivates other
 * inactive rows (older installs may hold rows deactivated without provenance)
 * and sets each one's entitlement from the payload's `policy.state` hint, so a
 * plan upgrade clears a chat-time `plan_blocked` badge on the next refresh.
 * Pass `discovered` to reuse a catalog the discovery route already fetched.
 */
export async function reconcileCopilotEntitlements(
  discovered?: DiscoveredModel[]
): Promise<CopilotReconcileSummary> {
  const catalog = discovered ?? (await discoverCopilotModels());
  const hintByModelId = new Map(catalog.map((m) => [m.modelId, m.entitlement]));

  const rows = await Models.listByProviderId(COPILOT_PROVIDER_ID);
  const nowIso = new Date().toISOString();

  const planBlocked: string[] = [];
  const available: string[] = [];
  const skippedUserRemoved: string[] = [];
  const skippedNotInCatalog: string[] = [];
  let reactivated = 0;

  for (const row of rows) {
    // The user deliberately removed this model — never auto-resurrect it and
    // never rewrite its status. Only an explicit re-add clears the stamp.
    if (row.metadata?.deactivatedBy === 'user') {
      skippedUserRemoved.push(row.modelId);
      continue;
    }

    // Not in the live catalog: no signal to act on. Leave is_active and the
    // cached entitlement untouched — force-reactivating a stale/delisted model
    // as 'available' would resurrect dead rows.
    if (!hintByModelId.has(row.modelId)) {
      skippedNotInCatalog.push(row.modelId);
      continue;
    }

    const hint = hintByModelId.get(row.modelId);
    const verdict: ModelEntitlementMeta =
      hint?.status === 'plan_blocked'
        ? {
            status: 'plan_blocked',
            ...(hint.reason ? { reason: hint.reason } : {}),
            checkedAt: nowIso,
            source: 'discovery',
          }
        : { status: 'available', checkedAt: nowIso, source: 'discovery' };

    if (!row.isActive) reactivated += 1;
    if (verdict.status === 'plan_blocked') planBlocked.push(row.modelId);
    else available.push(row.modelId);

    // Keep catalog-listed, non-user-removed rows active/visible — entitlement
    // lives in metadata, not in the active flag.
    await Models.setEntitlement(row.id, verdict, true).catch((err) =>
      logger.warn('Copilot setEntitlement failed during reconcile', {
        modelId: row.modelId,
        err: getErrorMessage(err),
      })
    );
  }

  logger.info('Copilot entitlement reconciliation complete', {
    total: rows.length,
    reactivated,
    planBlocked: planBlocked.length,
    available: available.length,
    skippedUserRemoved: skippedUserRemoved.length,
    skippedNotInCatalog: skippedNotInCatalog.length,
  });

  return {
    providerId: 'copilot',
    total: rows.length,
    reactivated,
    planBlocked,
    available,
    skippedUserRemoved,
    skippedNotInCatalog,
  };
}
