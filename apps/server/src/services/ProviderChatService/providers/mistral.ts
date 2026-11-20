/** Mistral AI — OpenAI-compatible; see makeOpenAICompatibleProvider. */
import { makeOpenAICompatibleProvider } from './openaiCompatible';

const MISTRAL_FALLBACK_BASE_URL = 'https://api.mistral.ai/v1';

const mistral = makeOpenAICompatibleProvider('mistral', MISTRAL_FALLBACK_BASE_URL);

export const chatMistral = mistral.chat;
export const verifyMistral = mistral.verify;
