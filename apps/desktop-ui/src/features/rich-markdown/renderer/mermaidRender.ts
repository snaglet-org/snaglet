import { CHIP_LABEL_WRAP, LABEL_WRAP, MIN_NODE_WIDTH, type MermaidBox } from './mermaidLayout';

// Mermaid owns global configuration and temporary DOM. Serialize its work,
// and load the sizeable library only when Markdown actually contains a chart.
type Mermaid = (typeof import('mermaid'))['default'];

let library: Promise<Mermaid> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

const CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  theme: 'neutral',
  fontFamily: 'Arial, sans-serif',
  htmlLabels: false,
  maxTextSize: 50_000,
  maxEdges: 500,
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'suppressErrorRendering',
    'maxTextSize',
    'maxEdges',
    'htmlLabels',
    'flowchart',
    'fontFamily',
  ],
} as const;

let configuredWrap: number | undefined;

function configure(mermaid: Mermaid, wrappingWidth: number) {
  if (configuredWrap === wrappingWidth) return;
  mermaid.initialize({
    ...CONFIG,
    secure: [...CONFIG.secure],
    flowchart: { htmlLabels: false, wrappingWidth, minNodeWidth: MIN_NODE_WIDTH },
  });
  configuredWrap = wrappingWidth;
}

function loadMermaid() {
  library ??= import('mermaid')
    .then(({ default: mermaid }) => mermaid)
    .catch((error: unknown) => {
      library = undefined;
      throw error;
    });
  return library;
}

interface Size {
  width: number;
  height: number;
}

/**
 * A rendered node: its label text, its box, and the width of its label's
 * text (the box's width when it has none), in the image's natural pixels.
 */
export interface MermaidNodeBox {
  label: string;
  box: MermaidBox;
  labelWidth: number;
}

/**
 * A rendered diagram: an isolated SVG image, its intrinsic size when the SVG
 * declares one, and every flowchart node's box (none without a size).
 */
interface RenderedMermaid {
  src: string;
  size: Size | null;
  nodes: MermaidNodeBox[];
}

interface RenderMermaidOptions {
  /**
   * Labels a chip overlay covers. Their text is hidden in the image so only
   * the chip shows; matched like {@link mermaidLabelKey}.
   */
  chipLabels?: readonly string[];
}

/**
 * The comparable form of a node label. Mermaid wraps long labels into rows,
 * adding a break between words or splitting a long word, and the text of
 * the rows then joins with or without a space; whitespace never counts.
 */
export function mermaidLabelKey(text: string): string {
  return text.replace(/\s+/g, '');
}

/** The width and height of an SVG's viewBox, when it has a usable one. */
function viewBoxSize(svg: Element): RenderedMermaid['size'] {
  const values =
    svg
      .getAttribute('viewBox')
      ?.split(/[\s,]+/)
      .map(Number) ?? [];
  const [, , width, height] = values;
  if (values.length !== 4 || width === undefined || height === undefined) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** A node's label: its wrapped rows joined, whitespace collapsed. */
function nodeLabel(node: Element): string {
  const rows = Array.from(
    node.querySelectorAll('tspan.text-outer-tspan'),
    (row) => row.textContent
  );
  const text = rows.length > 0 ? rows.join(' ') : (node.querySelector('text') ?? node).textContent;
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function hideLabelText(node: Element) {
  for (const text of node.querySelectorAll('text')) {
    text.setAttribute('style', `${text.getAttribute('style') ?? ''};visibility:hidden`);
  }
}

/**
 * Measure every flowchart node of `svg` in natural image pixels, laying out a
 * copy in the (connected) scratch host, and hide the text of chip labels in
 * `svg` itself. Boxes are taken relative to the svg element's own rect and
 * divided by its on-screen scale, so a negative viewBox origin, CSS zoom or
 * any host scaling cancel out.
 */
function measureNodes(
  svg: Element,
  host: HTMLElement,
  size: Size,
  chipLabels: readonly string[]
): MermaidNodeBox[] {
  const live = document.importNode(svg, true);
  host.append(live);
  try {
    const frame = live.getBoundingClientRect();
    const ratio = frame.width / size.width;
    if (!Number.isFinite(ratio) || ratio <= 0) return [];
    const chipKeys = new Set(chipLabels.map(mermaidLabelKey));
    const originals = svg.querySelectorAll('g.node');
    return Array.from(live.querySelectorAll('g.node'), (node, index) => {
      const label = nodeLabel(node);
      const original = originals[index];
      if (original && chipKeys.has(mermaidLabelKey(label))) hideLabelText(original);
      const rect = node.getBoundingClientRect();
      const text = node.querySelector('text')?.getBoundingClientRect() ?? rect;
      return {
        label,
        box: {
          x: (rect.left - frame.left) / ratio,
          y: (rect.top - frame.top) / ratio,
          width: rect.width / ratio,
          height: rect.height / ratio,
        },
        labelWidth: text.width / ratio,
      };
    });
  } finally {
    live.remove();
  }
}

export function renderMermaid(
  source: string,
  signal?: AbortSignal,
  { chipLabels = [] }: RenderMermaidOptions = {}
): Promise<RenderedMermaid> {
  const render = queue.then(async () => {
    signal?.throwIfAborted();
    if (source.length > 50_000) throw new Error('Diagram exceeds the 50,000 character limit.');
    const mermaid = await loadMermaid();
    signal?.throwIfAborted();
    configure(mermaid, chipLabels.length > 0 ? CHIP_LABEL_WRAP : LABEL_WRAP);
    const host = document.createElement('div');
    // The renderer needs a connected DOM for text measurements. It must not
    // show scratch elements or leave Mermaid's error diagrams in the page.
    host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;';
    host.setAttribute('aria-hidden', 'true');
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(`snaglet-mermaid-${++nextId}`, source, host);
      // Display as an image, not injected HTML: diagram links, scripts and
      // styles cannot interact with the workspace. Keep a neutral paper
      // background so the image remains readable under any app theme.
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') {
        throw new Error('Mermaid produced malformed SVG.');
      }
      parsed.documentElement.style.backgroundColor = 'white';
      // Mermaid commonly returns width="100%". Give the image intrinsic
      // dimensions so small diagrams are not stretched to fill a whole pane.
      const size = viewBoxSize(parsed.documentElement);
      if (size) {
        parsed.documentElement.setAttribute('width', String(size.width));
        parsed.documentElement.setAttribute('height', String(size.height));
      }
      const nodes = size ? measureNodes(parsed.documentElement, host, size, chipLabels) : [];
      const isolatedSvg = new XMLSerializer().serializeToString(parsed.documentElement);
      return {
        src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(isolatedSvg)}`,
        size,
        nodes,
      };
    } finally {
      host.remove();
    }
  });
  // The original promise below delivers errors to the diagram's error UI.
  // Only the scheduling tail recovers, so one bad chart cannot block others.
  // eslint-disable-next-line no-restricted-syntax -- rejection is propagated via the returned render promise
  queue = render.catch(() => undefined);
  return render;
}
