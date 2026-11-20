import {
  exchangeGitHubToken,
  extractBaseUrl,
  COPILOT_FALLBACK_BASE_URL,
} from '@server/services/ProviderChatService/providers/copilot';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { Providers } from '@snaglet/db/tables/providers';
import { logger } from '@server/config/logger';
import type { DiscoveredModel } from '../types';

interface CopilotModelCapabilities {
  family?: string;
  limits?: {
    max_context_window_tokens?: number;
    max_output_tokens?: number;
    max_prompt_tokens?: number;
  };
  supports?: {
    streaming?: boolean;
    tool_calls?: boolean;
    vision?: boolean;
    structured_outputs?: boolean;
  };
  type?: string;
}

/**
 * Per-model gate carried by newer Copilot `/models` payloads. `state` is a
 * short enum — `"enabled"` means the account/org has this model turned on;
 * anything else (`"unconfigured"`, `"disabled"`, …) means it needs enabling
 * (org policy or a terms acceptance) and it will reject at chat time. This is
 * the closest thing the listing carries to an entitlement signal — there is no
 * per-model *plan* field; true plan entitlement is only enforced at chat time.
 * Optional: absent on older payloads and on most freely-available models.
 */
interface CopilotModelPolicy {
  state?: string;
  terms?: string;
}

interface CopilotModelEntry {
  id: string;
  name?: string;
  vendor?: string;
  version?: string;
  capabilities?: CopilotModelCapabilities;
  model_picker_enabled?: boolean;
  object?: string;
  preview?: boolean;
  policy?: CopilotModelPolicy;
  /** Endpoints this model accepts (e.g. ['/chat/completions','/responses']). Newer payloads only. */
  supported_endpoints?: string[];
}

interface CopilotModelsResponse {
  data?: CopilotModelEntry[];
}

/**
 * A model whose `policy.state` is present and not `"enabled"` is gated: it will
 * reject at chat time until enabled. We surface it as `plan_blocked` at
 * discovery so the picker can badge it proactively, while staying defensive —
 * a missing `policy` (the common case) yields no hint and is treated as
 * available.
 */
function policyEntitlementHint(
  entry: CopilotModelEntry,
  nowIso: string
): DiscoveredModel['entitlement'] {
  const state = entry.policy?.state;
  if (!state || state.toLowerCase() === 'enabled') return undefined;
  const terms = entry.policy?.terms?.trim();
  return {
    status: 'plan_blocked',
    reason: terms
      ? `Copilot model policy is "${state}": ${terms}`
      : `Copilot model policy is "${state}" (not enabled for this account).`,
    checkedAt: nowIso,
    source: 'discovery',
  };
}

/**
 * Resolve the Copilot API base URL + subscription token from the primary
 * credential, then call GET /models and normalize the response.
 */
export async function discoverCopilotModels(): Promise<DiscoveredModel[]> {
  const provider = await Providers.findProvider('copilot');
  const credentialId = provider?.primaryCredentialId;
  if (!credentialId) {
    throw new Error('No primary credential set for Copilot');
  }

  const cred = await providerCredentialService.getFullCredentialById(credentialId);
  if (!cred?.encryptedSecret) {
    throw new Error('Copilot credential has no secret stored');
  }

  let token: string;
  let baseUrl: string;

  if (cred.authType === 'oauth') {
    // gho_* GitHub token → short-lived Copilot subscription token
    const exchanged = await exchangeGitHubToken(cred.encryptedSecret, cred.id);
    token = exchanged.token;
    baseUrl = exchanged.baseUrl;
  } else {
    token = cred.encryptedSecret;
    baseUrl = extractBaseUrl(token) || COPILOT_FALLBACK_BASE_URL;
  }

  const res = await fetch(`${baseUrl}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Copilot-Integration-Id': 'vscode-chat',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Copilot /models call failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as CopilotModelsResponse;

  // Live-payload capture: Copilot's per-model entitlement shape is
  // undocumented and evolving, and this machine may have no Copilot credential.
  // Set SNAGLET_DEBUG_COPILOT_RAW=1 to log the full raw /models JSON on a discovery
  // refresh so a real payload can be captured on an account that has one.
  if (process.env.SNAGLET_DEBUG_COPILOT_RAW === '1') {
    logger.info('[copilot-raw] /models payload', { raw: JSON.stringify(json) });
  }

  const entries = Array.isArray(json.data) ? json.data : [];
  return normalizeCopilotModels(entries);
}

/**
 * Pure filter + map for a raw Copilot `/models` `data[]` array. Keeps the
 * picker-enabled, chat-capable entries and attaches a discovery-time
 * entitlement hint from `policy.state`. Split out from the IO so it is unit-
 * testable with fixture payloads (no credential, no network).
 */
export function normalizeCopilotModels(entries: CopilotModelEntry[]): DiscoveredModel[] {
  const nowIso = new Date().toISOString();
  return entries
    .filter((m) => m.model_picker_enabled !== false)
    .filter((m) => m.capabilities?.type === 'chat' || m.capabilities?.type === undefined)
    .map((entry) => normalize(entry, nowIso));
}

function normalize(entry: CopilotModelEntry, nowIso: string): DiscoveredModel {
  const caps = entry.capabilities ?? {};
  const limits = caps.limits ?? {};
  const supports = caps.supports ?? {};
  const entitlement = policyEntitlementHint(entry, nowIso);

  return {
    modelId: entry.id,
    displayName: entry.name || entry.id,
    family: caps.family ?? null,
    contextWindowTokens: limits.max_context_window_tokens ?? null,
    maxOutputTokens: limits.max_output_tokens ?? null,
    supportsTools: Boolean(supports.tool_calls),
    supportsVision: Boolean(supports.vision),
    supportsReasoning: undefined,
    isPreview: Boolean(entry.preview),
    ...(entitlement ? { entitlement } : {}),
    alreadyImported: false,
  };
}
