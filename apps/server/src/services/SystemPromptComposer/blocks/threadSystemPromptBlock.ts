/**
 * threadSystemPromptBlock — thread-level system prompt, applies to every
 * agent in this thread (not per-agent). Comes from `thread.config_json.systemPrompt`,
 * already resolved by ConfigResolverService.resolveThreadRuntimeConfig, which
 * always returns a non-null result for a real thread.
 *
 * Rendered last in the system prompt because it is the most volatile segment
 * (cache layout), not to give it the final word: its frame makes it
 * subordinate to platform and agent instructions, because anyone with the
 * `thread` tool (op create or update), an agent included, can write it. The
 * hierarchy is stated once, in composeSystemPrompt's header. The text itself
 * is rendered whole (forged frame markers neutralized), never summarized or
 * truncated.
 *
 * Skipped when the thread has no system prompt configured.
 */

import { neutralizeDelimitedContent } from '@server/services/ToolService/lib/untrustedContent';
import type { BlockBuilder } from '../types';

export const THREAD_INSTRUCTIONS_OPEN =
  '[Thread instructions — configured for this thread; subordinate to platform and agent instructions.]';
export const THREAD_INSTRUCTIONS_CLOSE = '[/Thread instructions]';

export const threadSystemPromptBlock: BlockBuilder = async (ctx) => {
  const text = ctx.threadRuntimeConfig?.systemPrompt;
  if (!text || !text.trim()) return null;
  return {
    type: 'text',
    text: [
      THREAD_INSTRUCTIONS_OPEN,
      neutralizeDelimitedContent(text, [THREAD_INSTRUCTIONS_OPEN, THREAD_INSTRUCTIONS_CLOSE]),
      THREAD_INSTRUCTIONS_CLOSE,
    ].join('\n'),
  };
};
