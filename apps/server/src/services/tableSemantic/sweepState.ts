/**
 * What the semantic-search sweep remembers between ticks, kept in a module of
 * its own with no imports so the realtime layer can tell it a table changed
 * without pulling in the embedder.
 */

/** Tables a full sweep pass has finished since the server started (cleared when turned off). */
export const completed = new Set<string>();
/** When each completed table last finished a pass. */
export const passedAt = new Map<string, number>();
/** Where the sweep resumes in each table: the last entry id it handled. */
export const cursors = new Map<string, string>();
/**
 * Tables the sweep found past the row cap without a person's confirmation:
 * on, but nothing more is built until someone confirms (their vectors stay).
 */
export const heldAtCap = new Set<string>();

/** A finished table is read again after this long even if nothing told us it changed. */
export const REPASS_AFTER_MS = 10 * 60 * 1000;

/** Tables whose rows changed while a pass was running: that pass may have missed the edit. */
const changedDuringPass = new Set<string>();

/**
 * A pass reached the end of the table. If a row changed while it ran, the
 * pass may have read that row before the edit, so it starts over instead of
 * calling the table finished.
 */
export function finishPass(tableId: string): void {
  if (changedDuringPass.delete(tableId)) {
    cursors.delete(tableId);
    return;
  }
  completed.add(tableId);
  passedAt.set(tableId, Date.now());
}

/** Forget a table: it was turned on again or off. */
export function resetTable(tableId: string): void {
  completed.delete(tableId);
  passedAt.delete(tableId);
  cursors.delete(tableId);
  changedDuringPass.delete(tableId);
  heldAtCap.delete(tableId);
}

/**
 * A table's rows changed (called from the entries-changed event): its next
 * sweep pass picks up the edit, so a finished table is no longer "ready".
 */
export function noteEntriesChanged(tableId: string): void {
  if (completed.delete(tableId)) cursors.delete(tableId);
  else if (cursors.has(tableId)) changedDuringPass.add(tableId);
}
