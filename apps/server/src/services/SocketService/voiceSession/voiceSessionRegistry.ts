/**
 * voiceSessionRegistry — a dependency-light record of which threads currently
 * have an active voice session, split along the dictate/speak seam.
 *
 * Deliberately tiny and import-free (just two Maps) so it can be read from the
 * turn-context assembly hot path (contextAssembly.ts) without dragging the
 * whole voice/session/engine graph into the prompt composer — and without any
 * import cycle. VoiceSessionService is the sole writer.
 *
 * Two independently-tracked concerns (a thread can have both, or either, set of
 * clients non-empty at once):
 *   - Mic clients (`dictate` flag on): read by VoiceSessionService's
 *     thread-level mic-takeover lock. A speak-only session holds no mic, so it
 *     is never added here — it neither contends for nor is subject to that
 *     lock.
 *   - Speak clients (`speak` flag on): read by `isThreadVoiceActive`, which
 *     gates everything that is about the thread being spoken aloud —
 *     floor-gated generation + the TTS delta tap (turnLoop.ts), barge-in
 *     tool/speech phase tracking
 *     (runPhaseTracker.ts), and the per-turn VOICE_PROFILE_BLOCK
 *     (composeTurnContextTail.ts). None of those care about the mic.
 *
 * A thread can be reference-counted > 1 in principle (two clients), so we track
 * per-thread client sets rather than booleans.
 */

const micClientsByThread = new Map<string, Set<string>>();
const speakClientsByThread = new Map<string, Set<string>>();

function addTo(map: Map<string, Set<string>>, threadId: string, clientId: string): void {
  let set = map.get(threadId);
  if (!set) {
    set = new Set<string>();
    map.set(threadId, set);
  }
  set.add(clientId);
}

function removeFrom(map: Map<string, Set<string>>, threadId: string, clientId: string): void {
  const set = map.get(threadId);
  if (!set) return;
  set.delete(clientId);
  if (set.size === 0) map.delete(threadId);
}

/** Mark that `clientId` opened a voice session on `threadId`, per-flag. */
export function markThreadVoiceActive(
  threadId: string,
  clientId: string,
  flags: { dictate: boolean; speak: boolean }
): void {
  if (flags.dictate) addTo(micClientsByThread, threadId, clientId);
  if (flags.speak) addTo(speakClientsByThread, threadId, clientId);
}

/** Drop `clientId`'s voice session on `threadId` from both sets (idempotent —
 *  removing from a set the client was never in is a no-op). */
export function unmarkThreadVoiceActive(threadId: string, clientId: string): void {
  removeFrom(micClientsByThread, threadId, clientId);
  removeFrom(speakClientsByThread, threadId, clientId);
}

/**
 * True while at least one client's session on the thread has `speak` on — the
 * thread is currently being spoken aloud. See the class doc for the full list
 * of behavior this gates; all of it is about the speaking side.
 */
export function isThreadVoiceActive(threadId: string): boolean {
  return (speakClientsByThread.get(threadId)?.size ?? 0) > 0;
}

/**
 * Snapshot of the client ids holding the mic (dictate) on `threadId` — a copy
 * (not the live Set) so callers can tear sessions down while iterating (used
 * by the thread-level mic-takeover lock). Speak-only clients never appear here.
 */
export function micClientsForThread(threadId: string): string[] {
  return Array.from(micClientsByThread.get(threadId) ?? []);
}

/** Test-only reset. */
export function __resetVoiceRegistry(): void {
  micClientsByThread.clear();
  speakClientsByThread.clear();
}
