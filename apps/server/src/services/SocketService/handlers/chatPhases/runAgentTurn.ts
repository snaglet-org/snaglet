/**
 * Public factory for running one agent turn.
 *
 * The implementation lives in `turnLoop.ts`; this file stays intentionally
 * small so dispatch callers keep a stable import path while the turn lifecycle
 * is split into concern-specific modules.
 */

import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './types';
import { runAgentTurnLoop } from './turnLoop';

export function createRunAgentTurn(
  deps: RunAgentTurnDeps,
  shared: RunAgentTurnSharedState
): (replyAgentId: string, abortController?: AbortController) => Promise<void> {
  return (replyAgentId: string, abortController?: AbortController) =>
    runAgentTurnLoop(deps, shared, replyAgentId, abortController ?? deps.abortController);
}
