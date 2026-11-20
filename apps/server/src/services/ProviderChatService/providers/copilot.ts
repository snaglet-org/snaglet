import type { SnagletAgent } from '@server/services/AgentService';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { assertSecret, pickSecret } from '../shared';
import { Models } from '@snaglet/db/tables/models';
import type { ModelRow } from '@snaglet/db/tables/models';
import type { ModelEntitlementMeta } from '@snaglet/shared/types';
import { Providers } from '@snaglet/db/tables/providers';
import { logger } from '@server/config/logger';
import { callOpenAICompatibleChatCompletions } from './shared/chat-completions';
import { callResponsesEndpoint, extractResponsesErrorReason } from './shared/responses-api';
import { NO_DOTS_TOOL_NAME_GRAMMAR } from '@server/services/ToolService/lib/toolName';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyOptions,
  ProviderVerifyResult,
} from '../types';
import { getErrorMessage } from '@snaglet/shared/utils';

export const COPILOT_FALLBACK_BASE_URL = 'https://api.individual.githubcopilot.com';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_VERIFY_MODEL = 'gpt-4o';
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes
const SECONDS_MS_THRESHOLD = 100_000_000_000; // distinguish seconds from ms epochs

// Keyed by credential ID to avoid redundant exchanges within the same process.
interface CachedToken {
  token: string;
  baseUrl: string;
  expiresAt: number; // ms epoch
}
const tokenCache = new Map<string, CachedToken>();

/** Normalize expires_at to milliseconds — GitHub may return seconds or ms. */
function normalizeExpiresAt(raw: unknown): number {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < SECONDS_MS_THRESHOLD ? value * 1000 : value;
}

/**
 * Extract the API base URL from the Copilot subscription token.
 * Tokens embed `proxy-ep=proxy.individual.githubcopilot.com` —
 * we swap `proxy.` → `api.` to get the chat completions host.
 */
export function extractBaseUrl(token: string): string {
  const match = /(?:^|;)\s*proxy-ep=([^;\s]+)/i.exec(token);
  if (!match) return COPILOT_FALLBACK_BASE_URL;
  let host = match[1].replace(/^https?:\/\//, '');
  host = host.replace(/^proxy\./, 'api.');
  return `https://${host}`;
}

/**
 * Exchange a GitHub token (gho_* OAuth token or a PAT) for a short-lived
 * Copilot subscription token via the internal GitHub endpoint. Results are
 * cached in-memory.
 */
export async function exchangeGitHubToken(
  githubToken: string,
  credentialId?: string
): Promise<{ token: string; baseUrl: string }> {
  if (credentialId) {
    const cached = tokenCache.get(credentialId);
    if (cached && Date.now() < cached.expiresAt - TOKEN_SAFETY_MARGIN_MS) {
      return { token: cached.token, baseUrl: cached.baseUrl };
    }
  }

  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
    },
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      String(data.message ?? data.error ?? '') || `GitHub token exchange failed (${res.status})`;
    throw new Error(message);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const token = String(data.token ?? '');
  if (!token) throw new Error('GitHub returned empty Copilot token');

  const expiresAt = normalizeExpiresAt(data.expires_at);
  const baseUrl = extractBaseUrl(token);

  // Populate cache
  if (credentialId) {
    tokenCache.set(credentialId, { token, baseUrl, expiresAt });
  }

  // Persist the subscription token + expiry in credential metadata for resilience
  if (credentialId) {
    providerCredentialService
      .updateSecret(credentialId, githubToken, {
        copilot_token: token,
        copilot_base_url: baseUrl,
        copilot_expires_at: expiresAt,
      })
      .catch((err) => {
        logger.warn(`[copilot] failed to persist subscription token: ${getErrorMessage(err)}`);
      });
  }

  return { token, baseUrl };
}

