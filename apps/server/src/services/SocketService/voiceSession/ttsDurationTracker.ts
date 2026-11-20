/**
 * ttsDurationTracker — per-utterance synthesized audio duration (ms) + the
 * spoken text that produced it, so barge-in can resolve a precise "heard up to"
 * marker even mid-stream, before the utterance has a real message row.
 *
 * The TTS pipeline records, as frames stream out, how much audio it synthesized
 * for an utterance and the (speakability-filtered) text it spoke. Barge-in
 * resolution reads both: given the client's `playedMs` and the total synthesized
 * duration it computes a word-snapped char offset into the spoken text — what the
 * user actually heard. Keying is by the pipeline's utterance id,
 * which during streaming synthesis is a synthetic id (`${runId}:${iteration}`)
 * because audio starts before the message row exists. When
 * the utterance persists, `reconcileUtteranceId` aliases the real messageId onto
 * the same entry so a lookup by either id resolves — and so a barge-in that only
 * ever saw the synthetic id still quotes correctly, and the DB-row fallback can
 * find the persisted row.
 *
 * Import-free leaf module so both the pipeline (writer) and bargeIn (reader) can
 * depend on it without cycles. Entries are cleared on playback:done for the
 * utterance (no further barge-in against it) and on session teardown.
 */

interface UtteranceAudio {
  /** Total synthesized audio for this utterance (ms), accumulated across frames. */
  ms: number;
  /** Speakability-filtered text spoken so far, joined in synthesis order. */
  text: string;
  /** Reconciled real message id, once the utterance persists (else undefined). */
  messageId?: string;
}

/** Primary store, keyed by the pipeline's utterance id (synthetic while streaming). */
const byId = new Map<string, UtteranceAudio>();
/** Alias: reconciled messageId → primary (synthetic) id. */
const aliasToPrimary = new Map<string, string>();

/** Resolve any id (synthetic or reconciled messageId) to its primary entry key. */
function primaryKey(id: string): string {
  return aliasToPrimary.get(id) ?? id;
}

function ensure(id: string): UtteranceAudio {
  const key = primaryKey(id);
  let entry = byId.get(key);
  if (!entry) {
    entry = { ms: 0, text: '' };
    byId.set(key, entry);
  }
  return entry;
}

/** Add synthesized audio for an utterance (accumulates across frames). */
export function addSynthesizedMs(utteranceId: string, ms: number): void {
  ensure(utteranceId).ms += ms;
}

/** Append spoken (speakability-filtered) text for an utterance, in synth order. */
export function addSpokenText(utteranceId: string, text: string): void {
  const entry = ensure(utteranceId);
  entry.text = entry.text ? `${entry.text} ${text}` : text;
}

/**
 * Reconcile a streaming utterance's synthetic id to its real messageId at persist
 * time: alias the messageId onto the same entry so lookups by either id resolve.
 * No-op when no entry exists for the synthetic id (nothing streamed).
 */
export function reconcileUtteranceId(syntheticId: string, messageId: string): void {
  if (syntheticId === messageId) return;
  const key = primaryKey(syntheticId);
  const entry = byId.get(key);
  if (!entry) return;
  entry.messageId = messageId;
  aliasToPrimary.set(messageId, key);
}

/** Total synthesized ms for an utterance, or undefined if unknown. */
export function getSynthesizedMs(utteranceId: string): number | undefined {
  return byId.get(primaryKey(utteranceId))?.ms;
}

/** Spoken text synthesized so far for an utterance, or undefined if unknown. */
export function getSpokenText(utteranceId: string): string | undefined {
  return byId.get(primaryKey(utteranceId))?.text || undefined;
}

/** The reconciled real message id for an utterance id, or undefined. */
export function getReconciledMessageId(utteranceId: string): string | undefined {
  return byId.get(primaryKey(utteranceId))?.messageId;
}

/** Drop an utterance's tracked audio (playback finished — no more barge-in). */
export function clearSynthesizedMs(utteranceId: string): void {
  const key = primaryKey(utteranceId);
  const entry = byId.get(key);
  byId.delete(key);
  if (entry?.messageId) aliasToPrimary.delete(entry.messageId);
  // If cleared via the synthetic id, drop any lingering alias that pointed here.
  if (aliasToPrimary.get(utteranceId) === key) aliasToPrimary.delete(utteranceId);
}

/** Test-only reset. */
export function __resetDurations(): void {
  byId.clear();
  aliasToPrimary.clear();
}
