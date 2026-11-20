/**
 * runStatusEvents — an in-process pub/sub for agent run-status transitions.
 *
 * The turn loop already emits `socket:agent:status` (thinking / typing /
 * tool_running / idle) through `emitAgentStatus`. This leaf lets that hot path
 * make one additive call so the voice `runPhaseTracker` can know exactly when an
 * agent is mid-tool-execution vs. speaking — the precise signal barge-in needs
 * to choose inject (mid-tool) vs. abort+redispatch (mid-speech).
 *
 * Kept import-free (no wsService/DB/engine) so `chatHelpers.ts` can import it
 * with zero cycle risk, mirroring `utteranceEvents.ts`.
 *
 * The `listeners.size === 0` guard in emitRunStatus only matters in unit tests
 * and boot windows: the runPhaseTracker subscribes once at socket boot
 * (registerVoiceHandlers → initRunPhaseTracker) and never unsubscribes, so in a
 * running server the per-emit cost is one Set lookup + one try-guarded call.
 */

type RunStatus = 'idle' | 'thinking' | 'typing' | 'tool_running';

export interface RunStatusEvent {
  readonly threadId: string;
  readonly agentId: string;
  readonly status: RunStatus;
}

type Listener = (evt: RunStatusEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to run-status transitions. Returns an unsubscribe fn. */
export function onRunStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Fan a run-status transition out to subscribers. Fully guarded: a listener that
 * throws must never break the status-emit path that called it.
 */
export function emitRunStatus(evt: RunStatusEvent): void {
  if (listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(evt);
    } catch {
      // Swallow — a voice subscriber must not break agent status broadcasts.
    }
  }
}

/** Test-only reset. */
export function __resetRunStatusListeners(): void {
  listeners.clear();
}
