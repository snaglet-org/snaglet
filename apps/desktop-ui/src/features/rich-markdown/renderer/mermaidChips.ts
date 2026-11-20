/**
 * Node chips inside Mermaid flowcharts. A node whose whole label is a node
 * reference, as a bare id (`A[doc-…]`) or a markdown link (`A["[Spec](doc-…)"]`),
 * is drawn with a placeholder label and MermaidDiagram lays a `Chip` over it.
 * Tables, rows and agents chip from links only, as in prose; rows by table
 * name and agent ids wait on lookups (see `lookups`). Everything else stays
 * as written.
 *
 * The placeholder is the chip title in Mermaid-safe characters, padded with
 * spaces held by word joiners (U+2060) so the label is as wide as the chip.
 * It ends in an invisible marker holding the chip's index in binary
 * (U+200B/U+200C between word joiners), so a rendered node matches its chip
 * by text and never by a lookalike label.
 */

import {
  HEADING_FRAGMENT_SOURCE,
  LINE_FRAGMENT_SOURCE,
  docAnchorLabel,
  lineRefLabel,
  type DocAnchor,
} from '@snaglet/shared/utils';
import {
  NODE_HREF_SOURCE,
  NODE_ID_BODY_SOURCE,
  PREFIXED_KINDS,
  TABLE_ROW_BY_NAME_SOURCE,
  TOOL_HREF_SOURCE,
  chipTitleWithoutRange,
  isTableRowHrefByName,
  parseNodeRef,
  type NodeRef,
} from './nodeRef';
import { CHIP_LABEL_WRAP, MIN_NODE_WIDTH, type MermaidBox } from './mermaidLayout';

/** Brackets every chip placeholder's index marker. */
export const MERMAID_CHIP_MARK = '\u2060';
const BIT_ZERO = '\u200b';
const BIT_ONE = '\u200c';

export interface MermaidChip {
  /** The exact placeholder text the rendered node carries. */
  label: string;
  /** The reference as written (with any anchor), as a markdown chip's href. */
  href: string;
  kind: string;
  nodeId: string;
  anchor?: DocAnchor;
  /**
   * What the chip shows, and what its node is sized for: the link text, else
   * the resolved title, else the id. Table and row chips show their live name.
   */
  title: string;
  /** Written as a bare id or as a markdown link. */
  form: 'id' | 'link';
}

/**
 * Lookups that an unresolved whole-label link could still resolve through:
 * the agent roster (`[Name](<agent id>)`) and the table catalog
 * (`[Row](<table name>:<uuid>)`). A caller loads them and extracts again.
 */
export interface MermaidChipLookups {
  agents: boolean;
  tableNames: boolean;
}

/** Looks up a node's current title, or null when it is unknown. */
type MermaidChipTitles = (ref: NodeRef) => string | null;

// References that stay plain text in a chart: images (prose shows them as
// pictures, not chips), models, file and folder paths, and runs.
const PLAIN_TEXT_KINDS = new Set(['image', 'model', 'file', 'folder', 'run']);

const FRAGMENT_SOURCE = `(?:#(?:${LINE_FRAGMENT_SOURCE}|${HEADING_FRAGMENT_SOURCE}))?`;
const BARE_REF_RE = new RegExp(
  `^(?:${PREFIXED_KINDS.join('|')})-${NODE_ID_BODY_SOURCE}${FRAGMENT_SOURCE}$`
);
// Agent ids are name slugs (`slugifyAgentName`): `researcher`, `test-agent-a`.
const AGENT_ID_SOURCE = '[a-z0-9]+(?:-[a-z0-9]+)*';
const AGENT_ID_RE = new RegExp(`^${AGENT_ID_SOURCE}$`);
// `agent:<agent id>` names an agent outright, so it needs no roster. Prose
// does not read it (a scheme body there must be a uuid or timestamp id).
const AGENT_SCHEME_RE = new RegExp(`^agent:(${AGENT_ID_SOURCE})$`);
// A kind-prefixed href (`doc-…`) never resolves through the agent roster.
const KIND_PREFIX_RE = new RegExp(`^(?:${PREFIXED_KINDS.join('|')})-`);
// A link names its tool outright (`[Weather](tool:weather)`), as in prose.
const CHART_HREF_SOURCE = `(?:${NODE_HREF_SOURCE}|${TOOL_HREF_SOURCE}|${TABLE_ROW_BY_NAME_SOURCE}|agent:${AGENT_ID_SOURCE}|${AGENT_ID_SOURCE})`;
const LINK_SOURCE = `\\[([^\\]\\n]*)\\]\\((${CHART_HREF_SOURCE})\\)`;
const LINK_RE = new RegExp(`^${LINK_SOURCE}$`);
const UNQUOTED_LINK_RE = new RegExp(`\\s*${LINK_SOURCE}\\s*`, 'y');

