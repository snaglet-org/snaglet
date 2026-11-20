/**
 * voiceStreamEvents — an in-process pub/sub for VISIBLE-TEXT deltas as they
 * stream, so the TTS pipeline can begin speaking on the first completed sentence
 * instead of waiting for the whole utterance to persist.
 *
 * This is the delta-stream twin of `utteranceEvents` (which fires at persist) and
 * `runStatusEvents` (which fires on status transitions): the turn loop's existing
 * `onVisibleDelta` seam makes ONE additive call per chunk — GUARDED by
 * `isThreadVoiceActive` at the call site — so text-only threads never emit and
 * pay nothing. Kept import-free (no wsService/DB/engine) so `turnLoop.ts` /
 * `llmStream.ts` can import it with zero cycle risk, mirroring the leaf pattern.
 *
 * The per-utterance identity is (`runId`, `iteration`): a run is a tool loop and
 * each iteration produces exactly one visible-text utterance, streamed then
 * closed at its tool boundary / terminal. The pipeline keys a SYNTHETIC utterance
 * id off these so every downstream surface (tts chunks, floor, playback:done,
 * heard-up-to) stays consistent for the whole utterance, then reconciles that
 * synthetic id to the real messageId when the persist event lands.
 */

export interface VoiceDeltaEvent {
  readonly threadId: string;
  readonly agentId: string;
  readonly runId: string;
  /** 1-based tool-loop iteration — the utterance ordinal within the run. */
  readonly iteration: number;
  /** One visible (thinking-stripped) text chunk as it streams. */
  readonly text: string;
}

type Listener = (evt: VoiceDeltaEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to visible-text deltas. Returns an unsubscribe fn. */
export function onVoiceDelta(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Fan a visible-text delta out to subscribers. Fully guarded: a listener that
 * throws must never break the streaming path that called it. When no voice
 * subscriber is wired (text threads, boot windows) this is a cheap Set-size
 * check and returns at once — but the turn loop ALSO guards the call behind
 * `isThreadVoiceActive`, so text threads never even reach here.
 */
export function emitVoiceDelta(evt: VoiceDeltaEvent): void {
  if (listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(evt);
    } catch {
      // Swallow — a voice subscriber must not break the LLM stream.
    }
  }
}

/** Test-only reset. */
export function __resetVoiceDeltaListeners(): void {
  listeners.clear();
}
