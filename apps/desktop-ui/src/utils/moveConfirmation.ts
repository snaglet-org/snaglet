/**
 * Global "move confirmation" banner bus.
 *
 * Drops in the workspace tree fire `showMoveConfirmation({...})` when the
 * destination was collapsed (i.e. the user couldn't visually verify the
 * move). The `<MoveConfirmationBanner />` host listens for the event and
 * renders a single dashboard-level banner that auto-dismisses after a
 * few seconds. A new firing replaces any previous banner so only the
 * most recent move is surfaced.
 */

const MOVE_CONFIRMATION_EVENT = 'snaglet:move-confirmation';

export interface MoveConfirmationDetail {
  /** Human-readable label of the moved node (e.g. doc title, task title). */
  sourceLabel: string;
  /** Human-readable label of the destination (e.g. project / container / task name). */
  destinationLabel: string;
  /**
   * Optional second-segment qualifier appended after an arrow — used when
   * the destination has internal structure that's worth surfacing (e.g. a
   * status bucket inside a project, or a parent task's project).
   */
  destinationDetail?: string;
  /**
   * Kind of the source node (`doc`, `task`, `container`, etc.). Currently
   * informational only — reserved for future per-kind icons / phrasing.
   */
  sourceKind?: string;
  /**
   * Optional destination node id. Reserved for the "View" action so the
   * tree can reveal the destination on click. Not yet wired.
   */
  destinationId?: string | null;
  /** Total auto-dismiss duration in ms. Defaults to 3500. */
  durationMs?: number;
}

export function showMoveConfirmation(detail: MoveConfirmationDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<MoveConfirmationDetail>(MOVE_CONFIRMATION_EVENT, { detail })
  );
}

export const MOVE_CONFIRMATION_EVENT_NAME = MOVE_CONFIRMATION_EVENT;