/** Node shapes, longest opener first so `[[` is never read as `[`. */
const SHAPES: ReadonlyArray<{ open: string; close: readonly string[] }> = [
  { open: '(((', close: [')))'] },
  { open: '[[', close: [']]'] },
  { open: '[(', close: [')]'] },
  { open: '([', close: ['])'] },
  { open: '[/', close: ['/]', '\\]'] },
  { open: '[\\', close: ['\\]', '/]'] },
  { open: '((', close: ['))'] },
  { open: '{{', close: ['}}'] },
  { open: '[', close: [']'] },
  { open: '(', close: [')'] },
  { open: '{', close: ['}'] },
  { open: '>', close: [']'] },
];

const NODE_ID_RE = /[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?/uy;
const FLOWCHART_RE = /^\s*(?:flowchart|graph)(?:-elk)?\b/;
// Statements whose text is never a node label: subgraph titles, styling,
// interaction and accessibility lines.
const NON_NODE_LINE_RE =
  /^\s*(?:subgraph|end|click|style|classDef|class|linkStyle|direction|accTitle|accDescr)\b/;

interface Label {
  /** The label text between the opener (and its quotes) and the closer. */
  text: string;
  /** The closer that ends it. */
  close: string;
  /** Index just past the closer. */
  end: number;
}

interface Shape {
  open: string;
  close: readonly string[];
}

function closerAt(line: string, index: number, shape: Shape): string | undefined {
  return shape.close.find((close) => line.startsWith(close, index));
}

/** The label of `shape` opening at `start`: quoted, or up to its first closer. */
function labelAt(line: string, start: number, shape: Shape): Label | null {
  const body = start + shape.open.length;
  if (line[body] === '"') {
    const quote = line.indexOf('"', body + 1);
    const close = quote < 0 ? undefined : closerAt(line, quote + 1, shape);
    return close
      ? { text: line.slice(body + 1, quote), close, end: quote + 1 + close.length }
      : null;
  }
  let first: Label | null = null;
  for (const close of shape.close) {
    const at = line.indexOf(close, body);
    if (at >= 0 && (!first || at < first.end - first.close.length)) {
      first = { text: line.slice(body, at), close, end: at + close.length };
    }
  }
  return first;
}

/** An unquoted markdown-link label, whose text and href may hold closer characters. */
function linkLabelAt(line: string, start: number, shape: Shape): Label | null {
  const body = start + shape.open.length;
  UNQUOTED_LINK_RE.lastIndex = body;
  if (!UNQUOTED_LINK_RE.exec(line)) return null;
  const close = closerAt(line, UNQUOTED_LINK_RE.lastIndex, shape);
  if (!close) return null;
  return {
    text: line.slice(body, UNQUOTED_LINK_RE.lastIndex),
    close,
    end: UNQUOTED_LINK_RE.lastIndex + close.length,
  };
}

interface ChipRef {
  ref: NodeRef;
  href: string;
  linkText: string | null;
}

/** What a whole label names: a chip, or a link a lookup could still resolve. */
type LabelRef = ChipRef | { lookup: keyof MermaidChipLookups } | null;

/** The lookup an href that did not resolve could still resolve through. */
function lookupFor(href: string): keyof MermaidChipLookups | null {
  if (isTableRowHrefByName(href)) return 'tableNames';
  if (AGENT_ID_RE.test(href) && !KIND_PREFIX_RE.test(href)) return 'agents';
  return null;
}

/** The node reference a whole label names, or what it waits on, or null. */
function labelRef(text: string): LabelRef {
  const trimmed = text.trim();
  const link = LINK_RE.exec(trimmed);
  const href = link ? link[2] : BARE_REF_RE.test(trimmed) ? trimmed : null;
  if (!href) return null;
  const agentId = link ? AGENT_SCHEME_RE.exec(href)?.[1] : undefined;
  const ref = parseNodeRef(href) ?? (agentId ? { kind: 'agent', id: agentId } : null);
  if (!ref) {
    const lookup = link ? lookupFor(href) : null;
    return lookup ? { lookup } : null;
  }
  if (PLAIN_TEXT_KINDS.has(ref.kind)) return null;
  return { ref, href, linkText: link ? (link[1] ?? '').trim() : null };
}

/** Display text reduced to characters that are inert inside a quoted Mermaid label. */
function placeholderText(text: string): string {
  return text
    .replace(/[^\p{L}\p{M}\p{N} _.,:'!?-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Widths in the diagram's natural pixels. Node labels are 16px Arial. A
// chip's title is 14px IBM Plex Mono (0.6em advance plus 0.01em tracking),
// its anchor label 0.75 of that after a 4px gap, and its dot, gap, padding
// and border add 18px.
const LABEL_FONT_PX = 16;
const CHIP_CHAR_PX = 8.54;
const CHIP_ANCHOR_CHAR_PX = 6.4;
const CHIP_ANCHOR_GAP_PX = 4;
const CHIP_CHROME_PX = 18;
const SPACE_PX = 0.278 * LABEL_FONT_PX;
/**
 * Room a padded label keeps under the label wrap when its text is not all
 * ASCII, whose widths are only estimated. ASCII widths are exact (kerning
 * only narrows them), so such a label may pad right up to the wrap.
 */
const WRAP_MARGIN_PX = 8;
const ASCII_RE = /^[\x20-\x7e]*$/;
/**
 * How far a chip may reach past its label on each side. Every flowchart
 * shape keeps about 12px or more beside its label at the chip's height (a
 * cylinder and a diamond keep the least), so 8 leaves a gap to the outline.
 */
const CHIP_OVERHANG_PX = 8;

/** Arial advances in em of the characters a placeholder can hold. */
const ARIAL_ADVANCES: ReadonlyArray<readonly [string, number]> = [
  ["'", 0.191],
  ['ijl', 0.222],
  [' .,:!ftI', 0.278],
  ['r-', 0.333],
  ['cksvxyzJ', 0.5],
  ['abdeghnopqu0123456789L_?', 0.556],
  ['FTZß', 0.611],
  ['ABEKPSVXY', 0.667],
  ['CDHNRUw', 0.722],
  ['GOQ', 0.778],
  ['mM', 0.833],
  ['æ', 0.889],
  ['Wœ', 0.944],
  ['ÆŒ', 1],
];
const ARIAL_ADVANCE = new Map(
  ARIAL_ADVANCES.flatMap(([chars, em]) => [...chars].map((char) => [char, em] as const))
);
const MARK_RE = /\p{M}/u;
const MARKS_RE = /\p{M}/gu;

/** Advance of `char` in Arial, in em: exact for ASCII, rough for the rest. */
function arialAdvance(char: string): number {
  const known = ARIAL_ADVANCE.get(char);
  if (known !== undefined) return known;
  // A combining mark draws over the letter before it.
  if (MARK_RE.test(char)) return 0;
  // An accented letter as wide as its base letter; other Latin about an
  // average letter, other scripts about a full em.
  const base = ARIAL_ADVANCE.get(char.normalize('NFD').charAt(0));
  return base ?? (/[À-ɏ]/.test(char) ? 0.6 : 1);
}

/** How many monospace cells `text` takes in a chip: combining marks take none. */
function chipCells(text: string): number {
  return [...text.replace(MARKS_RE, '')].length;
}

/**
 * Guarded spaces for each side of a placeholder: enough that the label
 * Mermaid draws for `text` is as wide as the chip that will cover it, at
 * least one, but none that would take the label past the label wrap (a
 * longer title's chip truncates instead). A title too wide for one line on
 * its own still wraps.
 */
function chipPadding(text: string, title: string, anchor: DocAnchor | undefined): string {
  const anchorText = anchor ? docAnchorLabel(anchor, lineRefLabel) : '';
  const chip =
    chipCells(title) * CHIP_CHAR_PX +
    (anchorText ? CHIP_ANCHOR_GAP_PX + chipCells(anchorText) * CHIP_ANCHOR_CHAR_PX : 0) +
    CHIP_CHROME_PX;
  const label = [...text].reduce((width, char) => width + arialAdvance(char) * LABEL_FONT_PX, 0);
  const wanted = Math.max(1, Math.ceil((chip - label) / SPACE_PX / 2));
  const margin = ASCII_RE.test(text) ? 0 : WRAP_MARGIN_PX;
  const room = Math.floor((CHIP_LABEL_WRAP - margin - label) / SPACE_PX / 2);
  const spaces = Math.max(0, Math.min(wanted, room));
  return `${MERMAID_CHIP_MARK}${` ${MERMAID_CHIP_MARK}`.repeat(spaces)}`;
}

/**
 * Where a chip is laid over its rendered node: centered on the node's box, as
 * tall as the box, and as wide as the label plus CHIP_OVERHANG_PX a side,
 * never wider than the box. The label is its text, but at least
 * MIN_NODE_WIDTH: Mermaid lays out a short label that wide and draws the
 * node around it. A chip wider than the slot truncates, so it stays inside
 * the outline of any shape.
 */
export function mermaidChipSlot({
  box,
  labelWidth,
}: {
  box: MermaidBox;
  labelWidth: number;
}): MermaidBox {
  const width = Math.min(box.width, Math.max(labelWidth, MIN_NODE_WIDTH) + 2 * CHIP_OVERHANG_PX);
  return { x: box.x + (box.width - width) / 2, y: box.y, width, height: box.height };
}

function chipMark(index: number): string {
  const bits = index.toString(2).replace(/0/g, BIT_ZERO).replace(/1/g, BIT_ONE);
  return `${MERMAID_CHIP_MARK}${bits}${MERMAID_CHIP_MARK}`;
}

/** How many leading lines are YAML front matter (`---` … `---`). */
function frontMatterLength(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return close < 0 ? lines.length : close + 1;
}

/** Whether the diagram is a flowchart, skipping front matter, directives and comments. */
function isFlowchart(lines: readonly string[], body: number): boolean {
  const declaration = lines.slice(body).find((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('%%');
  });
  return FLOWCHART_RE.test(declaration ?? '');
}

/**
 * Rewrite the chip labels of a Mermaid flowchart to placeholders and list the
 * chips. Any other diagram, and any source without chip labels, comes back
 * unchanged. `titles` sizes a bare-id node for its resolved title. `lookups`
 * says which lookups a whole-label link left unresolved is waiting on.
 */
export function extractMermaidChips(
  source: string,
  titles?: MermaidChipTitles
): { source: string; chips: MermaidChip[]; lookups: MermaidChipLookups } {
  const lines = source.split('\n');
  const chips: MermaidChip[] = [];
  const lookups: MermaidChipLookups = { agents: false, tableNames: false };
  const body = frontMatterLength(lines);
  if (!isFlowchart(lines, body)) return { source, chips, lookups };

  const chipLabel = (found: ChipRef): string => {
    const { ref, href, linkText } = found;
    const title = linkText || titles?.(ref)?.trim() || ref.id;
    const text = placeholderText(title) || ref.id;
    // Sized for the title the chip shows (the range once, as its badge).
    const padding = chipPadding(text, chipTitleWithoutRange(title, ref.anchor), ref.anchor);
    const label = `${padding}${text}${padding}${chipMark(chips.length)}`;
    chips.push({
      label,
      href,
      kind: ref.kind,
      nodeId: ref.id,
      ...(ref.anchor ? { anchor: ref.anchor } : {}),
      title,
      form: linkText === null ? 'id' : 'link',
    });
    return label;
  };

  /** A node label opening at `start`: its rewrite when it is a chip, and where it ends. */
  const nodeLabel = (line: string, start: number): { text: string; end: number } | null => {
    let skip: Label | null = null;
    for (const shape of SHAPES) {
      if (!line.startsWith(shape.open, start)) continue;
      for (const label of [labelAt(line, start, shape), linkLabelAt(line, start, shape)]) {
        const found = label && labelRef(label.text);
        if (label && found && 'lookup' in found) lookups[found.lookup] = true;
        if (label && found && 'ref' in found) {
          return { text: `${shape.open}"${chipLabel(found)}"${label.close}`, end: label.end };
        }
      }
      skip ??= labelAt(line, start, shape);
    }
    return skip ? { text: line.slice(start, skip.end), end: skip.end } : null;
  };

  const rewritten = lines.map((line, index) => {
    if (index < body || line.trim().startsWith('%%') || NON_NODE_LINE_RE.test(line)) return line;

    let out = '';
    let i = 0;
    while (i < line.length) {
      const char = line[i];
      // Quoted text and edge labels (`-->|…|`) are never node labels.
      if (char === '"' || char === '|') {
        const end = line.indexOf(char, i + 1);
        const stop = end < 0 ? line.length : end + 1;
        out += line.slice(i, stop);
        i = stop;
        continue;
      }
      NODE_ID_RE.lastIndex = i;
      const id = NODE_ID_RE.exec(line);
      if (!id) {
        out += char;
        i += 1;
        continue;
      }
      const after = i + id[0].length;
      const label = nodeLabel(line, after);
      out += id[0] + (label ? label.text : '');
      i = label ? label.end : after;
    }
    return out;
  });

  return { source: chips.length > 0 ? rewritten.join('\n') : source, chips, lookups };
}
