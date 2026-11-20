import { useEffect } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { subscribeTableEvents } from '@desktop/features/database/tableEvents';
import { mapSelections, type LayoutNode } from '../layout/paneTree';
import { mapLeaves } from '../layout/paneTreeMutation';
import type { NonNullableSelection } from '../layout/paneTreeTypes';
import type { DetailSelection } from '../selection/types';

function isDraft(selection: DetailSelection, draftId: string): boolean {
  return selection?.kind === 'table-draft' && selection.draft_id === draftId;
}

/**
 * Promote every pane and history entry showing the draft whose id matches the
 * created table into that saved table, in place — no new history entry, so
 * Back never returns to a draft whose id is already taken. Open panes already
 * showing the table pick up the fresh catalog entry for their chrome title.
 */
export function promoteTableDraft(layout: LayoutNode, table: TableCatalogEntry): LayoutNode {
  return mapSelections(layout, (selection) => {
    if (isDraft(selection, table.id)) return { kind: 'table', table_id: table.id, table };
    if (selection?.kind === 'table' && selection.table_id === table.id && !selection.table) {
      return { ...selection, table };
    }
    return selection;
  });
}

/**
 * Give every pane and history entry showing the table the renamed catalog
 * entry, so pane titles and history labels follow a rename in place.
 */
export function renameTableSelections(layout: LayoutNode, table: TableCatalogEntry): LayoutNode {
  return mapSelections(layout, (selection) => {
    if (selection?.kind !== 'table' || selection.table_id !== table.id) return selection;
    return selection.table?.name === table.name ? selection : { ...selection, table };
  });
}

/**
 * Drop a discarded draft from every pane and history stack. A pane showing
 * the draft falls back to the entry it showed before (or empties when the
 * draft was its only visit).
 */
export function discardTableDraft(layout: LayoutNode, draftId: string): LayoutNode {
  const next = mapLeaves(layout, (leaf) => {
    const selectionIsDraft = isDraft(leaf.selection, draftId);
    if (!selectionIsDraft && !leaf.history.entries.some((entry) => isDraft(entry, draftId))) {
      return leaf;
    }
    const entries: NonNullableSelection[] = [];
    let index = -1;
    leaf.history.entries.forEach((entry, i) => {
      if (isDraft(entry, draftId)) return;
      if (i <= leaf.history.index) index = entries.length;
      entries.push(entry);
    });
    if (index < 0 && entries.length > 0) index = 0;
    return {
      ...leaf,
      selection: selectionIsDraft ? (entries[index] ?? null) : leaf.selection,
      history: { entries, index },
    };
  });
  return next ?? layout;
}

/**
 * Keeps pane selections aligned with Database table events: a successful
 * create turns its draft pane into the saved table view, a rename (or a
 * restore under a new name) relabels every pane and history entry showing
 * that table, and a canceled draft disappears from the pane that held it.
 */
export function useTableSelectionSync(
  setLayout: React.Dispatch<React.SetStateAction<LayoutNode>>
): void {
  useEffect(
    () =>
      subscribeTableEvents((event) => {
        switch (event.type) {
          case 'table.created':
            setLayout((previous) => promoteTableDraft(previous, event.table));
            return;
          case 'table.updated':
          case 'table.restored':
            // A restore may come back under a new name when its own was taken
            // meanwhile; panes still showing it follow like a rename.
            setLayout((previous) => renameTableSelections(previous, event.table));
            return;
          case 'draft.discarded':
            setLayout((previous) => discardTableDraft(previous, event.draftId));
        }
      }),
    [setLayout]
  );
}
