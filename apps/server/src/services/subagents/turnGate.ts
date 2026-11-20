/**
 * Whether a subagent helper's turn that is about to start must be dropped:
 * the helper was paused or removed after the message that triggered it (an
 * op:send, a brief or a re-dispatched leftover queued just before the
 * pause). A message posted after the pause (the user writing to it, op:send,
 * Resume, a timed resume) runs as usual.
 *
 * Checked at the start of every agent turn, before any context is built or
 * model called. Helper agents carry the `subagent-` id prefix
 * (SubagentService.start), so every other agent passes without a lookup.
 */
export async function helperTurnHeld(
  agentId: string,
  triggerMessageId: string | undefined
): Promise<boolean> {
  if (!agentId.startsWith('subagent-')) return false;
  // Lazy: the service imports the dispatch core that calls this.
  const { subagentService } = await import('./SubagentService');
  return subagentService.holdsTurn(agentId, triggerMessageId);
}
