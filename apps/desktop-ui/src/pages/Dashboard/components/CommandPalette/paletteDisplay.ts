import {
  PALETTE_KIND_FILTER_PREFIXES,
  type PaletteCoverageMode,
  type PaletteSemanticStatus,
} from '@desktop/utils/api';
import type { ChipTone } from '@desktop/components';
import { extractThreadSummaryDisplay } from '@desktop/utils/threadSummaryHit';
import { type Kind, type SearchResult } from './paletteResultMappers';

/** Longest snippet kept for a result's one-line meta; the row ellipsizes the rest. */
const SNIPPET_MAX = 160;

function formatCreatedTimestamp(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  const time = date
    .toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .replace(/\s?(AM|PM)$/i, '$1');
  const day = date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return `${time} ${day}`;
}

/** Text on one line, cut to {@link SNIPPET_MAX}; null when blank. */
function oneLine(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX)}…` : line;
}

/**
 * The matching text a result carries beyond its title, when the search
 * returned any: an image's description and tags, a memory's content, a
 * tool's description, an agent's role. Docs and threads come back as titles
 * only, so they have none.
 */
function resultSnippet(hit: SearchResult): string | null {
  const node = hit.node;
  switch (node.kind) {
    case 'image': {
      const tags = node.tags.filter((tag) => Boolean(tag.trim()));
      return oneLine(
        [node.description, tags.length > 0 ? `Tags: ${tags.join(', ')}` : null]
          .filter(Boolean)
          .join(' · ')
      );
    }
    case 'memory':
      return oneLine(node.payload.content);
    case 'tool':
      return oneLine(node.payload.description);
    case 'agent':
      return oneLine(node.payload.role);
    default:
      return null;
  }
}

/**
 * The muted line under a palette result's title: where it lives (its folder
 * or project path, or its thread) and the matching snippet when there is one,
 * on one line. A thread summary keeps its thread and time, which tell
 * summaries of one thread apart.
 */
export function formatResultMeta(hit: SearchResult): string | null {
  // An entry's label already names its table.
  if (hit.node.kind === 'entry') return null;

  // The title slot carries the summary preview, so the line names the thread
  // it belongs to, and when it was written.
  if (hit.node.kind === 'thread_summary') {
    const { threadTitle, createdAt } = extractThreadSummaryDisplay(hit.node.payload);
    const timeLabel = createdAt ? formatCreatedTimestamp(createdAt) : null;
    return timeLabel ? `${threadTitle} · ${timeLabel}` : threadTitle;
  }

  return [hit.location, resultSnippet(hit)].filter(Boolean).join(' · ') || null;
}

/**
 * A result row's tooltip: its title and meta line in full, since the row may
 * cut them short. Development builds add the search channels that found it.
 */
export function resultTitle(hit: SearchResult, meta: string | null): string {
  const text = meta ? `${hit.label} — ${meta}` : hit.label;
  return import.meta.env.DEV ? `${text}\n${searchChannelTitle(hit)}` : text;
}

/**
 * Canonical display meta for each kind. `tone` drives the Chip color;
 * `plural` names the kind in the filtered input placeholder.
 */
const KIND_META: Record<Kind, { label: string; plural: string; tone: ChipTone }> = {
  doc: { label: 'Doc', plural: 'docs', tone: 'primary' },
  thread: { label: 'Thread', plural: 'threads', tone: 'primary' },
  message: { label: 'Message', plural: 'messages', tone: 'primary' },
  container: { label: 'Container', plural: 'containers', tone: 'primary' },
  image: { label: 'Image', plural: 'images', tone: 'primary' },
  memory: { label: 'Memory', plural: 'memories', tone: 'warning' },
  thread_summary: { label: 'Summary', plural: 'summaries', tone: 'primary' },
  tool: { label: 'Tool', plural: 'tools', tone: 'success' },
  agent: { label: 'Agent', plural: 'agents', tone: 'success' },
  table: { label: 'Table', plural: 'tables', tone: 'primary' },
  entry: { label: 'Entry', plural: 'entries', tone: 'primary' },
};

/**
 * Guarded lookup into {@link KIND_META}. A kind outside the node model (a
 * persisted filter chip, a stale server hit) resolves to a neutral chip
 * instead of `undefined.tone`, which would throw during render and blank the
 * whole app.
 */
export function kindMeta(kind: string): { label: string; plural: string; tone: ChipTone } {
  return (
    KIND_META[kind as Kind] ?? {
      label: kind || 'Result',
      plural: kind ? `${kind} results` : 'results',
      tone: 'muted',
    }
  );
}

export const COVERAGE_LABELS: Record<PaletteCoverageMode, string> = {
  hybrid: 'Hybrid',
  semantic: 'Semantic',
  lexical: 'Lexical',
  disabled: 'Disabled',
};

// `entry:` (table rows) and `file:` are palette-only filters, not kind prefixes.
export const FOOTER_FILTERS = [...PALETTE_KIND_FILTER_PREFIXES, 'entry', 'file'] as const;
type FooterFilterPrefix = string;
export type FooterFilterEntry = {
  p: FooterFilterPrefix;
  meta: { kind: Kind; label: string } | null;
};

function searchChannelTitle(hit: SearchResult): string {
  return hit.channels.length > 0
    ? `Search channels: ${hit.channels.join(' + ')}`
    : 'Lexical result';
}

export function semanticEmptyState(
  status: PaletteSemanticStatus | 'unknown',
  reason?: string | null
): { message: string } | null {
  switch (status) {
    case 'disabled':
      return { message: 'Semantic disabled' };
    case 'unavailable':
      // The server-supplied reason explains why vector search degraded —
      // e.g. "The local embedding model is not installed yet."
      return { message: reason ?? 'Semantic unavailable' };
    default:
      return null;
  }
}
