import { useCallback } from 'react';
import { pauseHelper } from './subagentActions';
import type { HelperThreadInfo } from './useHelperThread';

export interface HelperStop {
  /** The composer's Stop. */
  onStop: () => void;
  /** A status bubble's Stop for one agent. */
  onStopAgent: (agentId: string) => void;
}

/**
 * In a helper's own thread, Stop means pause: the helper is kept with its
 * thread and work and its orchestrator is told, instead of the run ending
 * as "stopped". Anywhere else, or before the helper's row has loaded, Stop
 * aborts the run as usual.
 */
export function useHelperStop(
  helper: HelperThreadInfo | null,
  stopGeneration: () => void,
  stopAgentGeneration: (agentId: string) => void
): HelperStop {
  const subagent = helper?.subagent ?? null;
  const onStop = useCallback(() => {
    if (subagent) void pauseHelper(subagent);
    else stopGeneration();
  }, [subagent, stopGeneration]);
  const onStopAgent = useCallback(
    (agentId: string) => {
      if (subagent && agentId === subagent.agentId) void pauseHelper(subagent);
      else stopAgentGeneration(agentId);
    },
    [subagent, stopAgentGeneration]
  );
  return { onStop, onStopAgent };
}
