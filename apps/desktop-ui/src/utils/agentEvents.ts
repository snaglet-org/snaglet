/**
 * Module-level bus for agent changes, fed by the workspace event bridge.
 *
 * `agent.updated` is the wire event as received (actor, `changed` and the
 * row's revision `updatedAt` included), so an open agent pane can attribute a
 * change and skip its own save's echo. `agents.invalidated` is sent on every
 * WebSocket (re)connect: events missed while disconnected are not replayed,
 * so anything showing an agent refetches it.
 *
 * Panes listen here instead of each subscribing to the workspace channel.
 */

import type { AgentUpdatedEvent } from '@snaglet/shared/types/workspace-events';

export type AgentEvent = AgentUpdatedEvent | { type: 'agents.invalidated' };

const target = new EventTarget();
const EVENT_NAME = 'agent-event';

export function emitAgentEvent(event: AgentEvent): void {
  target.dispatchEvent(new CustomEvent<AgentEvent>(EVENT_NAME, { detail: event }));
}

/** Hear every agent event; returns the unsubscribe. */
export function subscribeAgentEvents(handler: (event: AgentEvent) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<AgentEvent>).detail);
  target.addEventListener(EVENT_NAME, listener);
  return () => target.removeEventListener(EVENT_NAME, listener);
}
