import type { MessageRow } from '@snaglet/db/tables/messages';
import { helperThreadExclusionSql } from '@snaglet/db/tables/threads/visibility';

/** Also excludes real mid-run user messages: explicit product policy. */
export function isEmbeddableMessage(
  message: Pick<MessageRow, 'role' | 'messageType' | 'injectedDuringRun' | 'metadata'>
): boolean {
  if (
    Object.prototype.hasOwnProperty.call(message.metadata ?? {}, 'run_error') ||
    (message.messageType === 'thread_event' && message.metadata?.event_kind === 'agent_run_aborted')
  )
    return true;
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    (message.messageType === 'message' || message.messageType === 'question') &&
    !message.injectedDuringRun &&
    String(message.metadata?.injected_during_run ?? 'false') !== 'true'
  );
}

/**
 * Fixed alias m, shared by sweeps, backfills and historical-vector audits.
 * Nothing in a subagent helper thread is ever embedded, whatever its kind, so
 * the startup purge also drops any vector a helper message already has. The
 * row-level check for single messages is in EmbeddingOrchestrator.
 */
export const EMBEDDABLE_MESSAGE_SQL = `((COALESCE(m.metadata ? 'run_error', false)
  OR (m.message_type = 'thread_event' AND COALESCE(m.metadata->>'event_kind', '') = 'agent_run_aborted')
  OR (m.role IN ('user', 'assistant')
  AND m.message_type IN ('message', 'question')
  AND COALESCE(m.metadata->>'injected_during_run', 'false') <> 'true'))
  AND ${helperThreadExclusionSql('m.thread_id')})`;
