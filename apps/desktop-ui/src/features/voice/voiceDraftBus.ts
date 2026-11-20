// Tiny EventTarget bus routing the voice hook's live transcript into the chat
// composer. The voice hook emits; the Composer subscribes and drives its own
// draft value, including the stash of the pre-capture typed draft (see
// voiceComposerDraft).

const BUS_EVENT = 'snaglet:voice:composer';

/**
 * Signals from the voice hook to the composer for one utterance's lifecycle:
 * - `start`  — capture began: the composer stashes its current typed draft.
 * - `update` — the converging transcript; overwrites the composer value while
 *              capturing. `isRevising` is true when it changed already-shown
 *              words rather than extending the tail, so the composer shows a
 *              subtle "refining" cue.
 * - `settle` — the dispatched final: show it briefly, then restore the stash.
 * - `bail`   — Esc bail-out: merge `stash + ' ' + text` into the composer so
 *              nothing is lost and it stays fully editable.
 * - `revert` — a no-dispatch burst (backchannel / nothing heard): restore the
 *              stash unchanged (nothing was sent).
 */
export type VoiceComposerEvent =
  | { kind: 'start'; threadId: string }
  | { kind: 'update'; threadId: string; text: string; isRevising: boolean }
  | { kind: 'settle'; threadId: string; text: string }
  | { kind: 'bail'; threadId: string; text: string }
  | { kind: 'revert'; threadId: string };

export function emitVoiceComposer(evt: VoiceComposerEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<VoiceComposerEvent>(BUS_EVENT, { detail: evt }));
}

export function subscribeVoiceComposer(handler: (evt: VoiceComposerEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<VoiceComposerEvent>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(BUS_EVENT, listener);
  return () => window.removeEventListener(BUS_EVENT, listener);
}
