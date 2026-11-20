/**
 * UtilityModelResolver — which model writes a per-agent thread summary: 1.
 * per-thread-per-agent override, 2. per-agent override, 3. the agent's own
 * effective model in that thread (the default; off when
 * `agent.summary_model_require_explicit` is set), 4. a visible skip. Privacy
 * rule: thread content never goes to a cloud provider the agent isn't already
 * using unless the user configured it (steps 1–2); no code path here
 * enumerates other providers. Every summary has an owning agent.
 */

import { Models } from '@snaglet/db/tables/models';
import { Threads } from '@snaglet/db/tables/threads';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { isCredentialDecryptError } from '@server/services/ProviderCredentialService/errors';
import { PROVIDER_REGISTRY } from '@server/services/ProviderChatService/providers/registry';
import { normalizeProviderId } from '@server/services/ProviderChatService/shared';
import { settingsService, type SettingDef } from '@server/services/settings';
import { agentSettings, type SummaryModelRef } from '@server/services/settings/categories/agent';
import {
  PROVIDER_UTILITY_CAPS,
  isLocalUtilityProvider,
  utilityContextTokens,
  utilityMaxInputChars,
  utilityTimeoutMs,
} from './utilityModels';

/**
 * Per-agent thread summaries are the only utility text this resolver serves.
 * Kept as a named union (rather than inlined away) because it is the field
 * callers pass and the thing that would have to widen if another utility
 * purpose is ever added.
 */
type UtilityPurpose = 'thread-summary';

export type UtilitySkipReason =
  /** Agent/thread has no effective model configured. */
  | 'no-model-for-agent'
  /** Provider unknown to the chat registry / not chat-capable. */
  | 'unsupported-provider'
  /** A cloud provider resolved but no usable credential exists anywhere. */
  | 'no-credentials'
  /** Daily generation cap reached — set by callers, surfaced via the same type. */
  | 'daily-cap-reached'
  /**
   * `agent.summary_model_require_explicit` is on and no override names a
   * summarizer, so step 3 (borrow the agent's own model) is not permitted.
   */
  | 'no-summary-model-configured'
  /**
   * Resolution threw unexpectedly; never a silent failure. With `retryable`
   * set it was a lookup that could not complete (the database was
   * unreachable), which says nothing about the configuration, so the next
   * pass simply retries instead of halting the thread.
   */
  | 'resolution-failed';

type UtilitySource = 'thread-override' | 'agent-override' | 'own-model';

export interface ResolvedUtilityModel {
  providerId: string;
  modelId: string;
  /** Credential to run with; null for keyless local providers (or env-var creds). */
  credentialId: string | null;
  isLocal: boolean;
  /** Prompt-input budget (chars) for this model. */
  maxInputChars: number;
  /** The model's context window in tokens, when known. */
  contextTokens?: number;
  /** The most tokens the model can write in one reply, when the catalog records it. */
  maxOutputTokens?: number;
  /** Generation timeout for this model class (cloud 60s / local 300s). */
  timeoutMs: number;
  source: UtilitySource;
}

export type UtilityResolution =
  | { ok: true; model: ResolvedUtilityModel }
  | { ok: false; reason: UtilitySkipReason; detail?: string; retryable?: true };

export interface ResolveUtilityModelInput {
  purpose: UtilityPurpose;
  threadId?: string;
  agentId?: string;
}

/**
 * A provider is summary-capable when the chat registry can drive it AND the
 * capability table knows it (keeps verify-only ids like `github` out).
 */
function isChatCapable(providerId: string): boolean {
  return !!PROVIDER_REGISTRY[providerId]?.chat && !!PROVIDER_UTILITY_CAPS[providerId];
}

/**
 * A lookup the chain depends on could not complete (database unreachable, a
 * dropped connection). It says nothing about whether the configuration
 * works, so it resolves to a retryable `resolution-failed` — never to
 * `no-credentials` or `no-model-for-agent`, which halt the thread.
 */
class ResolutionLookupError extends Error {
  constructor(what: string, cause: unknown) {
    super(`could not read ${what}: ${getErrorMessage(cause)}`, { cause });
    this.name = 'ResolutionLookupError';
  }
}

/**
 * A setting the chain reads. A persisted value that fails its schema is a real
 * misconfiguration and stays a plain failure; anything else is a lookup error.
 */
