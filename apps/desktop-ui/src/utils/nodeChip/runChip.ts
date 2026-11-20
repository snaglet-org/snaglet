/**
 * runChip.ts — display helpers for `run` chips.
 *
 * A run is execution history, not a workspace node (there is no `run` member
 * in `public.node_type`), so it has no title to resolve and no node to open.
 * The only shared display concern is how its id is shortened, which must match
 * everywhere the same run appears — the sidebar rows and the activity bubble.
 */

/**
 * Short display form of a run id.
 *
 * Run ids are bare `randomUUID()` values — `3f2a1b4c-5d6e-4f70-…` — created in
 * `turnLoop.ts`. They carry no kind prefix and no timestamp, so the useful
 * short form is the leading group, matching the familiar short-SHA convention
 * (and what `git` / most UUID surfaces show). Eight hex chars is ~4.3 billion
 * values: ample to tell apart the handful of runs visible in a thread.
 *
 * Ids shorter than the first group are returned unchanged rather than sliced
 * into something misleading.
 */
export function shortRunId(id: string): string {
  if (!id) return id;
  const firstGroup = id.split('-')[0];
  // A UUID's first group is 8 chars; anything shorter is already compact.
  return firstGroup.length >= 8 ? firstGroup : id;
}
