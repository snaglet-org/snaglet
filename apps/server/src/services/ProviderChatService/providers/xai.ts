/**
 * xAI (Grok) — OpenAI-compatible Chat Completions; see makeOpenAICompatibleProvider.
 *
 * xAI's API is a vanilla OpenAI-compatible surface hosted at `api.x.ai/v1`, so
 * the baked-in base URL already carries the `/v1` suffix (`normalizeOpenAIBaseUrl`
 * leaves it untouched) and `/chat/completions` + `/models` resolve directly. A
 * `providers.base_url` row on the `xai` provider overrides this per install.
 *
 * Grok models speak vanilla OpenAI tool-calling, so the shared tool-name
 * sanitizer in `chat-completions.ts` applies unchanged. Live model discovery is
 * handled by the ProviderModelDiscoveryService xAI normalizer, which reads the
 * richer `/v1/language-models` catalog for per-model input modalities.
 *
 * `strictToolSchemas: true`: xAI rejects the entire chat request (400, "tool
 * parameter root must be an object type") when any tool has a union-rooted
 * schema, such as `apply_patch`'s
 * `anyOf: [{required:['patch']}, {required:['input']}]`. Flattening collapses
 * the combinator into a plain object schema before it is sent.
 */
import { makeOpenAICompatibleProvider } from './openaiCompatible';

const XAI_FALLBACK_BASE_URL = 'https://api.x.ai/v1';

const xai = makeOpenAICompatibleProvider('xai', XAI_FALLBACK_BASE_URL, {
  strictToolSchemas: true,
});

export const resolveXaiBaseUrl = xai.resolveBaseUrl;
export const chatXai = xai.chat;
export const verifyXai = xai.verify;
