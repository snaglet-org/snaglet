// Pure rules for driving the chat composer from voice capture (no timers or
// DOM); the Composer wires them to setValue and a settle timer.
//  • Capture start stashes the typed draft; the transcript then overwrites the
//    value, winning over mid-capture typing.
//  • On dispatch the composer briefly shows the sent text, then restores the stash.
//  • Esc bail keeps `stash + ' ' + transcript`; a burst with no dispatch
//    reverts to the stash.
//  • Sent text is never stashed: a capture starting while settling reuses the
//    pre-settle stash, so the sent message can't reappear after the next send.

export interface VoiceDraftState {
  /** The typed draft captured at speech start, restored when capture ends. */
  readonly stash: string;
  /** Voice capture is actively driving the composer value. */
  readonly active: boolean;
  /** Showing the dispatched final in the brief settle window. */
  readonly settling: boolean;
  /** The exact dispatched text shown during the settle window. Sent text is never
   *  stash-eligible, so a capture starting mid-settle re-stashes the pre-settle
   *  draft (`stash`) rather than this. Undefined outside the settle window. */
  readonly settledText?: string;
}

export const INITIAL_VOICE_DRAFT: VoiceDraftState = { stash: '', active: false, settling: false };

export type VoiceDraftAction =
  | { type: 'start' }
  | { type: 'update'; text: string }
  | { type: 'settle'; text: string }
  | { type: 'settle-done' }
  | { type: 'bail'; text: string }
  | { type: 'revert' };

export interface VoiceDraftResult {
  readonly state: VoiceDraftState;
  /** When present, the composer value the caller must apply (setValue). */
  readonly setValue?: string;
}

/** Merge a stashed draft with a transcript: `"<stash> <transcript>"` (or just the
 *  transcript when the stash is blank). */
export function mergeStash(stash: string, text: string): string {
  return stash.trim().length > 0 ? `${stash} ${text}` : text;
}

/**
 * Merge the two STT tiers into one converging display string: the quality
 * re-decode is authoritative for what it covers; any extra trailing words from a
 * longer (later) live partial are appended provisionally until the next quality
 * upgrade absorbs them. Word-count based — the tiers differ in casing and
 * punctuation, so a character prefix wouldn't line up.
 */
export function convergeTranscript(quality: string, live: string): string {
  const q = quality.trim();
  const l = live.trim();
  if (!q) return l;
  if (!l) return q;
  const qWords = q.split(/\s+/);
  const lWords = l.split(/\s+/);
  if (lWords.length > qWords.length) return `${q} ${lWords.slice(qWords.length).join(' ')}`;
  return q;
}

/**
 * Word-churn detector for the voice "revising" cue (Apple's Speech framework
 * can change earlier words as the user keeps talking). True when `next`
 * revises `prev` (a shown word changed or words were dropped), false when it
 * only appends. Case and punctuation are ignored.
 */
export function isRevision(prev: string, next: string): boolean {
  const a = wordsForCompare(prev);
  const b = wordsForCompare(next);
  // Dropped words → the shown text shrank: a revision, not an extension.
  if (b.length < a.length) return true;
  // Any already-shown word that changed → a revision.
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

/** Lowercased, punctuation-stripped word list for revise-vs-extend comparison —
 *  the tiers differ in casing/punctuation, so compare on word identity alone. */
function wordsForCompare(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean);
}

/**
 * Advance the voice-draft state machine. `currentValue` is the composer's live
 * value (needed to stash it on 'start'). Returns the next state and, when the
 * composer value should change, the value to set.
 */
export function reduceVoiceDraft(
  state: VoiceDraftState,
  action: VoiceDraftAction,
  currentValue: string
): VoiceDraftResult {
  switch (action.type) {
    case 'start': {
      // Stash once per capture: a second 'start' mid-capture keeps the original
      // typed draft, never the transcript that has since overwritten the value.
      if (state.active) return { state };
      // A start during the settle window (or while the value is still the sent
      // text) must not stash the sent text. Reuse the pre-settle stash, show it,
      // and drop the settle so its restore can't fire mid-capture.
      const onSettledText = state.settledText !== undefined && currentValue === state.settledText;
      if (state.settling || onSettledText) {
        return {
          state: { stash: state.stash, active: true, settling: false, settledText: undefined },
          setValue: state.stash,
        };
      }
      return {
        state: { stash: currentValue, active: true, settling: false, settledText: undefined },
      };
    }
    case 'update':
      // Capture wins over any mid-capture typing: overwrite the composer value.
      return {
        state: { ...state, active: true, settling: false, settledText: undefined },
        setValue: action.text,
      };
    case 'settle':
      // Show exactly what was dispatched; the caller schedules 'settle-done'. Record
      // the settled text so a mid-settle 'start' knows the value isn't stashable.
      return {
        state: { ...state, active: false, settling: true, settledText: action.text },
        setValue: action.text,
      };
    case 'settle-done':
      return {
        state: { stash: '', active: false, settling: false, settledText: undefined },
        setValue: state.stash,
      };
    case 'bail':
      return {
        state: { stash: '', active: false, settling: false, settledText: undefined },
        setValue: mergeStash(state.stash, action.text),
      };
    case 'revert':
      // Never restore settled text: revert always returns to the (pre-settle) stash.
      return {
        state: { stash: '', active: false, settling: false, settledText: undefined },
        setValue: state.stash,
      };
    default:
      return { state };
  }
}
