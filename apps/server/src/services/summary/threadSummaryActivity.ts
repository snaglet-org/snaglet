/**
 * The activity-log row written when a thread summary is generated: actionType
 * 'tool_call', tool THREAD_SUMMARY_ACTIVITY_TOOL (the action_type CHECK admits
 * no new kind without a migration). It exists for the run-activity UI only.
 *
 * It is not a tool the agent called. Replay must skip it: the agent receives
 * the summary once, as the labeled compaction context block, never as a
 * tool_use/tool_result pair for a tool it does not have.
 *
 * Kept free of heavy imports so the replay loader can read it.
 */
export const THREAD_SUMMARY_ACTIVITY_TOOL = 'thread_summary';