async function readSetting<T>(def: SettingDef<T>): Promise<T> {
  try {
    return await settingsService.read(def);
  } catch (err) {
    if (/fails schema/.test(getErrorMessage(err))) throw err;
    throw new ResolutionLookupError(`setting ${def.category}.${def.key}`, err);
  }
}

/** A credential's secret; null when it is gone, empty, or cannot be decrypted. */
async function readSecretOrNull(credentialId: string): Promise<string | null> {
  try {
    return await providerCredentialService.getSecretById(credentialId);
  } catch (err) {
    if (isCredentialDecryptError(err)) return null;
    throw new ResolutionLookupError(`credential ${credentialId}`, err);
  }
}

/**
 * Find a usable secret for a provider when no credential is pinned (the own
 * model or an override saved without a credential); pinned credentials go
 * through `validatePinnedCredential`, so `preferredCredentialId` is defensive.
 * `credentialId` may be null even when usable (env var, keyless local): this
 * is a usability check, not a secret hand-off.
 */
async function checkCredentials(
  providerId: string,
  modelId: string,
  preferredCredentialId?: string | null
): Promise<{ usable: boolean; credentialId: string | null }> {
  if (isLocalUtilityProvider(providerId)) {
    return { usable: true, credentialId: null };
  }

  if (preferredCredentialId) {
    const secret = await readSecretOrNull(preferredCredentialId);
    if (secret) return { usable: true, credentialId: preferredCredentialId };
  }

  // Prefer the provider's primary credential via the same resolver the chat
  // model uses (preferred -> primary -> any), and return its id so the summary
  // runs on the same key. A null id would let the adapter re-resolve to the
  // most recently updated credential, which may differ from the primary.
  let resolvedId: string | null;
  try {
    resolvedId = await providerCredentialService.resolveCredentialIdForModel({
      providerId,
      modelId,
    });
  } catch (err) {
    throw new ResolutionLookupError(`the ${providerId} primary credential`, err);
  }
  if (resolvedId) {
    const secret = await readSecretOrNull(resolvedId);
    if (secret) return { usable: true, credentialId: resolvedId };
  }

  // Degenerate fallback: a stored secret exists but not on the resolved
  // (primary) credential — keep the summary usable, pinning nothing (the
  // adapter re-resolves) rather than blocking it.
  let fromStore: string | null;
  try {
    fromStore = await providerCredentialService.getSecret(providerId);
  } catch (err) {
    if (!isCredentialDecryptError(err)) {
      throw new ResolutionLookupError(`the ${providerId} default credential`, err);
    }
    fromStore = null;
  }
  if (fromStore) return { usable: true, credentialId: null };

  for (const envVar of PROVIDER_REGISTRY[providerId]?.envSecretVars ?? []) {
    if (process.env[envVar]) return { usable: true, credentialId: null };
  }

  return { usable: false, credentialId: null };
}

/**
 * Strictly validate a credential the user pinned: it must exist, belong to
 * this provider, and yield a secret. An unusable pin is a resolution failure,
 * never a license to try another credential, because the provider stack
 * honors the pin at call time and would fail there instead. A lookup error
 * throws `ResolutionLookupError`. The detail is the halt copy. Cloud-only.
 */
async function validatePinnedCredential(
  providerId: string,
  credentialId: string,
  pinnedOn: string
): Promise<{ usable: true } | { usable: false; detail: string }> {
  let credential: Awaited<ReturnType<typeof providerCredentialService.getSafeById>>;
  try {
    credential = await providerCredentialService.getSafeById(credentialId);
  } catch (err) {
    throw new ResolutionLookupError(`credential ${credentialId}`, err);
  }
  if (!credential) {
    return {
      usable: false,
      detail:
        `the ${providerId} credential selected for ${pinnedOn} (${credentialId}) no longer ` +
        'exists — it was deleted. Choose another credential for it',
    };
  }
  const named = `the ${providerId} credential "${credential.label}" selected for ${pinnedOn}`;
  const credentialProviderId = normalizeProviderId(credential.providerId);
  // A mismatched pin must not even attempt a decrypt.
  if (credentialProviderId !== providerId) {
    return {
      usable: false,
      detail:
        `selected credential "${credential.label}" belongs to ${credentialProviderId}, ` +
        `not ${providerId}`,
    };
  }
  let secret: string | null;
  try {
    secret = await providerCredentialService.getSecretById(credentialId);
  } catch (err) {
    if (!isCredentialDecryptError(err)) {
      throw new ResolutionLookupError(`credential ${credentialId}`, err);
    }
    return {
      usable: false,
      detail: `${named} cannot be decrypted with this server's encryption key — re-enter it`,
    };
  }
  if (!secret) {
    return { usable: false, detail: `${named} has no stored secret — re-enter it` };
  }
  return { usable: true };
}

