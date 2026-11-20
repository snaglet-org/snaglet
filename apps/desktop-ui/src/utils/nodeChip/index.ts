// Barrel — import the whole node-chip toolkit from one place:
//
//   import {
//     NODE_CHIP_MIME,
//     type NodeChipData, type ChipKind,
//     writeChipDragData, readChipDragData, hasChipDragData,
//     KIND_TO_SCHEME, isIncludableKind, fallbackTitleForKind,
//     nodeTitle,
//     chipHrefForNode, nodeToChipMarkdown,
//   } from '@desktop/utils/nodeChip';

export {
  NODE_CHIP_MIME,
  isChipKind,
  writeChipDragData,
  readChipDragData,
  hasChipDragData,
  setActiveDragChip,
  chipDragListOf,
  writeChipDragList,
  readChipDragList,
  type ChipKind,
  type NodeChipData,
} from './payload';

export { fallbackTitleForKind, isRetiredKind } from './kinds';
export { acceptDroppedChips } from './chipDrop';

export { nodeTitle } from './title';
export { parseEntryChipId } from './entry';

export {
  chipHrefForNode,
  escapeChipTitle,
  nodeToChipMarkdown,
  toggleChipIncludeInMarkdown,
  unescapeChipTitle,
} from './markdown';

export { useChipDropTarget } from './useChipDropTarget';

export { expandTransclusions } from './expandTransclusions';

export { setChipDragPayload, writeChipDragPayload, clearChipDragPayload } from './chipDragSource';
