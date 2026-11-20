/**
 * Turns a drop's `DataTransfer` into the literal HandlerEditor inserts.
 * Payloads, tried in order:
 *   1. `EDITOR_CHIP_MIME`: the chip already holds the quoted literal.
 *   2. `NODE_CHIP_MIME` (or its `PANE_ITEM_MIME` fallback): every dragged
 *      row's quoted id, comma-separated in selection order.
 *   3. `PANE_ITEM_MIME` via `resolveDetailSelectionId`, for agent, hook and
 *      file rows.
 * Returns `null` when nothing is recognizable. The caller has already
 * claimed the drop by then, so null means "nothing to insert".
 */
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { safeJsonParse } from '@snaglet/shared/utils';
// Imported from payload directly: the utils/nodeChip barrel reaches
// `@desktop/utils/api`'s side-effecting config load, which breaks unit tests.
import { hasChipDragData, readChipDragList } from '@desktop/utils/nodeChip/payload';
import { acceptDroppedChips } from '@desktop/utils/nodeChip/chipDrop';
import { hasEditorChipDragData, quoteStringLiteral, readEditorChipDragData } from './editorChip';
import { resolveDetailSelectionId } from './resolveDetailSelectionId';

/**
 * Whether this drag carries a payload the editor knows how to insert.
 * HandlerEditor's dragover/drop handlers gate on this before calling
 * `preventDefault`/`stopPropagation` — an unrecognized drag (e.g. a plain
 * OS file drop) is left alone so it isn't hijacked.
 */
export function isRecognizedEditorDrop(dt: DataTransfer): boolean {
  return hasEditorChipDragData(dt) || hasChipDragData(dt);
}

export function resolveDropInsertText(dt: DataTransfer): string | null {
  const chip = readEditorChipDragData(dt);
  if (chip) return chip.text;

  const list = readChipDragList(dt);
  if (list) {
    const chips = acceptDroppedChips(list);
    if (chips.length > 0) return chips.map((node) => quoteStringLiteral(node.id)).join(', ');
  }

  const paneRaw = dt.getData(PANE_ITEM_MIME);
  if (paneRaw) {
    const resolved = resolveDetailSelectionId(safeJsonParse<unknown>(paneRaw, null));
    if (resolved) return quoteStringLiteral(resolved.id);
  }

  return null;
}
