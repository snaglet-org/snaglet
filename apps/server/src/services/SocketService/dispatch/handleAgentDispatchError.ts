/**
 * handleAgentDispatchError — shared agent-dispatch error classifier.
 *
 * Extracted from dispatchToThread.ts where the identical timeout-handling
 * block appeared twice (parallel `.catch` branch + sequential `catch`
 * branch). Behavior-identical to the original inline blocks.
 *
 * Contract:
 *   - On a timeout error (`message` includes "timed out"): logs via
 *     LogsService.socket.error, sends a `socket:error` to the client, and
 *     returns `true`. The caller is responsible for pushing the passed
 *     wave result (the wave-results array stays owned by the call site).
 *   - On any other error: re-throws so the run can fail fast through the
 *     caller's await / outer try-catch. Never returns for non-timeouts.
 */
import { wsService } from '@server/services/WebSocketService';
import { LogsService } from '@server/services/LogsService';
import { persistRunErrorMessage } from '@server/services/SocketService/persistRunErrorMessage';
import { getErrorMessage } from '@snaglet/shared/utils';

export interface AgentDispatchErrorContext {
  agentId: string;
  agentLabel: string;
  threadName: string;
  threadId: string;
  sessionId: string;
  clientId: string;
  /** Optional run id so the persisted error message can be linked back to the run row. */
  runId?: string | null;
}

/**
 * Returns `true` if the error was a timeout (caller should treat the wave
 * slot as a pass). Re-throws for all non-timeout errors.
 *
 * Async: timeout handling now persists a chat-visible error message into
 * the thread so other agents and any other browser tab can see what
 * happened — `await` so the message lands before the wave moves on.
 */
export async function handleAgentDispatchError(
  err: unknown,
  ctx: AgentDispatchErrorContext
): Promise<boolean> {
  const errMsg = getErrorMessage(err);
  if (errMsg.includes('timed out')) {
    LogsService.socket.error(err, {
      agentName: ctx.agentLabel,
      threadName: ctx.threadName,
      threadId: ctx.threadId,
      sessionId: ctx.sessionId,
    });
    wsService.sendToClient(ctx.clientId, {
      type: 'socket:error',
      payload: {
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
        agentId: ctx.agentId,
        message: `Agent response timed out`,
      },
    });
    await persistRunErrorMessage({
      threadId: ctx.threadId,
      agentId: ctx.agentId,
      agentName: ctx.agentLabel,
      runId: ctx.runId ?? null,
      kind: 'timeout',
      rawError: err,
    });
    return true;
  }
  // Non-timeout errors surface to the outer try/catch via the caller's
  // `await` so the run can fail fast.
  throw err;
}
