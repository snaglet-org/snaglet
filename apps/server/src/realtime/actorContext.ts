/**
 * actorContext — per-request/per-run actor identity for realtime emit.
 *
 * Uses AsyncLocalStorage so the workspace event emit helper can pick up
 * "who caused this mutation" without every service-layer call having to
 * thread an actor parameter through its signature.
 *
 * Set by:
 *  - HTTP middleware (authenticated requests → user actor)
 *  - Agent engine run wrapper (tool calls → agent actor)
 *
 * If neither sets it, emit falls back to a 'system' actor. See emit.ts.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { Actor } from '@snaglet/shared/types/workspace-events';

const storage = new AsyncLocalStorage<Actor>();

/** Run `fn` with `actor` bound as the ambient actor for the duration. */
export function runWithActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn);
}

/** Get the ambient actor, or `undefined` if none is bound. */
export function getCurrentActor(): Actor | undefined {
  return storage.getStore();
}
