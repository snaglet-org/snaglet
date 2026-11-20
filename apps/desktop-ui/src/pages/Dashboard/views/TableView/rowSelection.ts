import type { CheckboxModifiers } from '@desktop/components';

/**
 * The row a Shift-click ranges from. `base` is the selection just before the
 * first Shift-click from this anchor, so the next Shift-click re-ranges from
 * it instead of piling ranges up (Finder's rule); null until then.
 */
export interface RowSelectionAnchor {
  id: string;
  base: ReadonlySet<string> | null;
}

interface RowSelectionInput {
  /** The rows in the order shown (after sort, filter and search). */
  order: readonly string[];
  selected: ReadonlySet<string>;
  anchor: RowSelectionAnchor | null;
  /** The row whose checkbox was toggled, and its toggled state. */
  id: string;
  checked: boolean;
  modifiers: Pick<CheckboxModifiers, 'shiftKey' | 'metaKey' | 'ctrlKey'>;
}

/**
 * The selection after toggling one row's checkbox.
 *
 * A plain (or Cmd/Ctrl) toggle flips that row and makes it the anchor. A
 * Shift-toggle sets every row from the anchor to this one, in the order
 * shown, to the anchor's state (checked, or unchecked) and keeps the anchor.
 * With no anchor on screen, a Shift-toggle is a plain toggle.
 */
export function nextRowSelection({
  order,
  selected,
  anchor,
  id,
  checked,
  modifiers,
}: RowSelectionInput): { ids: Set<string>; anchor: RowSelectionAnchor } {
  const ranging = modifiers.shiftKey && !modifiers.metaKey && !modifiers.ctrlKey;
  const from = ranging && anchor ? order.indexOf(anchor.id) : -1;
  const to = order.indexOf(id);
  if (!anchor || from < 0 || to < 0) {
    const ids = new Set(selected);
    if (checked) ids.add(id);
    else ids.delete(id);
    return { ids, anchor: { id, base: null } };
  }
  const base = anchor.base ?? selected;
  const on = base.has(anchor.id);
  const ids = new Set(base);
  for (const row of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    if (on) ids.add(row);
    else ids.delete(row);
  }
  return { ids, anchor: { id: anchor.id, base } };
}
