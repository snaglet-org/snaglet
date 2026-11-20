/**
 * Discovery → catalog persistence.
 *
 * `discoverModels` only returns the live catalog: nothing lands in the
 * `models` table until rows are imported (e.g. by the model picker's bulk
 * import). Runtime paths that read the table directly (context budgets via
 * `Models.findByProviderAndModelId`) would otherwise see nothing for
 * credentials created over the API and fall back to the 8192-token
 * DEFAULT_CONTEXT_WINDOW, starving the message budget.
 *
 * `persistDiscoveredModels` runs a discovery pass and writes the results into
 * the catalog, conservatively:
 *   - models with no row at all are imported active with their discovered
 *     metadata (context window, max output, capability flags);
 *   - existing rows, active or user-deactivated, are never reactivated or
 *     resurrected (bulkUpsert's ON CONFLICT would clear the
 *     `deactivatedBy: 'user'` stamp, so it is only used for brand-new rows).
 *     Their context_window_tokens / max_output_tokens take the limits the
 *     provider reported for the model, unless a person set them
 *     (`metadata.limitsEditedBy = 'user'`); a limit discovery only inferred
 *     fills a NULL and never replaces a stored value.
 */

import { Models } from '@snaglet/db/tables/models';
import { discoverModels } from '@server/services/ProviderModelDiscoveryService';
import { emitModelsChanged } from '@server/realtime/surfaces/models';

export interface PersistDiscoveredModelsSummary {
  providerId: string;
  /** Models returned by the live discovery pass. */
  discovered: number;
  /** Brand-new catalog rows written. */
  imported: number;
  /** Existing rows whose window/output limits were filled in or corrected. */
  backfilled: number;
  /** Discovery-layer warning (unsupported provider, daemon unreachable, …). */
  warning?: string;
}

export async function persistDiscoveredModels(
  providerId: string
): Promise<PersistDiscoveredModelsSummary> {
  const result = await discoverModels(providerId);

  // Join against ALL rows — discoverModels' own `alreadyImported` flag only
  // reflects ACTIVE rows, and upserting over a user-deactivated row would
  // resurrect it behind the user's back.
  const known = await Models.listByProviderId(providerId);
  const knownByModelId = new Map(known.map((row) => [row.modelId, row]));

  const toImport: Parameters<typeof Models.bulkUpsert>[1] = [];
  let backfilled = 0;

  for (const m of result.models) {
    const existing = knownByModelId.get(m.modelId);
    if (!existing) {
      toImport.push({
        modelId: m.modelId,
        displayName: m.displayName,
        description: m.description,
        family: m.family ?? null,
        contextWindowTokens: m.contextWindowTokens ?? null,
        maxOutputTokens: m.maxOutputTokens ?? null,
        supportsTools: m.supportsTools,
        supportsVision: m.supportsVision,
        supportsReasoning: m.supportsReasoning,
        metadata: m.metadata,
      });
      continue;
    }

    const patch: { contextWindowTokens?: number | null; maxOutputTokens?: number | null } = {};
    // Limits a person set stay; reported ones only fill gaps there.
    const reported = existing.metadata?.limitsEditedBy === 'user' ? undefined : m.reportedLimits;
    const window = reported?.contextWindowTokens;
    if (
      window !== undefined
        ? existing.contextWindowTokens !== window
        : existing.contextWindowTokens == null && m.contextWindowTokens != null
    ) {
      patch.contextWindowTokens = window ?? m.contextWindowTokens;
    }
    const output = reported?.maxOutputTokens;
    if (
      output !== undefined
        ? existing.maxOutputTokens !== output
        : existing.maxOutputTokens == null && m.maxOutputTokens != null
    ) {
      patch.maxOutputTokens = output ?? m.maxOutputTokens;
    }
    if (Object.keys(patch).length > 0) {
      await Models.updateModel(existing.id, patch);
      backfilled += 1;
    }
  }

  const imported = toImport.length > 0 ? await Models.bulkUpsert(providerId, toImport) : [];
  if (imported.length > 0 || backfilled > 0) emitModelsChanged(providerId);

  return {
    providerId,
    discovered: result.models.length,
    imported: imported.length,
    backfilled,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}
