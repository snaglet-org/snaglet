/**
 * Entitlement reconciliation.
 *
 * A provider's `/models` catalog (or a curated list) advertises models the
 * *credential* may not actually be allowed to run — Copilot returns 8+ plan-
 * blocked models in a 21-model catalog; a ChatGPT-account Codex token runs only
 * a narrow slice of the Codex catalog. Importing them unfiltered leaves the
 * picker full of models that error-loop when selected.
 *
 * This module PROBES each candidate with a minimal 1-token request on the live
 * credential (bounded concurrency), then:
 *   - imports / keeps active the models that pass (verdict `ok`), and
 *   - deactivates the models that fail, recording the upstream reason on the row
 *     (`metadata.entitlement`), so the picker only offers models that run.
 *
 * Verdicts are cached on the model row and only re-probed on an explicit
 * refresh (`force`) or once they age past `maxAgeMs`, so routine discovery stays
 * cheap. The prober is injected so this is unit-testable with a mocked fetch.
 */

import { Models } from '@snaglet/db/tables/models';
import type { ModelEntitlementMeta } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import type { DiscoveredModel } from './types';

export interface ModelProbeResult {
  ok: boolean;
  /** Upstream reason when the probe was rejected. */
  reason?: string;
  /** Transient failure (rate limit, 5xx, network): not an entitlement verdict.
   *  The model keeps its current state and no verdict is cached. */
  transient?: boolean;
}

/** Minimal 1-token entitlement probe for a single model id. */
export type ModelProbe = (modelId: string) => Promise<ModelProbeResult>;

export interface ReconcileOptions {
  providerId: string;
  candidates: DiscoveredModel[];
  probe: ModelProbe;
  /** Max concurrent probes. Default 3. */
  concurrency?: number;
  /** Re-probe even when a fresh cached verdict exists. Default false. */
  force?: boolean;
  /** Freshness window for cached verdicts, in ms. Default 24h. */
  maxAgeMs?: number;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
}

interface ReconcileEntry {
  modelId: string;
  status: 'ok' | 'blocked' | 'inconclusive';
  reason?: string;
  /** True when a cached verdict was reused instead of re-probing. */
  cached: boolean;
}

export interface ReconcileSummary {
  providerId: string;
  working: string[];
  pruned: Array<{ modelId: string; reason: string }>;
  /** Transient probe failures — untouched rows, re-probed next reconcile. */
  inconclusive: Array<{ modelId: string; reason: string }>;
  entries: ReconcileEntry[];
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isFresh(checkedAt: string | undefined, now: number, maxAgeMs: number): boolean {
  if (!checkedAt) return false;
  const t = Date.parse(checkedAt);
  return Number.isFinite(t) && now - t < maxAgeMs;
}

export async function reconcileProviderEntitlements(
  opts: ReconcileOptions
): Promise<ReconcileSummary> {
  const { providerId, candidates, probe } = opts;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const force = opts.force ?? false;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const nowFn = opts.now ?? Date.now;

  const existing = await Models.listByProviderId(providerId);
  const byModelId = new Map(existing.map((r) => [r.modelId, r]));

  const entries = await mapWithConcurrency(
    candidates,
    concurrency,
    async (cand): Promise<ReconcileEntry> => {
      const cached = byModelId.get(cand.modelId)?.metadata?.entitlement;
      if (!force && cached?.status && isFresh(cached.checkedAt, nowFn(), maxAgeMs)) {
        // The verdict enum is shared with copilot's non-probing statuses
        // (`available`/`plan_blocked`); a probe-provider row only ever carries
        // `ok`/`blocked`, but narrow defensively so the reconciler is robust.
        const status = cached.status === 'ok' || cached.status === 'available' ? 'ok' : 'blocked';
        return {
          modelId: cand.modelId,
          status,
          reason: cached.reason,
          cached: true,
        };
      }
      const result = await probe(cand.modelId).catch((err) => ({
        ok: false,
        // A thrown probe (network/timeout) is a transient condition, never an
        // entitlement verdict.
        transient: true,
        reason: getErrorMessage(err),
      }));
      return {
        modelId: cand.modelId,
        status: result.ok ? 'ok' : result.transient ? 'inconclusive' : 'blocked',
        reason: result.reason,
        cached: false,
      };
    }
  );

  const nowIso = new Date(nowFn()).toISOString();
  const candidateByModelId = new Map(candidates.map((c) => [c.modelId, c]));
  const newlyPassing: Parameters<typeof Models.bulkUpsert>[1] = [];

  for (const entry of entries) {
    // Cached verdicts are already persisted (row already active/inactive) — skip
    // the write so routine discovery doesn't churn rows.
    if (entry.cached) continue;

    // Transient probe failures (rate limit, 5xx, network) are not verdicts:
    // keep the row exactly as it is and cache nothing, so the next reconcile
    // re-probes. Without this, a 429 during a burst would prune a good model.
    if (entry.status === 'inconclusive') continue;

    const row = byModelId.get(entry.modelId);
    const verdict: ModelEntitlementMeta = {
      status: entry.status,
      ...(entry.reason ? { reason: entry.reason } : {}),
      checkedAt: nowIso,
    };

    if (entry.status === 'ok') {
      if (row) {
        await Models.setEntitlement(row.id, verdict, true);
      } else {
        // Passing but never imported → create it active, carrying the verdict.
        const cand = candidateByModelId.get(entry.modelId)!;
        newlyPassing.push({
          modelId: cand.modelId,
          displayName: cand.displayName,
          description: cand.description,
          family: cand.family ?? null,
          contextWindowTokens: cand.contextWindowTokens ?? null,
          maxOutputTokens: cand.maxOutputTokens ?? null,
          supportsTools: cand.supportsTools,
          supportsVision: cand.supportsVision,
          supportsReasoning: cand.supportsReasoning,
          metadata: { entitlement: verdict },
        });
      }
    } else if (row) {
      // Blocked and already in the picker → record the reason + deactivate.
      await Models.setEntitlement(row.id, verdict, false);
    }
    // Blocked and never imported → nothing to store; reported as pruned below.
  }

  if (newlyPassing.length > 0) {
    await Models.bulkUpsert(providerId, newlyPassing);
  }

  const working = entries.filter((e) => e.status === 'ok').map((e) => e.modelId);
  const pruned = entries
    .filter((e) => e.status === 'blocked')
    .map((e) => ({ modelId: e.modelId, reason: e.reason ?? 'blocked' }));
  const inconclusive = entries
    .filter((e) => e.status === 'inconclusive')
    .map((e) => ({ modelId: e.modelId, reason: e.reason ?? 'transient probe failure' }));

  logger.info('Entitlement reconciliation complete', {
    providerId,
    total: entries.length,
    working: working.length,
    pruned: pruned.length,
    inconclusive: inconclusive.length,
    reprobed: entries.filter((e) => !e.cached).length,
  });

  return { providerId, working, pruned, inconclusive, entries };
}
