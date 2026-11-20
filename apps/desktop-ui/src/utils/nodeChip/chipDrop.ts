import { showToast } from '../toast';
import { isMultiChipDrag, type ChipDragList, type NodeChipData } from './payload';

/** The toast a multi-item drop shows for the items its target could not reference. */
export const skippedChipsMessage = (count: number): string =>
  `Skipped ${count} ${count === 1 ? 'item' : 'items'} that can't be linked here`;

/**
 * The chips a drop target takes from a drag, in selection order. Items the
 * target cannot reference (`accepts` says no, or the item has no chip form)
 * are skipped; a multi-item drag says so with one short toast. A single-item
 * drag the target refuses stays silent, as it always was — each target
 * already handles that case its own way.
 */
export function acceptDroppedChips(
  list: ChipDragList,
  accepts: (chip: NodeChipData) => boolean = () => true
): NodeChipData[] {
  const chips = list.chips.filter(accepts);
  const skipped = list.unlinkable + list.chips.length - chips.length;
  if (skipped > 0 && isMultiChipDrag(list)) showToast(skippedChipsMessage(skipped));
  return chips;
}
