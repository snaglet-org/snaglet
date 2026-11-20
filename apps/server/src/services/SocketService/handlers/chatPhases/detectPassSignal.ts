/**
 * detectPassSignal: pure classifier for explicit end-of-turn pass tokens.
 *
 * Anchored semantics: `[PASS]` / `[DONE]`
 * count only when the token is the entire reply or the trailing token of the
 * reply (trimmed) — i.e. the message ends with it, optionally after real
 * content ("Nothing further from me.\n\n[PASS]"). Mid-prose occurrences are
 * inert: an agent *writing about* passing ("I will [PASS] on naming, but…")
 * does not end its turn. A token followed by more prose is likewise inert —
 * a terminal signal must be terminal.
 *
 * When a trailing token follows real content, `strippedReply` carries the
 * content with the token removed: the caller posts that remainder as the
 * agent's parting message and marks the agent passed (finalReply.ts), so
 * "final handoff note + [PASS]" neither loses the note nor keeps the agent
 * live.
 *
 * Gated on `isContinuationRound` — the first round can never pass (there is
 * nothing to yield to yet).
 *
 * Repetition (stagnation) detection lives separately in `detectStagnation.ts`
 * (semantic, async, strike policy — owned by finalReply.ts).
 */

/** Matches a trailing [PASS]/[DONE] at the very end of a trimmed reply. */
const TRAILING_PASS_TOKEN = /\[(?:PASS|DONE)\]$/i;

export interface PassSignal {
  /** Trimmed reply (whitespace stripped from both ends). */
  trimmedReply: string;
  /**
   * True if the reply is exactly a pass token, or ends with one.
   * Only true on continuation rounds.
   */
  isExplicitPass: boolean;
  /**
   * The reply with the trailing pass token removed (trimmed). Empty for a
   * pure pass; the parting-message content otherwise. Equals `trimmedReply`
   * when no pass was detected.
   */
  strippedReply: string;
}

export function detectPassSignal(finalReply: string, isContinuationRound: boolean): PassSignal {
  const trimmedReply = finalReply.trim();
  const isExplicitPass = isContinuationRound && TRAILING_PASS_TOKEN.test(trimmedReply);
  const strippedReply = isExplicitPass
    ? trimmedReply.replace(TRAILING_PASS_TOKEN, '').trim()
    : trimmedReply;

  return { trimmedReply, isExplicitPass, strippedReply };
}
