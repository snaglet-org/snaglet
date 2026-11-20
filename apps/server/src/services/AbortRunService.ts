/**
 * Single cancellation boundary for live agent turns.
 *
 * Every caller supplies an actor so cancellation remains attributable across
 * the UI, agent tools, external MCP calls, and the watchdog. The low-level
 * abort store only owns signals; this service also reaps agent-owned shell
 * processes and writes the non-dispatching transcript event.
 */
import { Agents } from '@snaglet/db/tables/agents';
import { Messages } from '@snaglet/db/tables/messages';
import type { Actor } from '@snaglet/shared/types';
import { isoNow, isoStamp } from '@snaglet/shared/utils';
import { wsService } from '@server/services/WebSocketService';
import {
  abortAgentRun as signalAgentRun,
  abortThread,
  listActiveAgentRuns,
} from '@server/services/SocketService/abortStore';
import { killShellSessionsForAgent } from '@server/services/ToolService/tools/shell/codex-shell-sessions';

const AGENT_RUN_ABORTED_EVENT_KIND = 'agent_run_aborted';

type AbortAgentRunResult =
  | { aborted: true; reason: 'aborted'; sessionId: string; killedShells: number }
  | { aborted: false; reason: 'agent_not_active' };

interface AbortAgentRunInput {
  threadId: string;
  agentId: string;
  abortedBy: Actor;
}

function actorLabel(actor: Actor): string {
  return actor.actorName?.trim() || (actor.actorKind === 'system' ? 'watchdog' : actor.actorId);
}

class AbortRunServiceClass {
  async abortAgentRun(input: AbortAgentRunInput): Promise<AbortAgentRunResult> {
    const signaled = signalAgentRun(input.threadId, input.agentId, input.abortedBy);
    if (!signaled.aborted || !signaled.sessionId) {
      return { aborted: false, reason: 'agent_not_active' };
    }

    // A tool executor observes the same AbortSignal, but an exec_command child
    // can be blocked below JavaScript. Reap only the target agent's process
    // groups so peers on the same thread keep running. Its background jobs
    // (shell run background: true) are detached from the run and survive.
    const killedShells = killShellSessionsForAgent(input.threadId, input.agentId);
    // Clear live UI state immediately. Transcript persistence below may await
    // storage, but a successfully delivered signal must never leave a stale
    // running chip if that write is slow or fails.
    wsService.broadcastToChannel(input.threadId, {
      type: 'socket:chat:aborted',
      payload: {
        sessionId: signaled.sessionId,
        threadId: input.threadId,
        agentId: input.agentId,
        abortedBy: input.abortedBy,
      },
    });

    const target = await Agents.findById(input.agentId).catch(() => null);
    const targetName = target?.name?.trim() || input.agentId;
    const byName = actorLabel(input.abortedBy);
    const content = `[${byName}] aborted [${targetName}]`;

    const row = await Messages.createEvent({
      threadId: input.threadId,
      content,
      eventKind: AGENT_RUN_ABORTED_EVENT_KIND,
      metadata: {
        target_agent_id: input.agentId,
        target_agent_name: targetName,
        aborted_by_kind: input.abortedBy.actorKind,
        aborted_by_id: input.abortedBy.actorId,
        aborted_by_name: byName,
      },
    });

    // This is a machine-authored transcript row, not a user/agent send. Direct
    // persistence + broadcast deliberately bypasses every dispatch entrypoint.
    wsService.broadcastToChannel(input.threadId, {
      type: 'socket:chat:message_created',
      payload: {
        id: row.id,
        threadId: input.threadId,
        role: 'user',
        content,
        created_at: row.createdAt ? isoStamp(row.createdAt) : isoNow(),
        message_type: 'thread_event',
      },
    });
    return {
      aborted: true,
      reason: 'aborted',
      sessionId: signaled.sessionId,
      killedShells,
    };
  }

  /** Stop every active agent, then trip the parent conversation controller. */
  async abortAllAgentRuns(input: {
    threadId: string;
    abortedBy: Actor;
  }): Promise<{ abortedCount: number }> {
    const active = listActiveAgentRuns(input.threadId);
    // Construct every promise before awaiting: abortAgentRun fires the signal
    // synchronously, so all peers stop together even if transcript I/O is slow.
    const pending = active.map(({ agentId }) => this.abortAgentRun({ ...input, agentId }));
    // The parent signal tells the dispatch wave not to start another turn after
    // its now-aborted children unwind. It is intentionally fired after the
    // child signals so each child retains its attributed AbortSignal.reason.
    // The parent carries the same attributed actor so the dispatch loop can
    // record WHO ended the conversation (user Stop vs watchdog release).
    abortThread(input.threadId, {
      kind: 'agent_run_abort',
      targetAgentId: '*',
      abortedBy: input.abortedBy,
    });
    const results = await Promise.all(pending);
    const abortedCount = results.filter((result) => result.aborted).length;
    return { abortedCount };
  }
}

export const AbortRunService = new AbortRunServiceClass();
