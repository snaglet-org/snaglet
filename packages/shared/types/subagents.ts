/**
 * Subagent helpers as the UI sees them: the composer strip lists a
 * thread's live helpers, and each result row in the parent thread names one.
 */

/** `stopped` means paused: kept with its thread and work until it gets a new task. */
export type SubagentStatus = 'running' | 'finished' | 'failed' | 'stopped';

export interface SubagentSummary {
  id: string;
  name: string;
  /** The thread whose agent started this helper. */
  parentThreadId: string;
  /** The helper's hidden thread; null once it is gone. */
  threadId: string | null;
  orchestratorAgentId: string;
  /** Display name of the orchestrator, when known. */
  orchestratorName: string | null;
  /** The helper's own agent id. */
  agentId: string;
  providerId: string;
  modelId: string;
  status: SubagentStatus;
  error: string | null;
  /** When a timed pause ends and the helper resumes on its own; null otherwise. */
  resumeAt: string | null;
  taskCount: number;
  createdAt: string;
  lastTaskAt: string;
  finishedAt: string | null;
}

/** `subagent:changed` on the parent thread's channel. */
export interface SubagentChangedPayload {
  parentThreadId: string;
  /** The helper's new state; null when it was removed. */
  subagent: SubagentSummary | null;
  /** Set when `subagent` is null: the id of the removed helper. */
  removedId?: string;
}

/** Thread-channel frame type for {@link SubagentChangedPayload}. */
export const SUBAGENT_CHANGED_FRAME = 'subagent:changed';

/** messages.metadata.event_kind on a helper's result row in the parent thread. */
export const SUBAGENT_RESULT_EVENT_KIND = 'subagent_finished';

/**
 * A result row that reports what someone did to the helper rather than what
 * the helper did: it was paused, or removed. Informational for the
 * orchestrator: it never wakes it.
 */
export type SubagentNotice = 'paused' | 'removed';

/** Metadata a result row carries (beside `event_kind`). */
export interface SubagentResultMetadata {
  subagent_id: string;
  subagent_name: string;
  subagent_thread_id: string | null;
  orchestrator_agent_id: string;
  orchestrator_name: string;
  subagent_status: Exclude<SubagentStatus, 'running'>;
  /** Set on a notice row. */
  subagent_notice?: SubagentNotice;
  /** Display name of who paused or removed it (the orchestrator's own name when it did). */
  subagent_notice_by?: string;
  /** A timed pause's end. */
  subagent_resume_at?: string | null;
}
