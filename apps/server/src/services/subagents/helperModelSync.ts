/**
 * A helper's `subagents` row names the model it runs on: the helper thread's
 * header, the parent thread's composer chip and `subagent op:list` all read
 * it. A participant model override in the helper's own thread changes the
 * model its next turn uses (Threads.getEffectiveModel), so every write of that
 * override calls this to bring the row along.
 */
import { Agents } from '@snaglet/db/tables/agents';
import { Subagents, type SubagentRow } from '@snaglet/db/tables/subagents';
import { Threads } from '@snaglet/db/tables/threads';
import { getErrorMessage } from '@snaglet/shared/utils';
import { emitSubagentChanged, toSubagentSummary } from '@server/realtime/surfaces/subagents';
import { LogsService } from '@server/services/LogsService';

/**
 * Set the live helper's row to its effective model in `threadId` and tell the
 * parent thread. A no-op unless `agentId` is the helper of that thread, and
 * when the override is partial (no effective model, so nothing to show).
 * Never throws: the override is already saved, and a stale label must not
 * fail that write.
 */
export async function syncHelperModel(
  threadId: string,
  agentId: string
): Promise<SubagentRow | null> {
  try {
    const sub = await Subagents.findLiveByThreadId(threadId);
    if (!sub || sub.agentId !== agentId) return null;
    const effective = await Threads.getEffectiveModel(threadId, agentId);
    if (!effective) return sub;
    if (effective.providerId === sub.providerId && effective.modelId === sub.modelId) return sub;
    const updated = await Subagents.updateModel(sub.id, effective);
    if (!updated) return null;
    const orchestrator = await Agents.findById(updated.orchestratorAgentId);
    emitSubagentChanged(
      updated.parentThreadId,
      toSubagentSummary(updated, orchestrator?.name ?? null)
    );
    return updated;
  } catch (err) {
    LogsService.warn('subagent model sync failed', {
      threadId,
      agentId,
      error: getErrorMessage(err),
    });
    return null;
  }
}
