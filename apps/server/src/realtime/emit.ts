/**
 * The single funnel for broadcasting workspace events to all WS clients.
 * Emit from the service layer, never from a route handler: agent tool calls
 * and HTTP requests reach the same services, so only service-level emits fire
 * for every mutation path. The actor comes from `getCurrentActor()` and
 * defaults to 'system' (startup jobs, cron). Emit failures are logged and
 * swallowed so a failed broadcast never breaks the mutation.
 */

import { wsService } from '@server/services/WebSocketService';
import { logger } from '@server/config/logger';
import type {
  Actor,
  WorkspaceEvent,
  WorkspaceEventMeta,
  WorkspaceEventMessage,
  WorkspaceEventType,
} from '@snaglet/shared/types/workspace-events';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import { getCurrentActor } from './actorContext';
import { isoNow } from '@snaglet/shared/utils';

/**
 * What callers construct: an event variant minus the meta fields emit fills in
 * (ts, actor, originClientId). `Omit` is distributed over the union so each
 * variant keeps its own payload keys; a plain `Omit<WorkspaceEvent, …>` would
 * collapse them.
 */
export type WorkspaceEventInput = WorkspaceEvent extends infer E
  ? E extends WorkspaceEvent
    ? Omit<E, keyof WorkspaceEventMeta>
    : never
  : never;

/** Options that don't belong inside the event itself. */
export interface EmitOptions {
  /**
   * The WS connection that originated this mutation, if known. Forwarded as
   * `originClientId` on the event meta, for diagnostics; clients ignore it.
   */
  originClientId?: string;
  /**
   * Override the ambient actor. Use sparingly — prefer `runWithActor()` at
   * the request/run boundary so all downstream emits inherit correctly.
   */
  actor?: Actor;
}

const SYSTEM_ACTOR: Actor = {
  actorId: 'system',
  actorKind: 'system',
  actorName: 'system',
};

/**
 * Emit a workspace event to all subscribers of the `workspace` channel.
 *
 * Synchronous (the broadcast itself is sync; we don't await client delivery).
 * Returns `void` — callers should not branch on the result. Failures are
 * logged but never thrown.
 */
export function emitWorkspaceEvent(input: WorkspaceEventInput, options: EmitOptions = {}): void {
  try {
    const actor = options.actor ?? getCurrentActor() ?? SYSTEM_ACTOR;
    const meta: WorkspaceEventMeta = {
      ts: isoNow(),
      actor,
      ...(options.originClientId ? { originClientId: options.originClientId } : {}),
    };

    // Compose the full event. The cast is safe: WorkspaceEventInput is
    // exactly WorkspaceEvent minus the meta fields we just supplied.
    const event = { ...meta, ...input } as WorkspaceEvent;
    const eventType: WorkspaceEventType = event.type;

    const message: WorkspaceEventMessage = {
      channel: WORKSPACE_EVENT_CHANNEL,
      type: eventType,
      payload: event,
    };

    wsService.broadcastToChannel(WORKSPACE_EVENT_CHANNEL, message);
  } catch (err) {
    // Realtime is best-effort. Never let a broadcast failure surface to
    // the caller — the mutation has already succeeded by the time we're here.
    logger.error('[realtime] emitWorkspaceEvent failed', { error: err });
  }
}
