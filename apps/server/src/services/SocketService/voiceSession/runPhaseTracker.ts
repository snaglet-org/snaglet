/**
 * runPhaseTracker — is the thread's active run mid-tool vs mid-speech? Used only
 * to pick the barge-in action (inject vs. abort+redispatch).
 *
 * Policy: on barge-in, if the interrupted agent is mid-tool-run
 * the user message injects (user messages always inject); if it is mid-speech
 * (no tools in flight) we abort the run first, then send so it redispatches.
 *
 * This is bound to the real run status (`socket:agent:status` via
 * runStatusEvents), not inferred from the utterance stream. The turn loop
 * emits `tool_running` immediately before dispatching an iteration's tool calls
 * and `thinking` immediately after they finish (turnLoop.ts) — so an agent is
 * "tool-in-flight" for exactly the window between those two, which is exactly
 * what barge-in must know. Tracked per (thread, agent) so a group thread with
 * two speakers stays precise; the barge-in caller passes the interrupted agent.
 *
 * Only voice-active threads are tracked (registry guard) so the map stays tiny
 * and text-only runs add no state.
 */

import { onRunStatus } from './runStatusEvents';
import { isThreadVoiceActive } from './voiceSessionRegistry';

/** threadId → set of agentIds currently executing tools. */
const toolAgentsByThread = new Map<string, Set<string>>();

let wired = false;

/** Subscribe to the run-status stream once. Idempotent. */
export function initRunPhaseTracker(): void {
  if (wired) return;
  wired = true;
  onRunStatus((evt) => {
    // Only track voice threads — keeps this inert for ordinary text chat.
    if (!isThreadVoiceActive(evt.threadId)) return;
    if (evt.status === 'tool_running') {
      let set = toolAgentsByThread.get(evt.threadId);
      if (!set) {
        set = new Set<string>();
        toolAgentsByThread.set(evt.threadId, set);
      }
      set.add(evt.agentId);
    } else {
      // thinking | typing | idle → not executing tools.
      const set = toolAgentsByThread.get(evt.threadId);
      if (set) {
        set.delete(evt.agentId);
        if (set.size === 0) toolAgentsByThread.delete(evt.threadId);
      }
    }
  });
}

/**
 * True when the thread's active run is mid-tool execution. With `agentId`,
 * checks that specific agent (precise — the barge-in path passes the interrupted
 * agent); without it, true if any agent on the thread is mid-tool.
 */
export function isToolInFlight(threadId: string, agentId?: string): boolean {
  const set = toolAgentsByThread.get(threadId);
  if (!set) return false;
  return agentId ? set.has(agentId) : set.size > 0;
}

/** Clear a thread's phase (e.g. voice session teardown). */
export function clearRunPhase(threadId: string): void {
  toolAgentsByThread.delete(threadId);
}

/** Test-only reset (state + wiring). */
export function __resetRunPhaseTracker(): void {
  toolAgentsByThread.clear();
  wired = false;
}
