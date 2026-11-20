import { Runs } from '@snaglet/db/tables/runs';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import type { SystemContentBlock } from '@server/services/ProviderChatService';
import { isRunCompactionActivity } from '@server/services/contextWindow/runCompactionRecord';
import {
  neutralizeSystemFraming,
  neutralizeUntrustedName,
} from '@server/services/ToolService/lib/untrustedContent';

/** Abort labels that mean Snaglet cut the run off, not a person or agent stopping it. */
const SNAGLET_ABORT_LABELS = new Set(['timeout', 'watchdog', 'system']);

/**
 * Who stopped a run, from its stored error (`Aborted by <who>`, written by the
 * turn loop), or null when Snaglet cut it off or it failed on its own.
 */
function stoppedBy(error: string | null): string | null {
  const by = /^Aborted by (.+)$/.exec(error?.trim() ?? '')?.[1]?.trim();
  if (!by || SNAGLET_ABORT_LABELS.has(by)) return null;
  return by === 'user' ? 'the user' : neutralizeUntrustedName(by);
}

/**
 * Build a "[System note: Your previous run …]" hint for the turn-context tail
 * when this agent's previous run in this thread failed, was interrupted (a run
 * cut off by a restart is marked failed too) or was stopped.
 *
 * "Previous" means before `currentRunId`: the turn loop creates the new run's
 * row before it assembles the context, so the newest run in the thread is
 * the one starting now.
 *
 * A completed run gets no hint: replay already carries the agent's own tool
 * calls and results (buildReplayPayload), so pointing it at its run log only
 * prompts a needless lookup. After a failure the log is where the work it
 * finished can be checked, so the hint names the real call (`agent` op
 * `activity`, view `self_history`, that run's id). After someone stopped the
 * run, the hint says so and does not invite redoing the work.
 *
 * Returns null when no hint applies, so the caller can
 * `if (block) systemBlocks.push(block)`.
 *
 * Errors are swallowed (returns null) — this is non-critical context decoration.
 */
export async function buildPriorRunHint(opts: {
  threadId: string;
  replyAgentId: string;
  /** The run starting now, excluded from "previous". */
  currentRunId?: string | null;
}): Promise<SystemContentBlock | null> {
  const { threadId, replyAgentId, currentRunId = null } = opts;
  try {
    const lastRun = await Runs.getPreviousForAgent(threadId, replyAgentId, currentRunId);
    if (!lastRun || lastRun.status !== 'failed') return null;

    const priorActivity = (await AgentActivityLog.getByRunId(lastRun.id, 50)).filter(
      (row) => !isRunCompactionActivity(row)
    );
    if (priorActivity.length === 0) return null;

    const toolCalls = priorActivity.filter((a) => a.actionType === 'tool_call');
    const lastTool = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1].tool : null;
    const actions =
      `That run had ${priorActivity.length} logged actions` +
      `${toolCalls.length > 0 ? ` (${toolCalls.length} tool calls, last: ${lastTool})` : ''}.`;
    const lookup = `\`agent\` op \`activity\`, view "self_history", run_id "${lastRun.id}"`;

    const by = stoppedBy(lastRun.error);
    if (by) {
      return {
        type: 'text',
        text:
          `[System note: Your previous run in this thread was stopped by ${by}. ${actions} ` +
          `Don't resume or redo that work unless asked; to see what it did: ${lookup}.]`,
      };
    }
    const reason = lastRun.error ? ` (${neutralizeSystemFraming(lastRun.error)})` : '';
    return {
      type: 'text',
      text:
        `[System note: Your previous run in this thread was interrupted or failed${reason}. ` +
        `${actions} Before redoing its work, check what it finished: ${lookup}.]`,
    };
  } catch {
    // Non-critical — skip silently
    return null;
  }
}