//
// Copilot's `/chat/completions` rejects models for three distinct reasons:
//
//   1. Integrator allow-list:    `requested model is not available for integrator …`
//      The error embeds the allowed list (`Available models: [a b c …]`).
//   2. Endpoint mismatch:        `model "X" is not accessible via the /chat/completions endpoint`
//      Codex variants surface this — they're listed in /models but the chat-
//      completions surface doesn't accept them on this integrator/tier. There's
//      no allowed list embedded in this error. The model IS usable via the
//      Responses surface, so this is a routing/capability issue, not a plan gate.
//   3. Plan/entitlement gate:    `The requested model is not supported.`
//      The account's Copilot plan doesn't include the model (distinct from the
//      integrator allow-list — no embedded list).
//
// The model row is never deactivated for these: entitlement changes (plan
// upgrades, quota resets, org policy edits), so deactivating would bake in
// today's plan permanently.
// For the plan + integrator classes we mark the row `plan_blocked` in metadata
// (row stays active, visible, pinnable, badged "not on your plan"); the run
// still fails that turn with a clear message. On the next discovery refresh the
// status is re-evaluated, so a plan change clears it.

const INTEGRATOR_REJECTION_RE = /requested model is not available for integrator/i;
const ENDPOINT_REJECTION_RE = /not accessible via the \/chat\/completions endpoint/i;
const PLAN_REJECTION_RE = /requested model is not supported/i;

export type CopilotRejectionClass = 'integrator' | 'endpoint' | 'plan';

/** Classify a Copilot chat error into a known rejection class, or null. */
export function classifyCopilotRejection(message: string): CopilotRejectionClass | null {
  if (INTEGRATOR_REJECTION_RE.test(message)) return 'integrator';
  if (ENDPOINT_REJECTION_RE.test(message)) return 'endpoint';
  if (PLAN_REJECTION_RE.test(message)) return 'plan';
  return null;
}

function parseAllowedModelsList(message: string): string[] {
  const match = /Available models?:\s*\[([^\]]+)\]/i.exec(message);
  if (!match) return [];
  return match[1]
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Dynamic re-pin suggestions drawn from the account's own still-usable Copilot
 * model rows (the same Models table the picker reads) — never a hardcoded list,
 * so it recommends what THIS account can actually run (Claude models included;
 * Copilot entitlement is per-model, not per-vendor). Excludes the rejected
 * model and any row already marked plan_blocked/blocked.
 */
export function buildCopilotPlanSuggestions(
  rows: ModelRow[],
  excludeModelId: string,
  limit = 5
): string[] {
  return rows
    .filter((r) => r.modelId !== excludeModelId)
    .filter((r) => {
      const status = r.metadata?.entitlement?.status;
      return status !== 'plan_blocked' && status !== 'blocked';
    })
    .map((r) => r.modelId)
    .slice(0, limit);
}

/** Mark a Copilot model row `plan_blocked` (keeping it active/visible). */
async function markCopilotPlanBlocked(
  agent: SnagletAgent,
  requestedModelId: string,
  reason: string,
  rejectionClass: CopilotRejectionClass
): Promise<void> {
  const row = await Models.findByProviderAndModelId('copilot', requestedModelId).catch(() => null);
  if (!row) return;
  const verdict: ModelEntitlementMeta = {
    status: 'plan_blocked',
    reason,
    checkedAt: new Date().toISOString(),
    source: 'chat',
  };
  await Models.setEntitlement(row.id, verdict, true)
    .then(() =>
      logger.warn('Copilot model marked plan_blocked after rejection', {
        agentId: agent.id,
        agentName: agent.name,
        modelId: requestedModelId,
        rejectionClass,
      })
    )
    .catch((err) =>
      logger.warn('Copilot setEntitlement failed', { err, modelId: requestedModelId })
    );
}

/**
 * Format the upstream error, and for a known plan/integrator rejection class,
 * mark the model row `plan_blocked` (never deactivate) and build a clear,
 * dynamically-sourced re-pin message. The returned string fails that turn.
 */
