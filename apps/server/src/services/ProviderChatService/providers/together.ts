/** Together AI — OpenAI-compatible; see makeOpenAICompatibleProvider. */
import { safeJsonParse } from '@snaglet/shared/utils';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import type { ModelProbeResult } from '@server/services/ProviderModelDiscoveryService/reconcile';
import { makeOpenAICompatibleProvider } from './openaiCompatible';

const TOGETHER_FALLBACK_BASE_URL = 'https://api.together.xyz/v1';

const together = makeOpenAICompatibleProvider('together', TOGETHER_FALLBACK_BASE_URL);

export const resolveTogetherBaseUrl = together.resolveBaseUrl;
export const chatTogether = together.chat;
export const verifyTogether = together.verify;

/**
 * Entitlement probe: send a minimal 1-token request for `modelId` on the live
 * Together credential and report whether it can actually be run serverless.
 *
 * Together's `/v1/models` catalog lists many models that are not available on
 * shared serverless infra; calling them returns HTTP 400 with
 * `code: "model_not_available"` and the message "Unable to access non-serverless
 * model … create and start a new dedicated endpoint for the model". Together's
 * model listing carries no per-model serverless flag (only a `dedicated` query
 * param that filters the LIST), so this live probe is the reliable signal. The
 * upstream message becomes the pruned row's stored reason.
 */
export async function probeTogetherModel(
  modelId: string,
  options?: { signal?: AbortSignal }
): Promise<ModelProbeResult> {
  const secret = await providerCredentialService.getSecret('together');
  if (!secret) return { ok: false, reason: 'No Together AI credential configured' };

  const baseUrl = await resolveTogetherBaseUrl();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    }),
    signal: options?.signal,
  });

  if (res.ok) {
    // eslint-disable-next-line no-restricted-syntax -- intentional: best-effort teardown of an unread response body; nothing to do on failure
    await res.body?.cancel().catch(() => undefined);
    return { ok: true };
  }
  const body = await res.text().catch(() => '');
  const transient = res.status === 429 || res.status >= 500;
  return { ok: false, transient, reason: extractTogetherErrorReason(body, res.status) };
}

function extractTogetherErrorReason(body: string, status: number): string {
  const data = safeJsonParse<Record<string, unknown>>(body, {}) ?? {};
  const err = data.error as { message?: string } | undefined;
  const message =
    (typeof err?.message === 'string' && err.message) ||
    (typeof data.message === 'string' && data.message) ||
    body.slice(0, 300);
  return message || `HTTP ${status}`;
}
