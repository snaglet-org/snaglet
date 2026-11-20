/**
 * agentStatusEvents.ts — Agent typing/status WebSocket emitters used by chat
 * handlers, plus the per-thread record of the status each agent's bubble shows,
 * which a view opening or reconnecting mid-run is given (see liveRunStatuses).
 */

import { wsService } from '@server/services/WebSocketService';
import { LogsService } from '@server/services/LogsService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { emitRunStatus } from '@server/services/SocketService/voiceSession/runStatusEvents';

interface AgentLogContext {
  agentName?: string;
  threadId?: string;
  threadName?: string;
  modelName?: string | null;
}

interface AgentStatusContext extends AgentLogContext {
  /**
   * The agent's turn has started but its run is not registered yet (context
   * assembly). Its status is reported to resuming views without a live run.
   */
  beforeRun?: boolean;
}

/**
 * What an agent's bubble shows: a run status, or `queued` when the dispatch
 * will run the agent again for a message that arrived during its last run.
 */
type ShownStatus = 'thinking' | 'typing' | 'tool_running' | 'queued';

interface RecordedStatus {
  status: ShownStatus;
  sessionId: string;
  /** Reported only while the agent's run is in the active-work registry. */
  needsLiveRun: boolean;
}

/** threadId → agentId → what that agent's bubble shows. Idle removes the agent. */
const shownStatus = new Map<string, Map<string, RecordedStatus>>();

function recordStatus(
  threadId: string,
  agentId: string,
  status: 'idle' | ShownStatus,
  sessionId: string,
  beforeRun: boolean
): void {
  const byAgent = shownStatus.get(threadId);
  if (status === 'idle') {
    if (!byAgent) return;
    byAgent.delete(agentId);
    if (byAgent.size === 0) shownStatus.delete(threadId);
    return;
  }
  const entry = { status, sessionId, needsLiveRun: status !== 'queued' && !beforeRun };
  if (byAgent) byAgent.set(agentId, entry);
  else shownStatus.set(threadId, new Map([[agentId, entry]]));
}

/**
 * Each agent whose bubble `threadId` shows, mapped to its status.
 *
 * A status frame is broadcast once per transition, so a view that subscribes
 * after a transition (opening the thread, a reload, a reconnect) never sees it;
 * the session handshake hands it this instead. A run status counts only while
 * the active-work registry holds the agent's run, so a run that ended without
 * its idle frame is never reported. A turn still assembling its context, and a
 * queued agent, have no run yet and are reported as recorded. A live run with
 * no recorded status reads as thinking: it has produced no output.
 */
export function liveRunStatuses(threadId: string): Map<string, ShownStatus> {
  const liveRunAgents = new Set<string>();
  for (const item of activeWorkRegistry.snapshot()) {
    if (item.kind === 'thread-run' && item.threadId === threadId && item.agentId) {
      liveRunAgents.add(item.agentId);
    }
  }
  const live = new Map<string, ShownStatus>();
  for (const [agentId, entry] of shownStatus.get(threadId) ?? []) {
    if (!entry.needsLiveRun || liveRunAgents.has(agentId)) live.set(agentId, entry.status);
  }
  for (const agentId of liveRunAgents) if (!live.has(agentId)) live.set(agentId, 'thinking');
  return live;
}

let releaseWired = false;

/**
 * Clear a thread's bubbles when its run lock is released: nothing runs there
 * any more, so whatever is still recorded (a re-wake the dispatch never ran, a
 * run that ended abnormally) is sent idle and dropped. Idempotent.
 */
export function initLiveRunStatuses(): void {
  if (releaseWired) return;
  releaseWired = true;
  activeRunTracker.onThreadReleased((threadId) => {
    for (const [agentId, entry] of shownStatus.get(threadId) ?? []) {
      emitAgentStatus('', entry.sessionId, agentId, 'idle', { threadId });
    }
    shownStatus.delete(threadId);
  });
}

export function emitAgentTyping(
  clientId: string,
  sessionId: string,
  agentId: string,
  isTyping: boolean,
  ctx?: AgentLogContext
): void {
  const message = {
    type: 'socket:agent:typing',
    payload: { sessionId, agentId, isTyping },
  } as const;

  if (ctx?.threadId) {
    wsService.broadcastToChannel(ctx.threadId, message);
  } else {
    wsService.sendToClient(clientId, message);
  }
  // Status transitions are covered by emitAgentStatus (thinking/typing/idle/…).
}

/**
 * Send an agent's status. With a thread it is broadcast to the thread and
 * recorded for views that join later; an idle for an agent the thread shows no
 * status for changes nothing and is not sent, so exit paths may send it freely.
 */
export function emitAgentStatus(
  clientId: string,
  sessionId: string,
  agentId: string,
  status: 'idle' | ShownStatus,
  ctx?: AgentStatusContext
): void {
  const message = {
    type: 'socket:agent:status',
    payload: { sessionId, agentId, status },
  } as const;

  if (ctx?.threadId) {
    if (status === 'idle' && !shownStatus.get(ctx.threadId)?.has(agentId)) return;
    recordStatus(ctx.threadId, agentId, status, sessionId, ctx.beforeRun === true);
    wsService.broadcastToChannel(ctx.threadId, message);
    // Feed the voice run-phase tracker the EXACT tool_running/thinking boundary
    // so barge-in can classify inject vs. abort precisely (needs a threadId).
    // A queued agent has no run, so the tracker has nothing to learn from it.
    if (status !== 'queued') emitRunStatus({ threadId: ctx.threadId, agentId, status });
  } else {
    wsService.sendToClient(clientId, message);
  }

  // Log agent status for visibility in logs page
  const statusLabel = status === 'idle' ? 'completed' : status;
  LogsService.socket.event(statusLabel, {
    agentName: ctx?.agentName,
    threadId: ctx?.threadId,
    agentId,
    sessionId,
    status,
  });
}
