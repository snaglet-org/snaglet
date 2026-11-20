import { useEffect, useMemo, type FC } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';

import { PaneChrome } from '../chrome/PaneChrome/PaneChrome';
import {
  type LayoutNode,
  type LayoutSplit,
  type SplitDirection,
  type DropZone,
  PANE_MIN_RATIO,
  PANE_RATIO_PRECISION,
  repairPaneLayout,
  reportPaneLayoutRepairs,
} from './paneTree';
import { type DetailSelection } from '../selection/types';
import { usePaneFocusShortcuts } from './usePaneFocusShortcuts';
import styles from './PaneLayout.module.scss';

/**
 * Callbacks recursively passed down through every PaneLayout / PanelHost
 * during tree rendering. Bundled so the recursive signature doesn't have
 * to list 8 unchanging args at every level — a single `callbacks` prop
 * threads through, and only `layout` varies per recursion.
 */
export interface PaneCallbacks {
  onSelectLeaf: (leafId: string) => void;
  onCloseLeaf: (leafId: string) => void;
  onSplit: (leafId: string, zone: Exclude<DropZone, 'center'>, selection: DetailSelection) => void;
  onReplace: (leafId: string, selection: DetailSelection) => void;
  onResize: (splitId: string, ratios: number[]) => void;
  onGoBackInLeaf: (leafId: string) => void;
  onGoForwardInLeaf: (leafId: string) => void;
  onJumpToHistoryEntry: (leafId: string, index: number) => void;
  onOpenInSidebar?: (selection: DetailSelection) => void;
}

interface PaneLayoutProps {
  layout: LayoutNode;
  activeLeafId: string | null;
  callbacks: PaneCallbacks;
}

/**
 * Stable base id for the root group. PaneGroup appends the ordered child ids so
 * react-resizable-panels rebuilds its internal registry when the cohort changes;
 * the React component itself remains un-keyed, preserving pane descendants.
 * Resize still routes by the split's data id rather than this registration id.
 */
const ROOT_GROUP_ID = 'pane-root';

/**
 * Recursive renderer for the layout tree. Every leaf, even a lone one,
 * renders through the same `Group > Panel` host: React reconciles by element
 * type per position, so a lone `<PaneChrome>` that turned into a `<Group>` on
 * split would unmount and lose its live state (a voice call, scroll, unsaved
 * drafts). With the shared host a split only adds a sibling `Panel`, and the
 * existing pane's `Panel`, keyed by leaf id, reconciles in place.
 */
const PaneLayout: FC<PaneLayoutProps> = ({ layout, activeLeafId, callbacks }) => {
  // State/load/persistence paths already normalize the tree. This final pure
  // derivation protects Group from a malformed prop supplied by any future
  // caller; reporting happens after render so render itself stays side-effect
  // free and never mutates React state.
  const repaired = useMemo(() => repairPaneLayout(layout), [layout]);
  useEffect(() => {
    reportPaneLayoutRepairs('render', repaired.repairs);
  }, [repaired]);
  const safeLayout = repaired.layout;
  usePaneFocusShortcuts(safeLayout, activeLeafId, callbacks.onSelectLeaf);

  // Normalize both shapes to "a group with one Panel per child": a lone leaf is
  // a one-child group (100%, not resizable), a split maps straight through.
  // Either way the leaf renders through the identical PanelHost path, so a later
  // split is an add-a-sibling diff rather than a change-the-element-type diff.
  const isSplit = safeLayout.kind === 'split';
  return (
    <PaneGroup
      groupId={ROOT_GROUP_ID}
      direction={isSplit ? safeLayout.direction : 'horizontal'}
      nodes={isSplit ? safeLayout.children : [safeLayout]}
      ratios={isSplit ? safeLayout.ratios : [100]}
      // A lone leaf has no resize handle and no split id to persist against.
      splitId={isSplit ? safeLayout.id : null}
      activeLeafId={activeLeafId}
      callbacks={callbacks}
      isSplitRoot={isSplit}
    />
  );
};

interface PaneGroupProps {
  /** react-resizable-panels group id (stable root id, or the split's data id
   *  when nested). Kept separate from `splitId` so the root group can stay
   *  constant while resize still routes to the correct data node. */
  groupId: string;
  direction: SplitDirection;
  nodes: LayoutNode[];
  ratios: number[];
  /** Data id of the split these panels belong to, or null for a lone leaf that
   *  can't be resized. `onLayoutChange` routes by this id, independent of
   *  `groupId`, so a stable root group id never mis-targets the reducer. */
  splitId: string | null;
  activeLeafId: string | null;
  callbacks: PaneCallbacks;
  /** Root group only: true when the workspace is split into 2+ panes. Marks
   *  the root with `data-pane-split` so the active pane can draw its
   *  all-sides focus border only when there is another pane to contrast with. */
  isSplitRoot?: boolean;
}

