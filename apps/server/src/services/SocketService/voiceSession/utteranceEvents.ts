/**
 * utteranceEvents — an in-process pub/sub for persisted agent utterances.
 *
 * The cleanest tap: instead of re-reading
 * the socket:delta stream or the DB, `persistUtterance` (which already writes the
 * row and broadcasts socket:chat:message_created) makes ONE additive, optional
 * call to `emitUtterancePersisted` right after it broadcasts. The voice TTS
 * pipeline subscribes here. When no voice session is listening this is a no-op,
 * so the touch to the just-shipped utteranceMessages.ts stays inert for text-only
 * threads.
 *
 * Kept import-free (no wsService/engine/DB) so utteranceMessages.ts can import it
 * with zero cycle risk. `kind` is DERIVED here from what persistUtterance already
 * knows (usage presence + log label) — no extra argument threaded through the
 * hot path.
 */

type UtteranceKind = 'interim' | 'terminal' | 'partial-abort';

export interface UtterancePersistedEvent {
  readonly threadId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly messageId: string;
  /** Visible, thinking-stripped text of the utterance. */
  readonly content: string;
  readonly kind: UtteranceKind;
}

/** Raw fields persistUtterance passes; kind is derived from them. */
export interface EmitUtteranceInput {
  readonly threadId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly content: string;
  readonly hasUsage: boolean;
  readonly logLabel: string;
}

type Listener = (evt: UtterancePersistedEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to persisted-utterance events. Returns an unsubscribe fn. */
export function onUtterancePersisted(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function deriveKind(input: EmitUtteranceInput): UtteranceKind {
  // The abort path passes this exact label (turnLoop AbortError branch).
  if (input.logLabel.startsWith('partial utterance persisted')) return 'partial-abort';
  // Only the terminal reply carries run usage (finalReply.persistFinalReply).
  if (input.hasUsage) return 'terminal';
  return 'interim';
}

/**
 * Fan a persisted utterance out to subscribers. Fully guarded: a listener that
 * throws must never break the persist/broadcast path that called it.
 */
export function emitUtterancePersisted(input: EmitUtteranceInput): void {
  if (listeners.size === 0) return;
  const evt: UtterancePersistedEvent = {
    threadId: input.threadId,
    agentId: input.agentId,
    runId: input.runId,
    messageId: input.messageId,
    content: input.content,
    kind: deriveKind(input),
  };
  for (const listener of listeners) {
    try {
      listener(evt);
    } catch {
      // Swallow — persistence must not fail because a voice subscriber threw.
    }
  }
}

/** Test-only reset. */
export function __resetUtteranceListeners(): void {
  listeners.clear();
}
