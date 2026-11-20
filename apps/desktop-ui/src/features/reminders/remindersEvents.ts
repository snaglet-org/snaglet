/**
 * In-window signal that reminder settings changed here (a Notify section
 * saved), so the native schedule resyncs without waiting for the server's
 * `reminders:changed` frame. Both feed the same debounced sync.
 */
const LOCAL_CHANGED_EVENT = 'snaglet:reminders-changed';

export function notifyRemindersChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LOCAL_CHANGED_EVENT));
}

export function onLocalRemindersChanged(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(LOCAL_CHANGED_EVENT, handler);
  return () => window.removeEventListener(LOCAL_CHANGED_EVENT, handler);
}