/** Assemble the resolved shape for a validated provider+model candidate. */
async function buildResolved(
  providerId: string,
  modelId: string,
  credentialId: string | null,
  source: UtilitySource
): Promise<ResolvedUtilityModel> {
  const isLocal = isLocalUtilityProvider(providerId);
  const row = await Models.findByProviderAndModelId(providerId, modelId).catch(() => null);
  return {
    providerId,
    modelId,
    credentialId,
    isLocal,
    maxInputChars: utilityMaxInputChars(providerId, row?.contextWindowTokens ?? null),
    contextTokens: utilityContextTokens(providerId, row?.contextWindowTokens ?? null),
    ...(row?.maxOutputTokens && row.maxOutputTokens > 0
      ? { maxOutputTokens: row.maxOutputTokens }
      : {}),
    timeoutMs: utilityTimeoutMs(isLocal),
    source,
  };
}

/**
 * Validate an explicit reference (steps 1–2): provider must be chat-capable
 * with usable credentials, and the model must be active in the catalog for
 * cloud providers (never call a model id the user hasn't enabled; local
 * runtimes serve whatever they serve). An explicit-but-unusable reference
 * resolves to a skip with the reason.
 */
async function tryResolveExplicit(
  ref: SummaryModelRef,
  source: 'thread-override' | 'agent-override'
): Promise<UtilityResolution> {
  const providerId = normalizeProviderId(ref.providerId);
  if (!isChatCapable(providerId)) {
    logger.warn(
      `[utility-model] configured ${source} references non-chat provider '${ref.providerId}' — ignoring`
    );
    return {
      ok: false,
      reason: 'unsupported-provider',
      detail: `configured ${source} references non-chat provider '${ref.providerId}'`,
    };
  }

  let credentialId: string | null = null;
  if (!isLocalUtilityProvider(providerId)) {
    if (!ref.credentialId) {
      // No pinned credential on the override — fall back to the provider's
      // default stored credential (or a registry env var), exactly like the
      // own-model path (step 3). This is same-provider only: the override
      // already names the provider, so no cross-provider borrowing occurs.
      const creds = await checkCredentials(providerId, ref.modelId, null);
      if (!creds.usable) {
        return {
          ok: false,
          reason: 'no-credentials',
          detail:
            `configured ${source} ${providerId}/${ref.modelId} has no selected credential ` +
            `and no usable default credential exists for ${providerId}`,
        };
      }
      credentialId = creds.credentialId;
    } else {
      const pinned = await validatePinnedCredential(
        providerId,
        ref.credentialId,
        source === 'thread-override' ? "this thread's summary model" : "this agent's summary model"
      );
      if (!pinned.usable) {
        return { ok: false, reason: 'no-credentials', detail: pinned.detail };
      }
      credentialId = ref.credentialId;
    }
  }

  if (!isLocalUtilityProvider(providerId)) {
    let row: Awaited<ReturnType<typeof Models.findByProviderAndModelId>>;
    try {
      row = await Models.findByProviderAndModelId(providerId, ref.modelId);
    } catch (err) {
      throw new ResolutionLookupError(`catalog model ${providerId}/${ref.modelId}`, err);
    }
    if (!row || !row.isActive) {
      logger.warn(
        `[utility-model] configured ${source} ${providerId}/${ref.modelId} is not an active catalog model — ignoring`
      );
      return {
        ok: false,
        reason: 'no-model-for-agent',
        detail: `configured ${source} ${providerId}/${ref.modelId} is not an active catalog model`,
      };
    }
  }

  return { ok: true, model: await buildResolved(providerId, ref.modelId, credentialId, source) };
}

