/**
 * When the thread digest is due: a token amount of new conversation since the last digest, not a
 * message count. Thirty one-line replies are cheap; one run of tool calls can be enormous, and the
 * digest exists for search, embeddings and the thread list, which care how much was said and done.
 * Overridable per model through `metadata.summary.tokenThreshold`.
 */

import { estimateTokens } from '@server/services/TokenEstimator';

/** Estimated tokens of new conversation that make a digest due. A placeholder default. */
export const DEFAULT_DIGEST_TOKEN_THRESHOLD = 20_000;

/** Characters of tool input and output per token; a flat ratio, as the tool work is a heuristic. */
const TOOL_CHARS_PER_TOKEN = 4;

/** Per-message framing cost, as the context budget's estimator counts it. */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function resolveDigestTokenThreshold(
  summaryMeta: { tokenThreshold?: number } | undefined
): number {
  const value = summaryMeta?.tokenThreshold;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_DIGEST_TOKEN_THRESHOLD;
}

/** Estimated tokens of the messages and tool work added since the last digest. */
export function estimateNewConversationTokens(args: {
  messageTexts: readonly string[];
  /** Characters of tool input and output logged since the last digest. */
  toolChars: number;
  provider: string;
  modelId?: string;
}): number {
  let tokens = Math.ceil(Math.max(0, args.toolChars) / TOOL_CHARS_PER_TOKEN);
  for (const text of args.messageTexts) {
    tokens += estimateTokens(text, args.provider, args.modelId) + MESSAGE_OVERHEAD_TOKENS;
  }
  return tokens;
}
