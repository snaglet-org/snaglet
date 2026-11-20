import { useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components/controls/Button/Button';
import { ExpandIcon } from '@desktop/components/Icons';
import { ZoomableImage, type ZoomableImageProps } from '@desktop/components/ImageViewer';
import { Tooltip } from '@desktop/components/Tooltip/Tooltip';
import { ensureTableNames, tableNamesLoaded } from '@desktop/features/database/tableNameCache';
import {
  ensureAgents,
  getAgentsCached,
} from '@desktop/features/rich-markdown/editor/agentMentionCache';
import { findNodeTitle } from '@desktop/pages/Dashboard/chrome/PathHeader/nodeAncestors';
import { WHEEL_SCROLL_X_PROPS } from '@desktop/utils/horizontalWheelScroll';
import { Chip } from './Chip';
import {
  extractMermaidChips,
  mermaidChipSlot,
  type MermaidChip,
  type MermaidChipLookups,
} from './mermaidChips';
import { MERMAID_PREVIEW_IMAGE, preventPreviewDrag } from './mermaidDrag';
import { MermaidPreviewModal } from './MermaidPreviewModal';
import type { MermaidBox } from './mermaidLayout';
import { mermaidLabelKey, renderMermaid, type MermaidNodeBox } from './mermaidRender';
import { useWorkspaceTree } from './useWorkspaceAncestors';
import styles from './MermaidDiagram.module.scss';

type Rendered = Awaited<ReturnType<typeof renderMermaid>>;
/** `source` is the rewritten source the image was rendered from. */
type Result = { source: string; image?: Rendered; error?: string };
type Overlay = NonNullable<ZoomableImageProps['overlay']>;

interface ChipPlacement {
  chip: MermaidChip;
  slot: MermaidBox;
}

type Lookup = keyof MermaidChipLookups;

const LOOKUPS: readonly Lookup[] = ['agents', 'tableNames'];
const LOOKUP_CACHES: Record<Lookup, { loaded: () => boolean; load: () => Promise<unknown> }> = {
  agents: { loaded: () => getAgentsCached() !== null, load: ensureAgents },
  tableNames: { loaded: tableNamesLoaded, load: ensureTableNames },
};
/** The longest a chart waits for a lookup before it draws those links as plain text. */
const MERMAID_LOOKUP_WAIT_MS = 1500;

/** A chip's own presses must not pan or zoom the diagram under it. */
const stopViewerGesture = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The chips of `source`, extracted again whenever a lookup a whole-label link
 * waits on (the agent roster, the table catalog) finishes loading. `waiting`
 * holds the chart while such a lookup is still cold, so the node is drawn
 * once, as a chip, not first as plain text, but for at most
 * MERMAID_LOOKUP_WAIT_MS: a slow or hung load lets the chart draw those links
 * as plain text, and a load that finishes later draws it once more. A warm
 * lookup is never loaded or waited on, and a failed one is not retried here.
 */
function useLookupChips(source: string) {
  // Lookups this chart has stopped waiting on: loaded, failed, or timed out.
  const [released, setReleased] = useState<ReadonlySet<Lookup>>(() => new Set());
  const loaded = LOOKUPS.filter((lookup) => LOOKUP_CACHES[lookup].loaded()).join(' ');
  // `loaded` is a dependency on purpose: a lookup that loads changes what the
  // links resolve to.
  const extracted = useMemo(() => extractMermaidChips(source), [source, loaded]);
  const cold = LOOKUPS.filter(
    (lookup) =>
      extracted.lookups[lookup] && !LOOKUP_CACHES[lookup].loaded() && !released.has(lookup)
  );
  const coldKey = cold.join(' ');

  useEffect(() => {
    if (!coldKey) return;
    const loads = LOOKUPS.filter((lookup) => coldKey.split(' ').includes(lookup));
    const release = () => setReleased((previous) => new Set([...previous, ...loads]));
    const timer = window.setTimeout(release, MERMAID_LOOKUP_WAIT_MS);
    // Releasing again when the load finishes re-reads the links even after
    // the wait ran out; a failed load releases them as plain text.
    void Promise.allSettled(loads.map((lookup) => LOOKUP_CACHES[lookup].load())).then(release);
    return () => window.clearTimeout(timer);
  }, [coldKey]);

  return { extracted, waiting: cold.length > 0 };
}

/** Pair each rendered node with the chip whose placeholder it carries. */
function placeChips(nodes: readonly MermaidNodeBox[], chips: readonly MermaidChip[]) {
  const byLabel = new Map(chips.map((chip) => [mermaidLabelKey(chip.label), chip]));
  return nodes.flatMap((node): ChipPlacement[] => {
    const chip = byLabel.get(mermaidLabelKey(node.label));
    return chip ? [{ chip, slot: mermaidChipSlot(node) }] : [];
  });
}

/**
 * The chip layer for ZoomableImage: each chip centered in its slot over its
 * node (see mermaidChipSlot). The layer is in the image's natural pixels and
 * scales with the zoom, so a chip grows and moves with the picture.
 */
function chipOverlay(
  placements: readonly ChipPlacement[],
  size: Rendered['size']
): Overlay | undefined {
  if (!size || placements.length === 0) return undefined;
  return ({ natural }) => {
    const sx = natural.width / size.width;
    const sy = natural.height / size.height;
    return placements.map(({ chip, slot }, index) => (
      <div
        key={`${index}:${chip.label}`}
        className={styles.chipSlot}
        data-mermaid-chip=""
        style={{
          left: slot.x * sx,
          top: slot.y * sy,
          width: slot.width * sx,
          height: slot.height * sy,
        }}
        onPointerDown={stopViewerGesture}
        onDoubleClick={stopViewerGesture}
      >
        <Chip
          kind={chip.kind}
          nodeId={chip.nodeId}
          href={chip.href}
          title={chip.title}
          anchor={chip.anchor}
          interactive
          showIncludeToggle={false}
          draggable={false}
        />
      </div>
    ));
  };
}

/**
 * The inline box's shape: the diagram's aspect ratio, no taller than the
 * diagram itself (the stylesheet also caps it at 60% of the window).
 */
function viewportStyle(size: Rendered['size']): CSSProperties | undefined {
  if (!size) return undefined;
  return {
    '--mermaid-ratio': `${size.width} / ${size.height}`,
    '--mermaid-height': `${size.height}px`,
  } as CSSProperties;
}

/**
 * MermaidDiagram — one Mermaid fence rendered as an isolated SVG image in a
 * pan/zoom viewer (pinch or Ctrl/⌘+wheel to zoom, drag once zoomed, keys when
 * focused; a plain wheel at fit scrolls the page). The corner button opens
 * the same image large in MermaidPreviewModal.
 *
 * A flowchart node labeled with a node reference renders with a placeholder
 * label (see mermaidChips) and a live Chip laid over it in both viewers. A
 * bare id is drawn under the node's current title from the library tree, so
 * the diagram waits for the tree before it renders; a link to an agent id or
 * to a row by table name waits for the agent roster or table catalog.
 */
export function MermaidDiagram({
  source,
  showSource = true,
}: {
  source: string;
  showSource?: boolean;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [enlarged, setEnlarged] = useState(false);

  const { extracted: untitled, waiting: waitingForLookups } = useLookupChips(source);
  const needsTitles = untitled.chips.some((chip) => chip.form === 'id');
  const tree = useWorkspaceTree(needsTitles);
  const { source: rendered, chips } = useMemo(
    () =>
      needsTitles && tree
        ? extractMermaidChips(source, (ref) => findNodeTitle(tree, ref.id))
        : untitled,
    [needsTitles, source, tree, untitled]
  );
  const waiting = (needsTitles && !tree) || waitingForLookups;
  // Placeholders never contain a line break, so the labels travel as one string.
  const chipLabels = chips.map((chip) => chip.label).join('\n');

  const current = result?.source === rendered && !waiting ? result : null;
  const displayed = current?.error ? undefined : result?.image;
  const placements = useMemo(
    () => (displayed ? placeChips(displayed.nodes, chips) : []),
    [displayed, chips]
  );
  const overlay = chipOverlay(placements, displayed?.size ?? null);

  useEffect(() => {
    if (waiting) return;
    let canceled = false;
    const controller = new AbortController();
    const options = { chipLabels: chipLabels ? chipLabels.split('\n') : [] };
    // Streaming chat often changes an unfinished fence several times before
    // it becomes valid. Coalesce those updates and ignore stale completions.
    const timer = window.setTimeout(() => {
      void renderMermaid(rendered, controller.signal, options).then(
        (image) => {
          if (!canceled) setResult({ source: rendered, image });
        },
        (error: unknown) => {
          if (!canceled)
            setResult({
              source: rendered,
              error: getErrorMessage(error, 'Invalid Mermaid syntax.'),
            });
        }
      );
    }, 150);
    return () => {
      canceled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [rendered, chipLabels, waiting]);

  return (
    <figure className={styles.diagram} aria-label="Mermaid diagram">
      {displayed ? (
        <div
          className={styles.viewport}
          data-mermaid-viewport=""
          data-sized={displayed.size ? '' : undefined}
          style={viewportStyle(displayed.size)}
          onDragStartCapture={preventPreviewDrag}
        >
          <ZoomableImage
            src={displayed.src}
            alt="Mermaid diagram"
            className={styles.canvas}
            imageDataAttributes={MERMAID_PREVIEW_IMAGE}
            overlay={overlay}
          />
          <Tooltip label="Open larger" side="top">
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              className={styles.enlarge}
              aria-label="Open diagram larger"
              onClick={() => setEnlarged(true)}
            >
              <ExpandIcon />
            </Button>
          </Tooltip>
        </div>
      ) : (
        <p role="status">
          {current?.error ? 'Unable to render Mermaid diagram.' : 'Rendering diagram…'}
        </p>
      )}
      {displayed && !current && <p role="status">Updating diagram…</p>}
      {current?.error && <p className={styles.error}>{current.error}</p>}
      {showSource && (
        <details key={source} open={current?.error ? true : undefined}>
          <summary>Diagram source</summary>
          <pre {...WHEEL_SCROLL_X_PROPS}>
            <code>{source}</code>
          </pre>
        </details>
      )}
      {enlarged && displayed && (
        <MermaidPreviewModal
          src={displayed.src}
          overlay={overlay}
          onClose={() => setEnlarged(false)}
        />
      )}
    </figure>
  );
}
