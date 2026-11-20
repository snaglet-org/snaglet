/**
 * unattendedGate — what an unattended run (one an automation or a hook
 * started) does with a tool call that would ask a person to confirm. Nobody is
 * there to answer, so the run never waits: the call either runs or is skipped
 * with a tool error the agent can route around, and the run carries on.
 *
 * A call asks for one of two reasons (toolDispatch.ts splits them):
 *
 *   - the tool asks first: its "ask first" flag (thread / agent tool
 *     override, MCP server policy) is set, though the agent's tool access
 *     allows the call;
 *   - the access rules ask: an allow-list miss, or a command / path / SQL no
 *     allow rule covers. Answering it would grant the agent something its
 *     access does not.
 *
 * `auto-approve-allowed` runs a call only in the first case. The second is
 * skipped under either policy, so the setting never widens access; it only
 * keeps the run from blocking. It also bypasses the tool's ask-first flag for
 * every tool the agent may use, `hook` op `update`/`enable` for a guarded
 * agent included. A message from anyone else (a person, another agent) in the
 * thread since the run started means the call may be acting on their words:
 * nothing is auto-approved then. Pure: no I/O, so every branch is unit-tested.
 */
import type { UnattendedWake } from '@snaglet/shared/types';
import { readToolOp } from '@snaglet/shared/utils';

export type UnattendedDecision =
  | { action: 'auto-approve' }
  | {
      action: 'skip';
      /**
       * `policy`: the policy is `skip`. `access`: the policy would approve,
       * but the agent's tool access itself asks about this call. `person`: the
       * policy would approve, but someone else (a person or another agent)
       * posted in the thread since the run started.
       */
      cause: UnattendedSkipCause;
    };

export type UnattendedSkipCause = 'policy' | 'access' | 'person';

export interface UnattendedCallInput {
  unattended: UnattendedWake;
  /**
   * The access rules ask about this call (a permission `ask` verdict or an
   * allow-list escalation), as opposed to the tool's own ask-first flag.
   */
  accessAsks: boolean;
  /**
   * Someone else (a person or another agent) posted in the thread since the
   * run started (checked only when it matters).
   */
  personPresent?: boolean;
}

export function decideUnattendedCall(input: UnattendedCallInput): UnattendedDecision {
  if (input.unattended.policy !== 'auto-approve-allowed') {
    return { action: 'skip', cause: 'policy' };
  }
  if (input.accessAsks) return { action: 'skip', cause: 'access' };
  if (input.personPresent) return { action: 'skip', cause: 'person' };
  return { action: 'auto-approve' };
}

/** The tool as a line names it: `shell (run)` for an op call, else `shell`. */
export function unattendedToolLabel(toolId: string, input: Record<string, unknown>): string {
  const op = readToolOp(input);
  return op ? `${toolId} (${op})` : toolId;
}

/** Where the run came from, as the thread line names it. */
function originLabel(unattended: UnattendedWake): string {
  return `${unattended.source} "${unattended.name}"`;
}

/**
 * The tool error a skipped call returns: says the call did not run, why, and
 * that the run goes on, so the agent routes around it instead of retrying.
 */
export function unattendedSkipMessage(
  toolLabel: string,
  cause: UnattendedSkipCause,
  accessReason?: string
): string {
  const why =
    cause === 'access'
      ? `it needs a person to confirm (${accessReason ?? 'not allowed outright by your tool access'})`
      : 'it needs a person to confirm';
  return (
    `Tool '${toolLabel}' was not run: ${why}; skipped (unattended run, nobody is there to ` +
    'approve it). Carry on without it, or leave this step for a person.'
  );
}

/** The `[unattended] …` thread line's text after its prefix. */
export function unattendedLineBody(args: {
  decision: UnattendedDecision;
  toolLabel: string;
  agentName: string;
  unattended: UnattendedWake;
}): string {
  const { decision, toolLabel, agentName, unattended } = args;
  const head = `${decision.action === 'auto-approve' ? 'auto-approved' : 'skipped'} ${toolLabel}`;
  const note =
    decision.action === 'auto-approve'
      ? ''
      : decision.cause === 'access'
        ? ' · not allowed outright by tool access'
        : decision.cause === 'person'
          ? ' · someone else posted in this thread, so nothing is auto-approved'
          : ' · needs a person to confirm';
  return `${head} · ${agentName} · ${originLabel(unattended)}${note}`;
}
