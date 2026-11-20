// Mid-run injection policy — given the thread's dispatch mode, who sent the
// message, and (for peers) whether the running agent was @mentioned, decide
// whether a message that arrives during a run is injected live (at the next
// client-tool seam) or deferred to the agent's next turn. Pure + unit-tested;
// the turnLoop wiring consumes the verdict.
//
// The governing principle: dispatch mode governs AGENT-TO-AGENT noise, not the
// human's own voice. A person typing to a running agent always wants to be
// heard now, so a direct USER message injects live in every mode. Peer
// (agent → agent) messages follow the thread's routing mode.
//
// Full (mode × sender) matrix — the ruled behavior:
//
//   mode         | user sender | system (thread state) | peer sender (agent → agent)
//   -------------|-------------|-----------------------|----------------------------
//   all          | inject      | inject                | inject      (full transparency)
//   mentioned    | inject      | inject                | inject if @mentioned, else defer
//   unknown      | inject      | inject                | defer       (conservative)
//
// SYSTEM is the thread's own narrated state changes (threadEvents: model,
// routing mode, budgets, wave cap, run time limit, voice/vision). It is not a
// participant speaking, so no routing rule applies to it — an agent that keeps
// running under a state that just changed is working from a stale premise, in
// every mode. Always inject.

export type DispatchMode = 'all' | 'mentioned' | (string & {});
export type InjectionDecision = 'inject' | 'defer';
/**
 * Who authored the mid-run message: the human user, a peer agent, or the
 * platform narrating a thread-state change (author-less `thread_event`).
 */
export type SenderKind = 'user' | 'peer' | 'system';

export function decideMidRunInjection(
  mode: DispatchMode,
  senderKind: SenderKind,
  isMentioned: boolean
): InjectionDecision {
  // Thread-state narration is mode-independent — see the SYSTEM note above.
  if (senderKind === 'system') return 'inject';
  // The user's own voice always reaches a running agent, in every mode.
  if (senderKind === 'user') return 'inject';
  // Peer (agent → agent) messages follow the thread's routing mode:
  if (mode === 'all') return 'inject';
  if (mode === 'mentioned') return isMentioned ? 'inject' : 'defer';
  // Any unknown mode: stay conservative, defer to next turn.
  return 'defer';
}
