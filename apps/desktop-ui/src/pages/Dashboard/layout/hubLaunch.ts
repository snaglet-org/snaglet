/**
 * What the window opens with when there is nothing to restore (a first
 * launch, a layout that could not be restored, or one whose panes were all
 * empty): Home while the `hub_home` flag is on, Get started while the first
 * run is unfinished, or both side by side (`launchPanes` decides). A saved
 * layout restores as it was.
 */

import type { LaunchPanes } from '@desktop/features/onboarding';
import type { DetailSelection } from '../selection/types';
import type { LayoutNode } from './paneTreeTypes';
import { findLeaf, leafIds } from './paneTreeQueries';
import { replaceLeafSelection } from './paneHistory';
import { splitLeafWithResult } from './paneTreeMutation';

interface PaneState {
  layout: LayoutNode;
  activeLeafId: string | null;
}

/** Get started's share of the window when it opens beside Home. */
const GET_STARTED_RATIO = 0.5;

/**
 * The pane to open Home in at launch: the active pane, else the first, when
 * no pane shows anything; otherwise `null`, which leaves the layout alone.
 */
export function hubLaunchLeafId(state: PaneState): string | null {
  const ids = leafIds(state.layout);
  if (ids.length === 0) return null;
  if (ids.some((id) => findLeaf(state.layout, id)?.selection)) return null;
  return state.activeLeafId && ids.includes(state.activeLeafId) ? state.activeLeafId : ids[0];
}

function shows(state: PaneState, kind: NonNullable<DetailSelection>['kind']): boolean {
  return leafIds(state.layout).some((id) => findLeaf(state.layout, id)?.selection?.kind === kind);
}

/**
 * Fill the pane that was empty at launch (`leafId`) with the launch panes.
 * It must still be empty, or show only the Home the launch put there: a pane
 * the person filled meanwhile, a pane that is gone, or a Get started already
 * open (a reload restores its own) leaves the layout as it is. Beside Home,
 * Get started opens to the right and Home keeps the focus, so sidebar clicks
 * and Get started's own links open in Home's pane with the guide still in view.
 */
export function openLaunchPanes(state: PaneState, leafId: string, panes: LaunchPanes): PaneState {
  const leaf = findLeaf(state.layout, leafId);
  if (panes === 'empty' || !leaf) return state;
  if (leaf.selection && leaf.selection.kind !== 'hub') return state;
  if (panes !== 'home' && shows(state, 'get-started')) return state;

  if (panes === 'get-started') {
    return {
      layout: replaceLeafSelection(state.layout, leafId, { kind: 'get-started' }),
      activeLeafId: leafId,
    };
  }
  const withHome = leaf.selection
    ? state.layout
    : replaceLeafSelection(state.layout, leafId, { kind: 'hub' });
  if (panes === 'home') return { layout: withHome, activeLeafId: leafId };
  const { layout } = splitLeafWithResult(
    withHome,
    leafId,
    'right',
    { kind: 'get-started' },
    { newPaneRatio: GET_STARTED_RATIO }
  );
  return { layout, activeLeafId: leafId };
}
