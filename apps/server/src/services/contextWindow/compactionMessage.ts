/**
 * The one message that stands in for folded-away history: a header, the disclaimer, an optional
 * roster/mode carry-forward, then the summary. Built here so replay assembly (which applies a
 * persisted compaction) and sliding-window compression (the synthesized fallback) cannot drift.
 */

import type { TextMessage } from '@server/services/ProviderChatService';
import { SUMMARY_DISCLAIMER } from './constants';

export const COMPACTION_SUMMARY_HEADER = '[Historical context summary — earlier turns folded away]';
const NEWCOMER_CUT_HEADER = '[Earlier history not shown — you joined this thread later]';

export function buildCompactionSummaryMessage(
  summary: string,
  carryForward?: string | null
): TextMessage {
  const carryLine = carryForward && carryForward.trim() ? carryForward.trim() : null;
  return {
    role: 'user',
    content: [
      COMPACTION_SUMMARY_HEADER,
      SUMMARY_DISCLAIMER,
      ...(carryLine ? ['', carryLine] : []),
      '',
      summary,
    ].join('\n'),
  };
}

/** The one message that stands in for the history a newcomer never saw: no summary, only the note. */
export function buildNewcomerCutMessage(note: string): TextMessage {
  return {
    role: 'user',
    content: [NEWCOMER_CUT_HEADER, SUMMARY_DISCLAIMER, '', note].join('\n'),
  };
}
