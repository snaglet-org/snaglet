/**
 * In-tab signal that the user read a DM thread (the reading pane marked it
 * read on the server). Marking read raises no realtime event, so the DMs list
 * listens here to clear the badges of the conversation just read.
 */
const target = new EventTarget();
const EVENT_NAME = 'snaglet:dm-read';

export function emitDmRead(threadId: string): void {
  target.dispatchEvent(new CustomEvent<string>(EVENT_NAME, { detail: threadId }));
}

export function onDmRead(handler: (threadId: string) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<string>).detail);
  target.addEventListener(EVENT_NAME, listener);
  return () => target.removeEventListener(EVENT_NAME, listener);
}
