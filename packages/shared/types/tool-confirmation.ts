/**
 * Tool confirmation — the wire schema for a tool call that is parked until a
 * human approves or denies it.
 */

export type ToolConfirmationDecision = 'approve_once' | 'allow_thread' | 'allow_agent' | 'deny';

/** server -> client: render an approve/deny panel in the owning thread. */
export interface ToolConfirmationRequestPayload {
  threadId: string;
  sessionId: string;
  callId: string;
  agentId?: string;
  toolName: string;
  /** approval = one-time requiresConfirmation gate; allow_list = policy miss. */
  mode: 'approval' | 'allow_list';
  /** Bounded, display-safe summary of the proposed tool input. */
  inputSummary: string;
}

/** client -> server: approve or deny the parked tool call. */
export interface ToolConfirmationResponsePayload {
  /** Chat session answering. Omit it (and send `threadId`) from a surface with no chat open. */
  sessionId?: string;
  threadId?: string;
  callId: string;
  decision: ToolConfirmationDecision;
}

/**
 * What an unattended run (one an automation or a hook started) does with a
 * tool call that would ask a person to confirm. Nobody is there to answer, so
 * the run never waits:
 *
 * - `skip` (the default): the call does not run; the agent gets a tool error
 *   and carries on without it.
 * - `auto-approve-allowed`: a call the agent's tool access already allows
 *   (it asks only because the tool is set to ask first) runs without the
 *   prompt. A call the access rules themselves would ask about (an allow-list
 *   miss, a command or path no allow rule covers) is still skipped: this
 *   setting never grants access, it only stops the run from blocking.
 *
 * Stored per automation (`automations.unattended_policy`) and per hook
 * (`hook_registrations.unattended_policy`).
 */
export type UnattendedPolicy = 'auto-approve-allowed' | 'skip';

export const UNATTENDED_POLICIES: readonly UnattendedPolicy[] = ['skip', 'auto-approve-allowed'];

export const DEFAULT_UNATTENDED_POLICY: UnattendedPolicy = 'skip';

export function isUnattendedPolicy(value: unknown): value is UnattendedPolicy {
  return typeof value === 'string' && (UNATTENDED_POLICIES as readonly string[]).includes(value);
}

/**
 * The unattended marker a dispatch carries onto every turn it starts: what
 * started it (an automation by id, or a hook by name), a display name, and
 * the policy for calls that would ask. Absent on a run a person started.
 *
 * `policy` is the EFFECTIVE policy: already capped at `skip` for any start an
 * agent triggered (Run now, `hook` op `run`, an event an agent caused, a
 * dispatch from an agent's tool call, a run downstream of an unattended run)
 * and for a wave that also carries a person's message.
 */
export interface UnattendedWake {
  source: 'automation' | 'hook';
  /** The automation id, or the hook's name (hooks are keyed by name). */
  id: string;
  /** The automation's or hook's name, for the `[unattended]` thread line. */
  name: string;
  policy: UnattendedPolicy;
  /**
   * When the marker was resolved (ISO). A person's message in the thread
   * after it caps the run at `skip`: someone is there, and their message must
   * not ride on the automation's or hook's approval.
   */
  since: string;
}
