import type { SubagentRow } from '@snaglet/db/tables/subagents';
import {
  SUBAGENT_CHANGED_FRAME,
  type SubagentChangedPayload,
  type SubagentSummary,
} from '@snaglet/shared/types';
import { wsService } from '@server/services/WebSocketService';

/** The UI shape of a subagents row. */
export function toSubagentSummary(
  row: SubagentRow,
  orchestratorName: string | null
): SubagentSummary {
  return {
    id: row.id,
    name: row.name,
    parentThreadId: row.parentThreadId,
    threadId: row.threadId,
    orchestratorAgentId: row.orchestratorAgentId,
    orchestratorName,
    agentId: row.agentId,
    providerId: row.providerId,
    modelId: row.modelId,
    status: row.status,
    error: row.error,
    resumeAt: row.resumeAt ? new Date(row.resumeAt).toISOString() : null,
    taskCount: row.taskCount,
    createdAt: row.createdAt,
    lastTaskAt: row.lastTaskAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * A helper started, changed state, or was removed. Thread-scoped: only the
 * parent thread's viewers render the composer strip, so the frame goes to
 * that channel, never to the workspace channel (helpers are not workspace
 * items).
 */
export function emitSubagentChanged(
  parentThreadId: string,
  subagent: SubagentSummary | null,
  removedId?: string
): void {
  const payload: SubagentChangedPayload = {
    parentThreadId,
    subagent,
    ...(subagent === null && removedId ? { removedId } : {}),
  };
  wsService.broadcastToChannel(parentThreadId, { type: SUBAGENT_CHANGED_FRAME, payload });
}
