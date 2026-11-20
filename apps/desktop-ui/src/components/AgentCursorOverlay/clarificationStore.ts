import { useSyncExternalStore } from 'react';
import type { ClarificationRequestPayload } from '@snaglet/shared/types';
import type { ClarificationRespond } from '@desktop/pages/Dashboard/views/ChatView/useClarificationForm';

/**
 * Bridge between the chat stream (which receives `socket:clarification:request`
 * frames) and the cursor overlay (which may show the question next to the
 * asking agent's flower). One source of truth per callId:
 *  - each chat stream publishes its pending request together with the function
 *    that sends the response frame;
 *  - the overlay shows a card for each one whose agent has a flower on screen,
 *    while the composer panel stays up too, so the user can answer on either.
 * Answering through either surface goes through the same `respond`, which
 * clears the stream's pending request, so both close together.
 */
export interface PendingClarification {
  request: ClarificationRequestPayload;
  respond: ClarificationRespond;
}

let pending: PendingClarification[] = [];
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Publish a pending request; returns the function that withdraws it. */
export function publishClarification(entry: PendingClarification): () => void {
  pending = [...pending.filter((p) => p.request.callId !== entry.request.callId), entry];
  emit();
  return () => {
    if (!pending.includes(entry)) return;
    pending = pending.filter((p) => p !== entry);
    emit();
  };
}

export function usePendingClarifications(): PendingClarification[] {
  return useSyncExternalStore(subscribe, () => pending);
}

/** Test helper. */
export function resetClarificationStore(): void {
  pending = [];
  emit();
}