/**
 * Resolve the utility model for a summarization job. Never throws — an
 * unexpected failure resolves to a visible skip, not an exception in the
 * fire-and-forget callers.
 */
export async function resolveUtilityModel(
  input: ResolveUtilityModelInput
): Promise<UtilityResolution> {
  try {
    return await resolveChain(input);
  } catch (err) {
    const detail = getErrorMessage(err);
    if (err instanceof ResolutionLookupError) {
      logger.warn(`[utility-model] resolution will retry: ${detail}`);
      return { ok: false, reason: 'resolution-failed', detail, retryable: true };
    }
    logger.error(`[utility-model] resolution failed unexpectedly: ${detail}`);
    return { ok: false, reason: 'resolution-failed', detail };
  }
}

async function resolveChain(input: ResolveUtilityModelInput): Promise<UtilityResolution> {
  const { threadId, agentId } = input;

  // Every step below is scoped to a specific agent in a specific thread. With
  // no agent there is no owning settings scope and no effective model to fall
  // back to, so this is a visible skip rather than a workspace-wide default.
  if (!threadId || !agentId) {
    return {
      ok: false,
      reason: 'no-model-for-agent',
      detail: 'thread summaries resolve per (thread, agent); one or both are missing',
    };
  }

  // Step 1 — per-thread-per-agent override.
  const threadOverrides = await readSetting(agentSettings.threadSummaryModelOverrides);
  const threadRef = threadOverrides[threadId]?.[agentId];
  if (threadRef) {
    return tryResolveExplicit(threadRef, 'thread-override');
  }

  // Step 2 — per-agent override.
  const agentOverrides = await readSetting(agentSettings.summaryModelOverrides);
  const agentRef = agentOverrides[agentId];
  if (agentRef) {
    return tryResolveExplicit(agentRef, 'agent-override');
  }

  // Step 3 — the agent's own effective model, unless
  // `summary_model_require_explicit` is on. Then not-configured is a skip, not
  // a fallback, and the caller stops the run.
  if (await readSetting(agentSettings.summaryModelRequireExplicit)) {
    return {
      ok: false,
      reason: 'no-summary-model-configured',
      detail:
        'agent.summary_model_require_explicit is on and no summary-model override is set for this agent',
    };
  }

  let effective: Awaited<ReturnType<typeof Threads.getEffectiveModel>>;
  try {
    effective = await Threads.getEffectiveModel(threadId, agentId);
  } catch (err) {
    throw new ResolutionLookupError(`the model of agent ${agentId} in thread ${threadId}`, err);
  }
  if (!effective?.providerId || !effective.modelId) {
    return {
      ok: false,
      reason: 'no-model-for-agent',
      detail: 'agent has no provider/model configured',
    };
  }

  const providerId = normalizeProviderId(effective.providerId);
  if (!isChatCapable(providerId)) {
    return {
      ok: false,
      reason: 'unsupported-provider',
      detail: `agent provider '${effective.providerId}' is not chat-capable`,
    };
  }

  // A credential pinned to this agent's model is validated as strictly as an
  // explicit override. Failing here reports `no-credentials`, so repairing the
  // credential clears the halt; letting generation fail would report a
  // model-failing halt, which only lifts for a different model.
  if (effective.credentialId && !isLocalUtilityProvider(providerId)) {
    const pinned = await validatePinnedCredential(
      providerId,
      effective.credentialId,
      effective.source === 'thread_participant'
        ? "this agent's model in this thread"
        : "this agent's model"
    );
    if (!pinned.usable) {
      return { ok: false, reason: 'no-credentials', detail: pinned.detail };
    }
    return {
      ok: true,
      model: await buildResolved(
        providerId,
        effective.modelId,
        effective.credentialId,
        'own-model'
      ),
    };
  }

  // No credential pinned (or a keyless local runtime): the stored provider
  // credential or a registry env var may still make this usable.
  const creds = await checkCredentials(providerId, effective.modelId, effective.credentialId);
  if (!creds.usable) {
    return {
      ok: false,
      reason: 'no-credentials',
      detail: `no usable credentials for ${providerId}`,
    };
  }

  return {
    ok: true,
    model: await buildResolved(
      providerId,
      effective.modelId,
      creds.credentialId ?? effective.credentialId ?? null,
      'own-model'
    ),
  };
}
