/**
 * Module-level signal that a model catalog changed, fed by the workspace event
 * bridge: `models.changed` from the server (models imported after a key was
 * saved or tested, edited, removed or added by an agent), and once after every
 * WebSocket (re)connect, because events missed while disconnected are not
 * replayed. Model lists listen here and re-read; the signal carries no rows.
 */

const target = new EventTarget();
const EVENT_NAME = 'models-changed';

export function emitModelsChanged(): void {
  target.dispatchEvent(new Event(EVENT_NAME));
}

/** Hear every catalog change; returns the unsubscribe. */
export function subscribeModelsChanged(handler: () => void): () => void {
  target.addEventListener(EVENT_NAME, handler);
  return () => target.removeEventListener(EVENT_NAME, handler);
}
