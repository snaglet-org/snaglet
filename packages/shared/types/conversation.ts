/**
 * Conversation-lifecycle types shared between the dispatch loop, realtime
 * frames, and the chat UI.
 */

/**
 * Why a dispatch conversation (one wave loop) ended. Emitted for every
 * ending: persisted as a `conversation_ended` thread event (group threads and
 * abnormal solo endings), attached to the DispatchResult, and carried in the
 * structured end-of-run log line.
 *
 *  - `all-passed`            natural convergence — every agent passed
 *  - `stagnation`            all passed, and at least one agent's final pass
 *                            was a repetition auto-pass
 *  - `wave-cap`              the effective maxWaves limit stopped the loop
 *  - `token-budget`          conversation output-token budget exhausted
 *  - `tool-iteration-budget` not emitted; kept so stored `conversation_ended`
 *                            events carrying this reason still render
 *  - `user-abort`            a user (or attributed actor) stopped the run
 *  - `reaper`                the run watchdog force-released a wedged run
 *  - `summary-model-unavailable`
 *                            the thread's summary model is missing or erroring,
 *                            so the run was stopped rather than continuing with
 *                            an un-compacted payload (see summaryHalt)
 *  - `error`                 the wave loop terminated on an unhandled error
 */
export type ConversationStopReason =
  | 'all-passed'
  | 'stagnation'
  | 'wave-cap'
  | 'token-budget'
  | 'tool-iteration-budget' // not emitted (see doc above)
  | 'user-abort'
  | 'reaper'
  | 'summary-model-unavailable'
  | 'error';

/**
 * How an individual agent left the conversation. Tracked per agent (last
 * write wins) so the ending can be attributed — e.g. an all-passed ending
 * where someone's final pass was `stagnation` reports `stagnation`.
 */
export type ConversationPassKind =
  | 'explicit' // said [PASS]/[DONE]
  | 'stagnation' // repetition auto-pass
  | 'auto' // replied, nobody re-mentioned them (post-wave auto-pass)
  | 'ceiling' // per-agent dispatch ceiling
  | 'abort' // targeted abort ended their participation
  | 'error'; // their turn errored/timed out and was treated as a pass

/** Human copy for each stop reason (chat ending line + UI). */
export const CONVERSATION_STOP_REASON_COPY: Record<ConversationStopReason, string> = {
  'all-passed': 'everyone passed',
  stagnation: 'repetition detected — agents were repeating themselves',
  'wave-cap': 'wave limit reached',
  'token-budget': 'output budget reached',
  // Not emitted; kept so stored events still render.
  'tool-iteration-budget': 'tool budget reached',
  'user-abort': 'stopped',
  reaper: 'released by the run watchdog',
  'summary-model-unavailable': 'stopped — the summary model is unavailable',
  error: 'ended on an error',
};

/**
 * Stop reasons where sending a new message simply continues the
 * conversation with a fresh budget — the UI appends an affordance hint.
 */
export const CONVERSATION_STOP_CONTINUABLE: ReadonlySet<ConversationStopReason> = new Set([
  'wave-cap',
  'token-budget',
  // Not emitted; a stored event with this reason is still continuable.
  'tool-iteration-budget',
]);
