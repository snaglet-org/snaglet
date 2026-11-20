/**
 * unattendedWake — whether a dispatch started with nobody there to answer a
 * tool confirmation, and what its runs do about a call that would ask.
 *
 * A dispatch is unattended when:
 *   - an automation woke it: dispatchToThread's `wakeOrigin`;
 *   - a hook's message woke it: a message a hook's code sends (`thread` op
 *     `send`) dispatches inside the hook's run context, whose hook chain names
 *     the hooks that led to it. A self-healing redispatch binds the chain
 *     stamped on the queued messages, so it reads the same way;
 *   - it starts from inside an unattended dispatch (`enclosing`): a helper, a
 *     thread send, a result wake. It carries the origin's marker.
 *
 * The policy is the stored `unattended_policy`, made safe:
 *   - with several hooks in the chain, the strictest one wins (any hook that
 *     is not `auto-approve-allowed`, or is not registered, makes it `skip`);
 *   - `capped` (an agent started or caused it: its tool call, its Run now, its
 *     `hook` op `run`, its message; or a person's message rides in the same
 *     wave), an agent-started automation wake, and any dispatch downstream of
 *     an unattended run are `skip` whatever is stored.
 *
 * Resolved once, at the dispatch entry, carried on the deps to every turn and
 * bound ambiently for the wave. A row that can't be read counts as `skip`: the
 * run then never waits and never runs a call that would ask.
 */
import { Automations } from '@snaglet/db/tables/automations';
import { HookRegistrations } from '@snaglet/db/tables/hook_registrations';
import {
  DEFAULT_UNATTENDED_POLICY,
  type UnattendedPolicy,
  type UnattendedWake,
  type WakeOrigin,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';

export interface ResolveUnattendedWakeInput {
  /** The dispatch's wake marker (an automation), when it has one. */
  wakeOrigin?: WakeOrigin;
  /** The hook chain the dispatch runs in (oldest first; empty = none). */
  hookChain: readonly string[];
  /** The marker of the unattended dispatch this one starts from, if any. */
  enclosing?: UnattendedWake;
  /** An agent started or caused this dispatch, or a person rides in it. */
  capped?: boolean;
  /** For tests; defaults to now. */
  now?: Date;
}

async function automationPolicy(id: string): Promise<{ name: string; policy: UnattendedPolicy }> {
  try {
    const row = await Automations.findById(id);
    return { name: row?.name ?? id, policy: row?.unattendedPolicy ?? DEFAULT_UNATTENDED_POLICY };
  } catch (err) {
    LogsService.warn('[unattended] automation policy lookup failed; skipping calls that ask', {
      automationId: id,
      error: getErrorMessage(err),
    });
    return { name: id, policy: DEFAULT_UNATTENDED_POLICY };
  }
}

/** The strictest policy of the hooks in the chain: `auto-approve-allowed` only if every one is. */
async function hookChainPolicy(names: readonly string[]): Promise<UnattendedPolicy> {
  try {
    for (const name of new Set(names)) {
      const row = await HookRegistrations.findByName(name);
      if (row?.unattendedPolicy !== 'auto-approve-allowed') return 'skip';
    }
    return 'auto-approve-allowed';
  } catch (err) {
    LogsService.warn('[unattended] hook policy lookup failed; skipping calls that ask', {
      hooks: [...names],
      error: getErrorMessage(err),
    });
    return 'skip';
  }
}

/** The dispatch's unattended marker, or undefined when a person started it. */
export async function resolveUnattendedWake(
  input: ResolveUnattendedWakeInput
): Promise<UnattendedWake | undefined> {
  const since = (input.now ?? new Date()).toISOString();
  let own: UnattendedWake | undefined;
  if (input.wakeOrigin?.kind === 'automation') {
    const id = input.wakeOrigin.automationId;
    own = { source: 'automation', id, since, ...(await automationPolicy(id)) };
  } else {
    const hookName = input.hookChain[input.hookChain.length - 1];
    if (hookName) {
      own = {
        source: 'hook',
        id: hookName,
        name: hookName,
        policy: await hookChainPolicy(input.hookChain),
        since,
      };
    }
  }

  const marker = own ?? (input.enclosing ? { ...input.enclosing, since } : undefined);
  if (!marker) return undefined;
  const capped =
    input.capped === true ||
    input.wakeOrigin?.agentStarted === true ||
    // Downstream of an unattended run: an agent's action started it.
    own === undefined;
  return capped ? { ...marker, policy: 'skip' } : marker;
}
