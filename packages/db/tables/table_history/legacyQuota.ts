/**
 * Journaled undo steps can hold repeat quotas ("a number of times" repeats,
 * tallied with `counted` log rows carrying a `done_on` day), a shape Snaglet does
 * not support. Replaying one would write a tally as a plain `done` of the
 * period (or raise a hook event with an unknown action), so undo/redo treats
 * such an op as a no-op: nothing is checked, written or announced for it.
 */
import type { RepeatOp, StoredOccurrence } from './types';

/** A log row journaled with a tally day; `doneOn` is not part of the type. */
function isTallyRow(row: StoredOccurrence): boolean {
  const doneOn = (row as StoredOccurrence & { doneOn?: string | null }).doneOn;
  return doneOn !== undefined && doneOn !== null;
}

/** A repeat value journaled with a `quota` key. */
function hasQuota(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'quota' in value;
}

/** Whether `op` was journaled by the removed quota feature (see the module note). */
export function isLegacyQuotaRepeatOp(op: RepeatOp): boolean {
  const action = op.occurrence?.action as string | undefined;
  return (
    action === 'counted' ||
    hasQuota(op.before) ||
    hasQuota(op.after) ||
    op.added.some(isTallyRow) ||
    op.removed.some(isTallyRow)
  );
}
