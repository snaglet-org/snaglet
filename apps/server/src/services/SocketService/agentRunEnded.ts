/**
 * agentRunEnded — the `[agent run ended · <name> · <duration> · N tool calls]`
 * thread_event is a footer for PEOPLE (the chat UI renders it), never for agents.
 *
 * It stays persisted + broadcast, so the UI keeps showing it, but every
 * agent-facing read drops it through `isAgentRunEndedRow`: replay assembly,
 * summary/compaction input, the `thread_read` tool (default and message_context) and prompt-include previews.
 * Mid-run delivery is cut at the source (`injectMidRun: false` in threadEvents).
 *
 * Dependency-free on purpose (no DB/socket imports) so any reader, and its
 * tests, can import it without dragging the narration emitters in.
 */

/** messages.metadata.event_kind on the run-ended row. */
export const AGENT_RUN_ENDED_EVENT_KIND = 'agent_run_ended';

/** Whether a message row is the run-ended UI footer (and so hidden from agents). */
export function isAgentRunEndedRow(row: {
  messageType?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  return (
    row.messageType === 'thread_event' && row.metadata?.event_kind === AGENT_RUN_ENDED_EVENT_KIND
  );
}
