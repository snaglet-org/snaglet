import type { MentionResult } from '@server/services/MentionParser';

type DispatchRouting = 'all' | 'mentioned';

export interface BuildDispatchSetInput {
  /** Mention resolution result for the incoming user message. */
  readonly mentions: MentionResult;
  /** Routing mode for this thread. */
  readonly dispatchRouting: DispatchRouting;
  /** Canonical participant agent IDs (preserve case in output). */
  readonly participantAgentIds: readonly string[];
  /** Lowercased set of mention-resolved agent IDs, precomputed by caller. */
  readonly mentionedIdSetLC: ReadonlySet<string>;
}

/**
 * Build the initial dispatch set for a chat turn.
 *
 * Rules (in priority order):
 *   1. `'all'` dispatch mode: everyone is dispatched regardless of @mentions.
 *      Mentions are context, not a routing filter, in this mode.
 *   2. In non-`'all'` modes, explicit @mentions narrow dispatch to those agents.
 *   3. `'mentioned'` mode, no @mentions, group thread: return empty set. The
 *      caller surfaces a hint telling the user to @mention an agent.
 *   4. No @mentions, single-agent thread: dispatch to that agent (no hint needed).
 *
 * Case is preserved from `participantAgentIds` (the canonical form). `mentionedIdSetLC`
 * must be lowercased by the caller to match against participant IDs case-insensitively.
 *
 * Pure function: no I/O, no mutation of inputs.
 */
export function buildDispatchSet(input: BuildDispatchSetInput): Set<string> {
  const { mentions, dispatchRouting, participantAgentIds, mentionedIdSetLC } = input;

  if (dispatchRouting === 'all') {
    return new Set(participantAgentIds);
  }

  if (mentions.hasMentions) {
    return new Set(participantAgentIds.filter((id) => mentionedIdSetLC.has(id.toLowerCase())));
  }

  // No @mentions. 'mentioned' mode gates group threads behind @mentions — return
  // empty so the caller can show a hint.
  if (dispatchRouting === 'mentioned' && participantAgentIds.length > 1) {
    return new Set<string>();
  }
  return new Set(participantAgentIds);
}
