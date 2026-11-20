import type { SnagletAgent } from '@server/services/AgentService';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { Models } from '@snaglet/db/tables/models';
import { logger } from '@server/config/logger';
import { chatOpenAI } from './openai';
import { readCodexCliAuth } from './codexCliAuth';
import { callResponsesEndpoint, extractResponsesErrorReason } from './shared/responses-api';
import { openAIPromptCacheKey } from './shared/promptCacheKey';
import type { ModelProbeResult } from '@server/services/ProviderModelDiscoveryService/reconcile';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyOptions,
  ProviderVerifyResult,
} from '../types';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_JWT_CLAIM = 'https://api.openai.com/auth';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_DEFAULT_INSTRUCTIONS = 'You are a concise assistant.';

function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('invalid jwt');
    const payload = safeJsonParse<Record<string, unknown>>(
      Buffer.from(parts[1], 'base64').toString('utf8'),
      {}
    );
    const auth = payload[CODEX_JWT_CLAIM] as Record<string, unknown> | undefined;
    return String(auth?.chatgpt_account_id ?? '');
  } catch {
    return '';
  }
}

function readCodexExpiresMs(metadata: Record<string, unknown>): number {
  const raw = metadata.expires_ms ?? metadata.expires ?? metadata.expiresAt ?? metadata.expires_at;
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

interface CodexAuthResolutionInput {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  expiresMs?: number;
  credentialId?: string;
}

/**
 * Adopt a refresh token from the Codex CLI's `~/.codex/auth.json` for the same
 * ChatGPT account and persist it into the (encrypted) Snaglet credential. Called when
 * the stored credential has no refresh token, or when a stored refresh token
 * fails — either way the access token would otherwise expire with no recovery.
 */
async function importCodexRefreshFromCli(args: {
  credentialId?: string;
  accountId: string;
  currentAccessToken: string;
}): Promise<{ refreshToken: string; accessToken: string; accountId: string } | null> {
  const cli = await readCodexCliAuth();
  if (!cli?.refreshToken) return null;

  // Same-account guard: never graft a different account's refresh token on.
  if (args.accountId && cli.accountId && args.accountId !== cli.accountId) {
    logger.warn('Skipped Codex CLI refresh-token import — account mismatch', {
      credentialAccountId: args.accountId,
      cliAccountId: cli.accountId,
    });
    return null;
  }

  const accessToken = cli.accessToken || args.currentAccessToken;
  const accountId = args.accountId || cli.accountId || extractCodexAccountId(accessToken);

  if (args.credentialId) {
    try {
      // refresh_token is peeled into the encrypted bundle; account_id merges into
      // metadata. `expires` is left for the immediate refresh below to set.
      await providerCredentialService.updateSecret(args.credentialId, accessToken, {
        refresh_token: cli.refreshToken,
        ...(accountId ? { account_id: accountId } : {}),
      });
      logger.info('Imported Codex refresh token from ~/.codex/auth.json', {
        credentialId: args.credentialId,
        accountId,
      });
    } catch (err) {
      logger.warn('Failed to persist imported Codex refresh token', { err });
    }
  }

  return { refreshToken: cli.refreshToken, accessToken, accountId };
}

/** Exchange a refresh token for a fresh access token; persists on success. */
async function refreshCodexAccessToken(
  refreshToken: string,
  credentialId?: string
): Promise<{ accessToken: string; expiresMs: number } | null> {
  try {
    const res = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = String(data.access_token ?? '');
    if (!accessToken) return null;

    const expiresMs = Date.now() + Number(data.expires_in ?? 863999) * 1000;
    if (credentialId) {
      const patch: Record<string, unknown> = { expires: expiresMs };
      const nextRefreshToken = String(data.refresh_token ?? '');
      if (nextRefreshToken) patch['refresh_token'] = nextRefreshToken;
      providerCredentialService.updateSecret(credentialId, accessToken, patch).catch((err) => {
        logger.warn(`[codex] failed to persist refreshed token: ${getErrorMessage(err)}`);
      });
    }
    return { accessToken, expiresMs };
  } catch {
    return null;
  }
}

async function resolveCodexAccessToken(
  input: CodexAuthResolutionInput
): Promise<{ accessToken: string; accountId: string }> {
  let accessToken = input.accessToken;
  let refreshToken = input.refreshToken ?? '';
  const expiresMs = input.expiresMs ?? 0;
  let justImported = false;

  // No stored refresh token → adopt the Codex CLI's (same account) so the
  // credential can refresh itself instead of dying when its access token
  // expires. This defuses the "no refresh_token" time bomb.
  if (!refreshToken) {
    const accountId = input.accountId || extractCodexAccountId(accessToken);
    const imported = await importCodexRefreshFromCli({
      credentialId: input.credentialId,
      accountId,
      currentAccessToken: accessToken,
    });
    if (imported) {
      refreshToken = imported.refreshToken;
      accessToken = imported.accessToken || accessToken;
      justImported = true;
    }
  }

  // Refresh when (near-)expired, or right after a first-time import so the
  // adopted token is validated and a real expiry gets persisted now.
  const needsRefresh =
    !!refreshToken && (justImported || !expiresMs || Date.now() >= expiresMs - 60_000);
  if (needsRefresh) {
    let refreshed = await refreshCodexAccessToken(refreshToken, input.credentialId);

    // A stale stored refresh token can still fail — fall back to the CLI's.
    if (!refreshed && !justImported) {
      const accountId = input.accountId || extractCodexAccountId(accessToken);
      const imported = await importCodexRefreshFromCli({
        credentialId: input.credentialId,
        accountId,
        currentAccessToken: accessToken,
      });
      if (imported) {
        refreshToken = imported.refreshToken;
        accessToken = imported.accessToken || accessToken;
        refreshed = await refreshCodexAccessToken(refreshToken, input.credentialId);
      }
    }

    if (refreshed) accessToken = refreshed.accessToken;
  }

  const accountId = input.accountId || extractCodexAccountId(accessToken);
  return { accessToken, accountId };
}

//
// ChatGPT-backed Codex rejects models that aren't entitled for a ChatGPT
// account with: "The requested model `X` is not supported when using Codex with
// a ChatGPT account." Without deactivation those models error-loop forever, so
// mirror the copilot handler: auto-deactivate the models row + surface a clear
// "removed from the picker" message.
//
const CODEX_UNSUPPORTED_MODEL_RE = /not supported when using codex with a chatgpt account/i;

async function handleCodexChatError(
  agent: SnagletAgent,
  requestedModelId: string,
  message: string
): Promise<string> {
  if (!CODEX_UNSUPPORTED_MODEL_RE.test(message)) return message;

  Models.findByProviderAndModelId('codex', requestedModelId)
    .then((row) => (row ? Models.deactivate(row.id) : null))
    .then((deactivated) => {
      if (deactivated) {
        logger.warn('Codex model auto-deactivated after rejection', {
          agentId: agent.id,
          agentName: agent.name,
          modelId: requestedModelId,
          reason: 'chatgpt-account-unsupported',
        });
      }
    })
    .catch((err) =>
      logger.warn('Codex auto-deactivate failed', { err, modelId: requestedModelId })
    );

  return `\`${requestedModelId}\` isn't supported on your ChatGPT Codex plan, so it has been removed from the picker. Re-pin this agent to a supported model (e.g. gpt-5.4, gpt-5.4-mini, gpt-5.5).`;
}

function buildCodexHeaders(accessToken: string, accountId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    Authorization: `Bearer ${accessToken}`,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'pi',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

export async function chatCodex(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const credRow = agent.credentialId
    ? await providerCredentialService.getFullCredentialById(agent.credentialId)
    : null;

  const isOAuth = credRow?.authType === 'oauth';

  if (!isOAuth) {
    return chatOpenAI(agent, messages, onChunk, options);
  }

  const accessToken = credRow.encryptedSecret;
  if (!accessToken) {
    throw new Error('Missing Codex OAuth access token. Reconnect your Codex credential.');
  }

  const meta = (credRow.metadataJson ?? {}) as Record<string, unknown>;
  const resolved = await resolveCodexAccessToken({
    accessToken,
    refreshToken: String(meta.refresh_token ?? meta.refreshToken ?? ''),
    accountId: String(meta.account_id ?? meta.accountId ?? ''),
    expiresMs: readCodexExpiresMs(meta),
    credentialId: credRow.id,
  });

  return callResponsesEndpoint({
    url: `${CODEX_BASE_URL}/codex/responses`,
    headers: buildCodexHeaders(resolved.accessToken, resolved.accountId),
    agent,
    messages,
    options,
    onChunk,
    providerLabel: 'codex',
    instructions: agent.systemPrompt || CODEX_DEFAULT_INSTRUCTIONS,
    errorTransform: (msg) => handleCodexChatError(agent, agent.modelId ?? '', msg),
    // The Codex CLI sends prompt_cache_key to this backend too.
    promptCacheKey: openAIPromptCacheKey(agent.id),
  });
}

/**
 * Entitlement probe: send a minimal 1-token Responses request for `modelId` on
 * the live ChatGPT-account Codex credential and report whether it's allowed. A
 * 2xx means entitled; a 4xx carries the "not supported when using Codex with a
 * ChatGPT account" (or other) rejection reason. API-key credentials aren't
 * entitlement-gated the same way, so they pass through as `ok`.
 */
export async function probeCodexModel(
  modelId: string,
  options?: { signal?: AbortSignal }
): Promise<ModelProbeResult> {
  const credentialId = await providerCredentialService.resolveCredentialIdForModel({
    providerId: 'codex',
    modelId,
  });
  const credRow = credentialId
    ? await providerCredentialService.getFullCredentialById(credentialId)
    : null;

  if (!credRow?.encryptedSecret) return { ok: false, reason: 'No Codex credential configured' };
  // API-key Codex hits api.openai.com and isn't ChatGPT-account entitlement
  // gated — nothing cheap to probe, so treat as allowed.
  if (credRow.authType !== 'oauth') return { ok: true };

  const meta = (credRow.metadataJson ?? {}) as Record<string, unknown>;
  const resolved = await resolveCodexAccessToken({
    accessToken: credRow.encryptedSecret,
    refreshToken: String(meta.refresh_token ?? meta.refreshToken ?? ''),
    accountId: String(meta.account_id ?? meta.accountId ?? ''),
    expiresMs: readCodexExpiresMs(meta),
    credentialId: credRow.id,
  });

  const res = await fetch(`${CODEX_BASE_URL}/codex/responses`, {
    method: 'POST',
    headers: buildCodexHeaders(resolved.accessToken, resolved.accountId),
    body: JSON.stringify({
      model: modelId,
      store: false,
      stream: true,
      instructions: CODEX_DEFAULT_INSTRUCTIONS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      text: { verbosity: 'medium' },
    }),
    signal: options?.signal,
  });

  if (res.ok) {
    // eslint-disable-next-line no-restricted-syntax -- intentional: best-effort teardown of an unread response body; nothing to do on failure
    await res.body?.cancel().catch(() => undefined);
    return { ok: true };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 429 || res.status >= 500)
    return {
      ok: false,
      transient: true,
      reason: extractResponsesErrorReason(text) || `HTTP ${res.status}`,
    };
  return { ok: false, reason: extractResponsesErrorReason(text) || `HTTP ${res.status}` };
}

export async function verifyCodexOAuth(
  secret: string,
  options?: ProviderVerifyOptions
): Promise<ProviderVerifyResult> {
  const metadata = options?.metadata ?? {};
  const accountId =
    String(metadata.account_id ?? metadata.accountId ?? '') || extractCodexAccountId(secret);
  // The Codex CLI's account-usage endpoint authenticates without inference or
  // model entitlements. Test exactly the supplied access token: adopting the
  // local CLI login can hide bad input, and refreshing a draft can rotate a
  // refresh token that the caller has not saved. Chat retains its refresh flow.
  let res: Response;
  try {
    res = await fetch(`${CODEX_BASE_URL}/wham/usage`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/json',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    return {
      valid: false,
      message:
        'Could not reach Codex to test this credential. You can still save it and try Test again later.',
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message =
      res.status === 401 || res.status === 403
        ? `Codex access token was rejected (${res.status}). It may be invalid or expired.`
        : `Could not verify the Codex account (${res.status}). Try again later.`;
    const parsed = safeJsonParse<Record<string, unknown>>(text, {}) ?? {};
    message =
      String(
        parsed.detail ?? (parsed.error as { message?: string } | undefined)?.message ?? message
      ) || message;
    return { valid: false, message };
  }

  try {
    const usage: unknown = await res.json();
    if (
      usage &&
      typeof usage === 'object' &&
      'plan_type' in usage &&
      typeof usage.plan_type === 'string'
    ) {
      return {
        valid: true,
        message: 'Codex account authenticated successfully. No model request was made.',
      };
    }
  } catch {
    // A login page or malformed response is not proof of authentication.
  }
  return {
    valid: false,
    message: 'Codex returned an unexpected account response. Try Test again later.',
  };
}
