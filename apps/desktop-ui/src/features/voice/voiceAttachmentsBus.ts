// Tiny retained EventTarget bus carrying the composer's current image
// attachments to the voice session, so a voice-dictated message includes them
// (the reverse of voiceDraftBus). The Composer publishes its attachment ids
// here and VoiceSessionProvider reads them.
//
// Retained: effects run child-first, so the Composer's mount publish fires
// before the provider subscribes. The latest ids per thread are kept so the
// provider can seed its state via getVoiceAttachmentIds() after subscribing.

const BUS_EVENT = 'snaglet:voice:attachments';

/** Latest published attachment ids per threadId (see the retained note above). */
const latestByThread = new Map<string, string[]>();

export interface VoiceAttachmentsEvent {
  threadId: string;
  attachmentIds: string[];
}

/** Composer → voice: publish the composer's current image attachment ids. */
export function publishVoiceAttachmentIds(threadId: string, attachmentIds: string[]): void {
  latestByThread.set(threadId, attachmentIds);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<VoiceAttachmentsEvent>(BUS_EVENT, { detail: { threadId, attachmentIds } })
  );
}

/** The last-published attachment ids for a thread (empty if none yet). */
export function getVoiceAttachmentIds(threadId: string): string[] {
  return latestByThread.get(threadId) ?? [];
}

export function subscribeVoiceAttachmentIds(
  handler: (evt: VoiceAttachmentsEvent) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<VoiceAttachmentsEvent>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(BUS_EVENT, listener);
  return () => window.removeEventListener(BUS_EVENT, listener);
}
