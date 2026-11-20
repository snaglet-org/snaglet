import { getErrorMessage } from '@snaglet/shared/utils';
import type { SnagletAgent } from '../AgentService';
import { PROVIDER_REGISTRY } from './providers/registry';
import { enrichVerifyFailureMessage } from './keyPrefixHint';
import { normalizeProviderId } from './shared';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyOptions,
  ProviderVerifyResult,
} from './types';

/** "Could not reach the provider (ECONNREFUSED)…" from a network error and its cause. */
function unreachableMessage(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const detail =
    typeof cause?.code === 'string'
      ? cause.code
      : typeof cause?.message === 'string'
        ? cause.message
        : getErrorMessage(err);
  return `Could not reach the provider (${detail}). Check your connection and the provider's address, then test again.`;
}

export const providerChatService = {
  async complete(
    agent: SnagletAgent,
    messages: ProviderMessage[],
    onChunk?: OnChunkCallback,
    options?: ProviderChatOptions
  ): Promise<ProviderChatResult> {
    const provider = normalizeProviderId(agent.provider);
    const chat = PROVIDER_REGISTRY[provider]?.chat;
    if (!chat) {
      throw new Error(`Unsupported provider '${agent.provider}' for chat`);
    }
    return chat(agent, messages, onChunk, options);
  },

  async verify(
    providerId: string,
    secret: string,
    options?: ProviderVerifyOptions
  ): Promise<ProviderVerifyResult> {
    const provider = normalizeProviderId(providerId);
    const entry = PROVIDER_REGISTRY[provider];
    if (!entry) {
      return { valid: false, message: `Verification not supported for provider '${providerId}'` };
    }
    let result: ProviderVerifyResult;
    try {
      result = await entry.verify(secret, options);
    } catch (err) {
      // A provider that cannot be reached (offline, wrong address, server not
      // running) is a failed test with a reason, not a server error.
      result = { valid: false, message: unreachableMessage(err) };
    }
    // On failure, if the key's prefix belongs to a different known provider,
    // point the user at the right card.
    if (!result.valid) {
      return { ...result, message: enrichVerifyFailureMessage(provider, secret, result.message) };
    }
    return result;
  },
};

export type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyOptions,
  ProviderVerifyResult,
  SystemContentBlock,
  TextContentBlock,
  TextMessage,
  UserContentBlock,
} from './types';
