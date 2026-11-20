import { Agents } from '@snaglet/db/tables/agents';
import { readTrimmedString } from '@snaglet/shared/utils';
import type { Actor } from '@snaglet/shared/types';
import { getCurrentActor } from '@server/realtime/actorContext';
import { AbortRunService } from '@server/services/AbortRunService';
import type { ToolHandler } from '@server/services/ToolService/types';

const tool: ToolHandler = async (input, _settings, context) => {
  const threadId = readTrimmedString(input.thread_id);
  const agentId = readTrimmedString(input.agent_id);
  if (!threadId) throw new Error('thread_id is required');
  if (!agentId) throw new Error('agent_id is required');

  let abortedBy: Actor | undefined;
  if (context?.agentId) {
    if (agentId !== context.agentId) {
      throw new Error('Agent callers may only abort their own active run');
    }
    // Calling-agent context is authoritative, exactly like thread_send: input
    // has no field that can spoof a different sender identity.
    const caller = await Agents.findById(context.agentId).catch(() => null);
    abortedBy = {
      actorKind: 'agent',
      actorId: context.agentId,
      actorName: caller?.name ?? context.runtime?.agentName ?? context.agentId,
    };
  } else {
    // External MCP calls arrive through runWithActor(external member).
    abortedBy = getCurrentActor();
  }
  if (!abortedBy || !['agent', 'external'].includes(abortedBy.actorKind)) {
    throw new Error('No calling agent or external member identity is available');
  }

  const result = await AbortRunService.abortAgentRun({ threadId, agentId, abortedBy });
  return JSON.stringify({ aborted: result.aborted, reason: result.reason });
};

export default tool;
