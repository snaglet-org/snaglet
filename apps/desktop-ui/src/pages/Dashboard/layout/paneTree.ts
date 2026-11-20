/**
 * Layout tree for the Dashboard's main pane area.
 *
 * Public surface of the pane-tree modules (types, repair, history,
 * mutation, queries) — kept as a barrel so existing './paneTree'
 * importers and tests keep working.
 */

export type {
  PaneHistory,
  LayoutLeaf,
  SplitDirection,
  LayoutSplit,
  LayoutNode,
} from './paneTreeTypes';
export {
  PANE_RATIO_PRECISION,
  PANE_MIN_RATIO,
  repairPaneLayout,
  reportPaneLayoutRepairs,
} from './paneLayoutRepair';
export {
  replaceLeafSelection,
  canGoBackInLeaf,
  canGoForwardInLeaf,
  jumpToHistoryEntry,
  goBackInLeaf,
  goForwardInLeaf,
  historyMenuRows,
  type HistoryMenuRow,
} from './paneHistory';
export {
  createLeaf,
  splitLeafWithResult,
  splitLeaf,
  closeLeaf,
  updateSplitRatios,
  type DropZone,
} from './paneTreeMutation';
export {
  findLeaf,
  mapSelections,
  leafIds,
  activePaneSelectionIds,
  openNodeIds,
  serializePaneLayout,
} from './paneTreeQueries';
