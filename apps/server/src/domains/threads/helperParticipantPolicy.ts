import { Subagents } from '@snaglet/db/tables/subagents';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';

/** A person or the helper's orchestrator may edit its participant settings. */
export async function assertHelperParticipantEdit(
  thread: { id: string; parentThreadId?: string | null },
  callingAgentId: string | undefined
): Promise<void> {
  if (!thread.parentThreadId || !callingAgentId) return;
  const sub = await Subagents.findLiveByThreadId(thread.id);
  if (sub?.orchestratorAgentId !== callingAgentId) {
    throw new AppError(
      "thread_update: this is a subagent's thread; only the agent that started that subagent can change its settings.",
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  }
}
