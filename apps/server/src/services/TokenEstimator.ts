/**
 * Per-provider token estimation.
 *
 * Strategy split:
 *   - OpenAI-family providers (openai, codex, and copilot's gpt-* models) use
 *     js-tiktoken for exact BPE counts — the same tokenizer the provider
 *     bills with. Encoding picked per model family (o200k vs cl100k).
 *   - Everyone else uses a chars-per-token heuristic. Anthropic stays on a
 *     tuned 3.5 ratio: the Claude 3+ tokenizer was never published, and the
 *     official count_tokens endpoint is an async HTTP call that can't sit in
 *     this sync hot path. ~15-20% margin, acceptable because compaction
 *     triggers at 60% of usable budget and the per-provider safety margin
 *     (resolveContextBudget) shaves the declared window further.
 *
 * Tiktoken instances are built lazily and cached — constructing one parses a
 * multi-MB rank table, so it must happen at most once per encoding.
 */

import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import type { ProviderMessage } from './ProviderChatService';

interface TokenStrategy {
  countText(text: string): number;
}

class CharRatioStrategy implements TokenStrategy {
  constructor(private readonly charsPerToken: number) {}
  countText(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }
}

type TiktokenEncoding = 'o200k_base' | 'cl100k_base';

const tiktokenCache = new Map<TiktokenEncoding, Tiktoken>();

function getTiktoken(encoding: TiktokenEncoding): Tiktoken {
  let enc = tiktokenCache.get(encoding);
  if (!enc) {
    enc = new Tiktoken(encoding === 'o200k_base' ? o200k_base : cl100k_base);
    tiktokenCache.set(encoding, enc);
  }
  return enc;
}

class TiktokenStrategy implements TokenStrategy {
  constructor(private readonly encoding: TiktokenEncoding) {}
  countText(text: string): number {
    if (!text) return 0;
    return getTiktoken(this.encoding).encode(text).length;
  }
}

const CHARS_PER_TOKEN: Record<string, number> = {
  anthropic: 3.5,
  gemini: 4.0,
  // FoundationModels' tokenizer is undocumented; use the same conservative
  // ratio as anthropic (fewer chars/token → higher estimate) so a 4096-token
  // hard ceiling (see ContextWindowService's PROVIDER_SAFETY_MARGIN_PCT
  // comment) is never underestimated into an over-budget prompt.
  'apple-on-device': 3.5,
};

const DEFAULT_CHARS_PER_TOKEN = 4.0;

/** Per-message overhead: role tokens, structural formatting, delimiters. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Models on cl100k_base (the GPT-4 / GPT-3.5 era). Everything newer is o200k. */
const CL100K_MODEL_RE = /^(gpt-4(?!o|\.[1-9])|gpt-3\.5|text-embedding-ada)/;

function tiktokenEncodingFor(modelId: string | undefined): TiktokenEncoding {
  if (modelId && CL100K_MODEL_RE.test(modelId)) return 'cl100k_base';
  return 'o200k_base';
}

/** Providers whose chat models are all OpenAI-tokenized. */
const OPENAI_FAMILY_PROVIDERS = new Set(['openai', 'codex']);

/** copilot serves a mixed catalog (claude-*, gpt-*, gemini-*) — pick by model id. */
function isOpenAiTokenized(provider: string, modelId: string | undefined): boolean {
  if (OPENAI_FAMILY_PROVIDERS.has(provider)) return true;
  if (provider === 'copilot' && modelId) {
    return /^(gpt-|o[134]|codex)/.test(modelId);
  }
  return false;
}

const strategyCache = new Map<string, TokenStrategy>();

function strategyFor(provider: string, modelId?: string): TokenStrategy {
  const key = `${provider}/${modelId ?? ''}`;
  let strategy = strategyCache.get(key);
  if (!strategy) {
    strategy = isOpenAiTokenized(provider, modelId)
      ? new TiktokenStrategy(tiktokenEncodingFor(modelId))
      : new CharRatioStrategy(CHARS_PER_TOKEN[provider] ?? DEFAULT_CHARS_PER_TOKEN);
    strategyCache.set(key, strategy);
  }
  return strategy;
}

/** Estimate tokens for a raw string. */
export function estimateTokens(text: string, provider: string, modelId?: string): number {
  if (!text) return 0;
  return strategyFor(provider, modelId).countText(text);
}

/** Estimate tokens for a single ProviderMessage. */
export function estimateMessageTokens(
  message: ProviderMessage,
  provider: string,
  modelId?: string
): number {
  const strategy = strategyFor(provider, modelId);
  let textTokens = 0;
  let imageTokens = 0;

  if (typeof message.content === 'string') {
    // TextMessage
    textTokens = strategy.countText(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if ('text' in block && block.type === 'text') {
        textTokens += strategy.countText(block.text);
      } else if ('type' in block && block.type === 'tool_use') {
        // tool name + serialized input
        textTokens +=
          strategy.countText(block.name) + strategy.countText(JSON.stringify(block.input));
      } else if ('type' in block && block.type === 'tool_result') {
        // ToolResultContent is a string or a block array (text + images).
        if (typeof block.content === 'string') {
          textTokens += strategy.countText(block.content);
        } else if (Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner.type === 'text') textTokens += strategy.countText(inner.text);
            else if (inner.type === 'image') imageTokens += 1500;
          }
        }
      } else if ('type' in block && block.type === 'image') {
        // Flat per-image estimate. Anthropic charges roughly (W*H)/750 tokens;
        // ~1500 covers most chat-pasted screenshots without dimension metadata.
        imageTokens += 1500;
      }
    }
  }

  return textTokens + imageTokens + MESSAGE_OVERHEAD_TOKENS;
}

/** Estimate total tokens for an array of messages + system prompt. */
export function estimateSessionTokens(
  messages: ProviderMessage[],
  systemPrompt: string | undefined,
  provider: string,
  modelId?: string
): number {
  let total = 0;
  if (systemPrompt) {
    total += estimateTokens(systemPrompt, provider, modelId) + MESSAGE_OVERHEAD_TOKENS;
  }
  for (const msg of messages) {
    total += estimateMessageTokens(msg, provider, modelId);
  }
  return total;
}
