/**
 * DeepSeek — OpenAI-compatible Chat Completions; see makeOpenAICompatibleProvider.
 *
 * DeepSeek's API is a vanilla OpenAI-compatible surface. The `/v1` segment is a
 * path prefix, not a model version (DeepSeek accepts both `api.deepseek.com` and
 * `api.deepseek.com/v1`); we bake in the `/v1` form so `normalizeOpenAIBaseUrl`
 * is a no-op and `/chat/completions` + `/models` resolve directly. A
 * `providers.base_url` row on the `deepseek` provider overrides this per install
 * (e.g. a regional proxy).
 */
import { makeOpenAICompatibleProvider } from './openaiCompatible';

const DEEPSEEK_FALLBACK_BASE_URL = 'https://api.deepseek.com/v1';

const deepseek = makeOpenAICompatibleProvider('deepseek', DEEPSEEK_FALLBACK_BASE_URL);

export const resolveDeepseekBaseUrl = deepseek.resolveBaseUrl;
export const chatDeepseek = deepseek.chat;
export const verifyDeepseek = deepseek.verify;
