/**
 * messageClassification.ts — Message-type detection and stagnation heuristics
 * used by chat handlers. Extracted from chatHelpers.ts (behavior-preserving).
 */

/**
 * Detect if an agent message is a question the user should answer.
 * Heuristic: message ends with '?' or contains a direct interrogative pattern.
 * Returns 'question' | 'message'.
 */
function detectMessageType(content: string): 'question' | 'message' {
  const trimmed = content.trim();
  if (trimmed.endsWith('?')) return 'question';
  // Multi-sentence: last non-empty sentence ends with '?'
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  const last = sentences[sentences.length - 1]?.trim() ?? '';
  if (last.endsWith('?')) return 'question';
  return 'message';
}

/**
 * Resolve the final message type.
 * Agent-authored `explicitType` always wins. Falls back to heuristic detection.
 * This ensures the heuristic never overrides explicit agent intent.
 */
export function resolveMessageType(
  content: string,
  explicitType?: 'question' | 'message' | null
): 'question' | 'message' {
  if (explicitType === 'question' || explicitType === 'message') return explicitType;
  return detectMessageType(content);
}

export interface WaveTurnResult {
  agentId: string;
  passed: boolean;
  replyLength: number;
  /** Whether the agent used any tools during this turn. */
  usedTools?: boolean;
}
