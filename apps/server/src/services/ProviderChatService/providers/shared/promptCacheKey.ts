import { createHash } from 'node:crypto';

/**
 * OpenAI's `prompt_cache_key`. OpenAI routes a request to a cache machine by
 * a hash of the prompt's first tokens combined with this key, so requests
 * that share a prefix and a key land where that prefix is already cached.
 * Without a key every Snaglet agent's request starts with the same core tools and
 * hashes to the same machine, which overflows (OpenAI's prompt-caching guide
 * puts it at about 15 requests a minute per prefix and key) and spreads
 * requests to machines with a cold cache.
 *
 * The key is per agent, not per thread: the stable prefix (tools, then the
 * system prompt) is the agent's, and each of its threads extends that prefix,
 * so one machine serves the agent's every thread from one warm cache. A
 * per-thread key would warm the agent's tools prefix again in every thread.
 *
 * Hashed so the key has a fixed length and carries no agent name.
 *
 * Send it only to OpenAI itself (`isOfficialOpenAIUrl`) and the Codex
 * backend: OpenAI-compatible servers (LM Studio, Ollama, Together, …) may
 * refuse a field they do not know.
 */
export function openAIPromptCacheKey(agentId: string): string {
  return `snaglet-${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`;
}

/** True when `url` is OpenAI's own API (api.openai.com), not a compatible server. */
export function isOfficialOpenAIUrl(url: string): boolean {
  return /^https:\/\/api\.openai\.com(?:[/:?#]|$)/i.test(url);
}