async function handleCopilotChatError(
  agent: SnagletAgent,
  requestedModelId: string,
  message: string
): Promise<string> {
  const rejectionClass = classifyCopilotRejection(message);
  if (!rejectionClass) return message;

  if (rejectionClass === 'integrator') {
    await markCopilotPlanBlocked(agent, requestedModelId, message, 'integrator');
    // The error embeds the exact allow-list — the most precise suggestion set.
    // Fall back to the account's available rows when it's absent.
    const allowed = parseAllowedModelsList(message);
    const suggestions =
      allowed.length > 0
        ? allowed.slice(0, 6).join(', ') + (allowed.length > 6 ? ', …' : '')
        : (await copilotAvailableSuggestions(requestedModelId)).join(', ');
    const tail = suggestions ? ` Re-pin this agent to one of: ${suggestions}.` : '';
    return `Copilot's "vscode-chat" integrator does not allow \`${requestedModelId}\` for this account. It stays in the picker, badged "not on your plan", so you can re-pin it if that changes.${tail}`;
  }

  if (rejectionClass === 'plan') {
    await markCopilotPlanBlocked(agent, requestedModelId, message, 'plan');
    const suggestions = await copilotAvailableSuggestions(requestedModelId);
    const tail = suggestions.length
      ? ` Re-pin this agent to a model your plan supports (e.g. ${suggestions.join(', ')}).`
      : ' Re-pin this agent to a model your plan supports.';
    return `\`${requestedModelId}\` isn't included in your Copilot plan. It stays in the picker, badged "not on your plan", so you can re-pin it after a plan change.${tail}`;
  }

  // endpoint rejection — codex / responses-only models surface here. The model
  // is usable via the Responses surface, so this is a routing issue, not a plan
  // gate: don't mark plan_blocked, just explain.
  return `\`${requestedModelId}\` isn't usable through Copilot's chat-completions surface (it's a responses-only model in Copilot's stack). Re-pin this agent to a chat-completions model.`;
}

/** Load the account's still-usable copilot model ids for a re-pin suggestion. */
async function copilotAvailableSuggestions(excludeModelId: string): Promise<string[]> {
  const rows = await Models.listActiveByProviderId('copilot').catch(() => [] as ModelRow[]);
  return buildCopilotPlanSuggestions(rows, excludeModelId);
}

/**
 * Copilot models that must go to `${baseUrl}/responses` instead of
 * `/chat/completions`. Two kinds surface:
 *
 *   1. Codex-class ids (end in `-codex`) — exposed via `/models` but rejected
 *      by chat-completions ("not accessible via the /chat/completions
 *      endpoint").
 *   2. Named responses-only models the `-codex` heuristic misses. Verified live
 *      against `${baseUrl}/responses`: `mai-code-1-flash-picker`, `gpt-5.4-mini`.
 *
 * This is the explicit set (case-insensitive) the diagnostic asked for; the
 * `-codex` suffix stays as a forward-compatible catch-all. Add named ids here
 * as new responses-only models appear.
 */
const RESPONSES_ONLY_MODEL_IDS = new Set(
  ['mai-code-1-flash-picker', 'gpt-5.4-mini'].map((s) => s.toLowerCase())
);

function isResponsesOnlyModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return /-codex$/i.test(id) || RESPONSES_ONLY_MODEL_IDS.has(id);
}

/**
 * Copilot's gpt-5.x (and o-series) reject the `max_tokens` field on the
 * chat-completions surface and require `max_completion_tokens` (gpt-5.4
 * returns 400 on `max_tokens`). Older gpt-4.x keep `max_tokens`.
 */
export function copilotMaxTokensField(modelId: string | null | undefined): string {
  const id = (modelId ?? '').toLowerCase();
  if (/^gpt-5/.test(id) || /^o[1-9]/.test(id)) return 'max_completion_tokens';
  return 'max_tokens';
}

