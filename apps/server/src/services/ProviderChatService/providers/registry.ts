/**
 * Provider registry — ONE declaration per provider.
 *
 * Without this registry, adding a provider means touching many hand-synced
 * lists (chat dispatch, verify dispatch, env fallbacks, "known id" sets,
 * discovery normalizers, the seed migration, the icon switch, the context
 * safety-margin map) — and hand-synced lists drift (a provider that verifies
 * green but cannot chat, or ships with no adapter). This registry is the
 * single source for the runtime capabilities; `complete()`, `verify()` and
 * `pickSecret()` all read it.
 *
 * A provider is chat-capable iff its entry has `chat`. Verify-only entries
 * (google-workspace, github) exist for integration credentials that are
 * never used as an agent's chat model.
 *
 * Still declared elsewhere (not runtime dispatch): the DB seed row
 * (packages/db/migrations/seeds/provider-catalog.sql — what the UI offers),
 * the discovery normalizer (ProviderModelDiscoveryService), and the UI icon
 * (ProviderIcon.tsx).
 */
import { verifyGoogleWorkspace } from '@server/integrations/google/googleWorkspace';
import { verifyGitHub } from '@server/integrations/github/verifyGitHub';
import type { SnagletAgent } from '../../AgentService';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyOptions,
  ProviderVerifyResult,
} from '../types';
import { chatAnthropic, verifyAnthropic } from './anthropic';
import { chatAppleOnDevice, verifyAppleOnDevice } from './apple-on-device';
import { chatCodex, verifyCodexOAuth } from './codex';
import { chatCopilot, verifyCopilot } from './copilot';
import { chatDeepseek, verifyDeepseek } from './deepseek';
import { chatGemini, verifyGemini } from './gemini';
import { chatLmStudio, verifyLmStudio } from './lm-studio';
import { chatMistral, verifyMistral } from './mistral';
import { chatOllama, verifyOllama } from './ollama';
import { chatOpenAI, verifyOpenAI } from './openai';
import { chatScripted, scriptedProviderEnabled } from './scripted';
import { chatTogether, verifyTogether } from './together';
import { chatXai, verifyXai } from './xai';

type ProviderChatFn = (
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
) => Promise<ProviderChatResult>;

type ProviderVerifyFn = (
  secret: string,
  options?: ProviderVerifyOptions
) => Promise<ProviderVerifyResult>;

export interface ProviderRegistryEntry {
  /** Present iff the provider can back an agent's chat model. */
  readonly chat?: ProviderChatFn;
  readonly verify: ProviderVerifyFn;
  /**
   * Env vars consulted (in order) by `pickSecret` when no DB credential
   * exists — local/dev bootstrap only. Anthropic deliberately has none:
   * its credentials come exclusively from the DB credential store.
   */
  readonly envSecretVars?: readonly string[];
}

export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderRegistryEntry>> = {
  anthropic: {
    chat: chatAnthropic,
    verify: (secret) => verifyAnthropic(secret),
  },
  openai: {
    chat: chatOpenAI,
    verify: (secret) => verifyOpenAI(secret, 'openai'),
    envSecretVars: ['OPENAI_API_KEY'],
  },
  together: {
    chat: chatTogether,
    verify: (secret) => verifyTogether(secret),
  },
  'lm-studio': {
    chat: chatLmStudio,
    verify: (secret) => verifyLmStudio(secret),
  },
  codex: {
    chat: chatCodex,
    verify: (secret, options) =>
      options?.authType === 'oauth' ? verifyCodexOAuth(secret, options) : verifyOpenAI(secret),
    envSecretVars: ['OPENAI_API_KEY'],
  },
  copilot: {
    chat: chatCopilot,
    verify: (secret, options) => verifyCopilot(secret, options),
    envSecretVars: ['GITHUB_COPILOT_TOKEN'],
  },
  google: {
    chat: chatGemini,
    verify: (secret) => verifyGemini(secret),
    envSecretVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  mistral: {
    chat: chatMistral,
    verify: (secret) => verifyMistral(secret),
    envSecretVars: ['MISTRAL_API_KEY'],
  },
  // DeepSeek — OpenAI-compatible hosted API routed through the shared
  // openaiCompatible chat path. Env var names follow the
  // `<PROVIDER>_API_KEY` convention (OPENAI_API_KEY, MISTRAL_API_KEY, …), not
  // a `SNAGLET_`-prefixed form, which no provider uses.
  deepseek: {
    chat: chatDeepseek,
    verify: (secret) => verifyDeepseek(secret),
    envSecretVars: ['DEEPSEEK_API_KEY'],
  },
  // xAI (Grok) — OpenAI-compatible hosted API routed through the shared
  // openaiCompatible chat path. Env var follows the `<PROVIDER>_API_KEY`
  // convention (not a `SNAGLET_`-prefixed form).
  xai: {
    chat: chatXai,
    verify: (secret) => verifyXai(secret),
    envSecretVars: ['XAI_API_KEY'],
  },
  ollama: {
    chat: chatOllama,
    verify: (secret) => verifyOllama(secret),
  },
  // Apple's on-device FoundationModels LLM, via the snaglet-apple-chat Swift
  // sidecar (see providers/apple-on-device.ts). Keyless like ollama — no
  // envSecretVars either, since there's nothing to authenticate.
  'apple-on-device': {
    chat: chatAppleOnDevice,
    verify: (secret) => verifyAppleOnDevice(secret),
  },
  // Integration credentials — verify-only, never a chat model.
  'google-workspace': {
    verify: (secret, options) => verifyGoogleWorkspace(secret, options),
  },
  github: {
    verify: (secret) => verifyGitHub(secret),
  },
  // Deterministic scripted "model" for dispatch-loop scenario tests and
  // scratch-server demos. Registered only under NODE_ENV=test or
  // SNAGLET_ENABLE_SCRIPTED_PROVIDER=1 (see providers/scripted.ts); a production
  // registry never contains it.
  ...(scriptedProviderEnabled()
    ? {
        scripted: {
          chat: chatScripted,
          verify: async () => ({ valid: true, message: 'scripted test provider' }),
        },
      }
    : {}),
};
