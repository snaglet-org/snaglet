import type { MouseEvent, SyntheticEvent } from 'react';

/** Links, chips, buttons and fields inside a table cell keep their own clicks. */
const INNER_CONTROL = 'a, button, input, select, textarea, [role="button"]';

/**
 * Whether a click on a table cell (a sortable header, a long body cell) is a
 * click on the cell itself. Not when React bubbled it up from a portal
 * rendered inside the cell (a chip's preview dialog), not on a control inside
 * other than the cell's own (`ownControl`, matched as a selector), and not
 * the end of a text selection in the cell. A press on the cell's own control
 * always counts, whatever text is selected.
 */
export function isCellClick(event: MouseEvent<HTMLElement>, ownControl: string): boolean {
  const cell = event.currentTarget;
  const target = event.target as Element;
  if (!cell.contains(target)) return false;
  const control = target.closest(INNER_CONTROL);
  if (control && cell.contains(control)) return control.matches(ownControl);
  const selection = window.getSelection();
  return (
    !selection ||
    selection.isCollapsed ||
    !(cell.contains(selection.anchorNode) || cell.contains(selection.focusNode))
  );
}

/**
 * Double-clicks on the table's controls stay here: a doc's preview switches
 * to edit mode on a double-click, and two quick sorts or toggles make one.
 */
export const keepDoubleClick = (event: SyntheticEvent) => event.stopPropagation();