export async function chatCopilot(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const credRow = agent.credentialId
    ? await providerCredentialService.getFullCredentialById(agent.credentialId)
    : null;

  const isOAuth = credRow?.authType === 'oauth';
  const useResponses = isResponsesOnlyModel(agent.modelId);
  const route = useResponses ? chatCopilotResponses : chatCopilotCompat;

  // Both auth types store a GitHub token (gho_* OAuth token or a PAT). The
  // chat endpoints never accept the GitHub token itself — exchange it for a
  // short-lived Copilot subscription token, the same exchange verifyCopilot
  // validates, and use the base URL embedded in that token.
  let githubToken: string;
  if (isOAuth) {
    githubToken = credRow?.encryptedSecret ?? '';
    if (!githubToken) {
      throw new Error('Missing GitHub OAuth token. Reconnect your Copilot credential.');
    }
  } else {
    githubToken = await pickSecret(agent);
    assertSecret(githubToken, agent.provider);
  }

  // Try cached subscription token from metadata first
  const meta = (credRow?.metadataJson ?? {}) as Record<string, unknown>;
  const cachedExpiry = normalizeExpiresAt(meta.copilot_expires_at);
  if (meta.copilot_token && cachedExpiry && Date.now() < cachedExpiry - TOKEN_SAFETY_MARGIN_MS) {
    return route(
      agent,
      messages,
      String(meta.copilot_token),
      String(meta.copilot_base_url ?? COPILOT_FALLBACK_BASE_URL),
      onChunk,
      options
    );
  }

  const { token, baseUrl } = await exchangeGitHubToken(githubToken, credRow?.id);
  return route(agent, messages, token, baseUrl, onChunk, options);
}

/**
 * Copilot's Responses API path — codex-class models live here. Endpoint is
 * `${baseUrl}/responses`; if Copilot routes these elsewhere, narrow the URL
 * here. Auth + integrator headers mirror the chat-completions path.
 */
async function chatCopilotResponses(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  token: string,
  baseUrl: string,
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Version': 'vscode/1.99.0',
    'OpenAI-Beta': 'responses=experimental',
  };

  return callResponsesEndpoint({
    url: `${baseUrl}/responses`,
    headers,
    agent,
    messages,
    options,
    onChunk,
    providerLabel: 'copilot',
    errorTransform: (msg) => handleCopilotChatError(agent, agent.modelId ?? '', msg),
  });
}

async function chatCopilotCompat(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  token: string,
  baseUrl: string,
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Version': 'vscode/1.99.0',
  };

  return callOpenAICompatibleChatCompletions({
    url: `${baseUrl}/chat/completions`,
    providerLabel: 'copilot',
    errorLabel: 'Copilot',
    agent,
    messages,
    headers,
    options,
    onChunk,
    model: agent.modelId ?? COPILOT_VERIFY_MODEL,
    // Copilot is a strict OpenAI-style backend: flatten top-level schema
    // combinators (apply_patch's anyOf), reject dots in function names (verified
    // live — a dotted tool name 400s here too), and map the token cap to the
    // field the pinned model accepts (gpt-5.x → max_completion_tokens).
    strictToolSchemas: true,
    toolNameGrammar: NO_DOTS_TOOL_NAME_GRAMMAR,
    maxTokensField: copilotMaxTokensField(agent.modelId),
    errorTransform: (message, body) => handleCopilotChatError(agent, String(body.model), message),
  });
}

export async function verifyCopilot(
  secret: string,
  options?: ProviderVerifyOptions
): Promise<ProviderVerifyResult> {
  // Both auth types use the GitHub token → exchange it for a Copilot subscription
  // token. If the exchange succeeds, the credential is valid.
  try {
    await exchangeGitHubToken(secret, options?.credentialId);
    return { valid: true, message: 'Connected successfully — Copilot subscription active' };
  } catch (error) {
    return {
      valid: false,
      message: getErrorMessage(error, 'GitHub token exchange failed'),
    };
  }
}
