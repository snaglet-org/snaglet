/**
 * Copy for the unattended-run setting (UnattendedPolicy), shared
 * by the automation Edit form and the hook builder: what a run nobody is
 * watching does with a tool call that would ask a person to confirm.
 */
import { UNATTENDED_POLICIES, type UnattendedPolicy } from '@snaglet/shared/types';

const LABELS: Record<UnattendedPolicy, string> = {
  skip: 'Skip calls that ask',
  'auto-approve-allowed': 'Run calls tool access allows',
};

export const UNATTENDED_POLICY_OPTIONS: ReadonlyArray<{ value: UnattendedPolicy; label: string }> =
  UNATTENDED_POLICIES.map((value) => ({ value, label: LABELS[value] }));

/** One line on what the setting does, for a hint or a tooltip. */
export const UNATTENDED_POLICY_HINT =
  'Nobody is there to confirm a tool call in a run this starts, so the run never waits. ' +
  "A call the agent's tool access doesn't allow outright is always skipped.";