/**
 * PaneGroup — a `Group` (react-resizable-panels v4) with N `Panel` children
 * separated by `Separator` handles. Used both for the root wrapper (which may
 * hold a single lone leaf) and for every nested split.
 */
const PaneGroup: FC<PaneGroupProps> = ({
  groupId,
  direction,
  nodes,
  ratios,
  splitId,
  activeLeafId,
  callbacks,
  isSplitRoot,
}) => {
  const structureKey = nodes.map((node) => node.id).join('|');
  const desiredLayout = useMemo(
    () => Object.fromEntries(nodes.map((node, index) => [node.id, ratios[index]])),
    [nodes, ratios]
  );
  const minimumRatio =
    nodes.length * PANE_MIN_RATIO <= 100
      ? PANE_MIN_RATIO
      : Math.floor((100 / nodes.length) * 10 ** PANE_RATIO_PRECISION) / 10 ** PANE_RATIO_PRECISION;

  return (
    <Group
      orientation={direction}
      // v4 caches registrations and layouts by Group id + panel cohort. A
      // structure-derived registration id forces that internal registry to
      // rebuild when sibling ids change, without re-keying this React component
      // or its keyed PaneChrome descendants.
      id={`${groupId}:${structureKey}`}
      defaultLayout={desiredLayout}
      // v4 reports sizes as a { panelId: percent } map; re-order it into the
      // array the reducer expects. A lone leaf (splitId null) has nothing to
      // persist.
      //
      // `onLayoutChanged`, not `onLayoutChange`: the latter fires on every
      // pointermove, and re-rendering the whole pane subtree each time makes
      // the divider trail the cursor. The library moves the divider itself
      // during a drag (writing `flexGrow` to the DOM); `onLayoutChanged` fires
      // once on release, and at once for keyboard resizes.
      onLayoutChanged={(sizesMap) => {
        if (splitId === null) return;
        const ordered = nodes.map((n) => sizesMap[n.id] ?? 0);
        callbacks.onResize(splitId, ordered);
      }}
      className={styles.group}
      data-pane-split={isSplitRoot ? 'true' : undefined}
    >
      {nodes.map((child, i) => (
        <PanelHost
          key={child.id}
          child={child}
          ratio={ratios[i]}
          minimumRatio={minimumRatio}
          isLast={i === nodes.length - 1}
          direction={direction}
          activeLeafId={activeLeafId}
          callbacks={callbacks}
        />
      ))}
    </Group>
  );
};

interface PanelHostProps {
  child: LayoutNode;
  ratio: number;
  minimumRatio: number;
  isLast: boolean;
  direction: SplitDirection;
  activeLeafId: string | null;
  callbacks: PaneCallbacks;
}

const PanelHost: FC<PanelHostProps> = ({
  child,
  ratio,
  minimumRatio,
  isLast,
  direction,
  activeLeafId,
  callbacks,
}) => (
  <>
    <Panel defaultSize={`${ratio}%`} minSize={`${minimumRatio}%`} id={child.id}>
      <PaneContent node={child} activeLeafId={activeLeafId} callbacks={callbacks} />
    </Panel>
    {!isLast && (
      <Separator
        className={direction === 'horizontal' ? styles.handleHorizontal : styles.handleVertical}
      />
    )}
  </>
);

interface PaneContentProps {
  node: LayoutNode;
  activeLeafId: string | null;
  callbacks: PaneCallbacks;
}

/**
 * The body inside one `Panel`: a leaf renders its `PaneChrome`, a split
 * recurses into a nested `PaneGroup` keyed by the split's data id. Turning a
 * leaf into a split still remounts that pane (splitLeaf gives the new split a
 * fresh id, so the Panel re-keys); splitting a different pane never touches
 * this one.
 */
const PaneContent: FC<PaneContentProps> = ({ node, activeLeafId, callbacks }) => {
  if (node.kind === 'leaf') {
    return (
      <PaneChrome
        leaf={node}
        isActive={activeLeafId === node.id}
        onActivate={() => callbacks.onSelectLeaf(node.id)}
        onClose={() => callbacks.onCloseLeaf(node.id)}
        onDropSelection={(zone, selection) => {
          if (zone === 'center') callbacks.onReplace(node.id, selection);
          else callbacks.onSplit(node.id, zone, selection);
        }}
        onReplaceSelection={(selection) => callbacks.onReplace(node.id, selection)}
        onGoBack={() => callbacks.onGoBackInLeaf(node.id)}
        onGoForward={() => callbacks.onGoForwardInLeaf(node.id)}
        onJumpToHistoryEntry={(index) => callbacks.onJumpToHistoryEntry(node.id, index)}
        onOpenInSidebar={() => callbacks.onOpenInSidebar?.(node.selection)}
      />
    );
  }

  const split: LayoutSplit = node;
  return (
    <PaneGroup
      groupId={split.id}
      direction={split.direction}
      nodes={split.children}
      ratios={split.ratios}
      splitId={split.id}
      activeLeafId={activeLeafId}
      callbacks={callbacks}
    />
  );
};

export { PaneLayout };
