/**
 * speakabilityFilter — decide what a segment should actually SOUND like.
 *
 * The TTS pipeline never vocalizes structured content: fenced code, markdown
 * tables, and long lists are replaced with a short spoken placeholder ("I've
 * put a table in the thread") so the listener knows to look at the screen.
 * Prose is cleaned of markup that reads badly aloud — emphasis markers, inline
 * code backticks, link URLs — and `@Name` mentions are spoken as plain names
 * ("at Name" would be wrong). Pure functions, no state.
 *
 * Input is a {@link TextSegment} from the {@link sentenceSegmenter}; output is a
 * {@link SpeakableResult} the pipeline turns into audio (or skips when empty).
 */

import type { TextSegment } from './sentenceSegmenter';

export interface SpeakabilityOptions {
  /** Lists with more than this many items become a placeholder. Default 4. */
  readonly maxListItems?: number;
  /** Placeholder sentences (override for tone/i18n). */
  readonly placeholders?: Partial<Record<'code' | 'table' | 'list', string>>;
}

type SpeakableKind = 'sentence' | 'placeholder' | 'empty';

export interface SpeakableResult {
  /** Text to synthesize. Empty string when `kind === 'empty'`. */
  readonly speak: string;
  readonly kind: SpeakableKind;
  /** For placeholders: which block type it stands in for. */
  readonly placeholderFor?: 'code' | 'table' | 'list';
}

const DEFAULT_PLACEHOLDERS = {
  code: "I've put a code block in the thread.",
  table: "I've put a table in the thread.",
  list: "I've put a list in the thread.",
} as const;

const EMPTY: SpeakableResult = { speak: '', kind: 'empty' };

/**
 * Node-reference grammar, for SPEECH only. Mirrors the canonical chip parser in
 * `apps/desktop-ui/src/features/rich-markdown/renderer/nodeRef.ts` — which lives
 * in the UI package and cannot be imported server-side — but kept deliberately
 * tiny: we only need to recognize a node id/href and name its KIND, never render
 * a chip. The point is that a wikilink SPEAKS its human title (or a generic
 * noun), never a raw id like "doc-1111111111111-aaaaaaaaa".
 */
const NODE_KIND_ALT =
  'thread_summary|library_node|container|message|project|memory|sketch|thread|agent|image|task|tool|post|doc|page';
// A node id body is `<timestamp-millis>-<base36>` (generateId) or a UUID.
const NODE_ID_BODY =
  '(?:\\d{10,}-[A-Za-z0-9]+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
// A whole href/token: `kind:uuid` (still found in older content) or prefixed-id `kind-body`.
const NODE_HREF_RE = new RegExp(
  `^(?:(${NODE_KIND_ALT}):|(${NODE_KIND_ALT})-)${NODE_ID_BODY}$`,
  'i'
);
// The same, unanchored, for a bare id sitting in prose ("see doc-1784…-abc").
// A capturing boundary (not a lookbehind) keeps it portable and re-emitted.
const NODE_ID_TOKEN_RE = new RegExp(
  `(^|[^\\w-])(?:(${NODE_KIND_ALT}):|(${NODE_KIND_ALT})-)${NODE_ID_BODY}(?![\\w-])`,
  'gi'
);

const KNOWN_NOUN_KINDS = new Set([
  'doc',
  'thread',
  'container',
  'message',
  'memory',
  'tool',
  'project',
  'agent',
  'image',
  'sketch',
  'post',
]);

/** Speak a node kind as a plain noun ("doc", "thread", …); "link" if unknown. */
function nodeKindNoun(kind: string): string {
  const k = kind.toLowerCase();
  if (k === 'page' || k === 'task') return 'doc'; // older kind names → doc
  if (k === 'thread_summary') return 'thread summary';
  if (k === 'library_node') return 'reference';
  return KNOWN_NOUN_KINDS.has(k) ? k : 'link';
}

/** The node kind for an href/token, or null when it isn't a node ref. */
function nodeKindOf(token: string): string | null {
  const m = NODE_HREF_RE.exec(token.trim());
  return m ? (m[1] ?? m[2]).toLowerCase() : null;
}

/** True when a string is *itself* a bare node id/href (not a human label). */
function isNodeToken(token: string): boolean {
  return nodeKindOf(token) !== null;
}

/**
 * The spoken text for one markdown link / image. Node references speak their
 * human label, or the kind noun when the label is missing or is itself the raw
 * id. Non-node links speak their label text; empty-alt images drop.
 */
function spokenForLink(label: string, href: string): string {
  const kind = nodeKindOf(href);
  if (kind) {
    const t = label.trim();
    return t && !isNodeToken(t) ? label : nodeKindNoun(kind);
  }
  return label; // plain URL / non-node: `[text](url)` -> text, `![alt](url)` -> alt
}

/** Speak an Obsidian-style `[[target|alias]]` wikilink as its title (or noun). */
function spokenForWikiLink(inner: string): string {
  const parts = inner
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  // Obsidian puts the alias last; prefer any human-readable (non-id) part.
  const label = [...parts].reverse().find((p) => !isNodeToken(p));
  if (label) return label;
  const idPart = parts.find(isNodeToken);
  const kind = idPart ? nodeKindOf(idPart) : null;
  return kind ? nodeKindNoun(kind) : 'link';
}

/** Strip markdown/markup that reads badly aloud and normalize mentions. */
export function cleanProseForSpeech(input: string): string {
  let s = input;

  // Obsidian-style wikilinks [[target]] / [[target|alias]] -> title (or a kind
  // noun for a bare id). Done first: these have no `(url)` part for the markdown
  // link pass below to catch.
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => spokenForWikiLink(inner));
  // Markdown links [text](url) and images ![alt](url) -> spoken label. Node
  // references (`[Title](doc-…)`, `![](doc-…)`, or a link whose label is itself
  // the id) speak the title or a kind noun — never the raw id.
  s = s.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_m, label: string, href: string) =>
    spokenForLink(label, href)
  );
  // Autolinks <https://...> and bare URLs -> "a link".
  s = s.replace(/<https?:\/\/[^>]+>/gi, 'a link');
  s = s.replace(/\bhttps?:\/\/\S+/gi, 'a link');
  // Inline code `x` -> x.
  s = s.replace(/`([^`]+)`/g, '$1');
  // Emphasis: **x** __x__ *x* _x_ ~~x~~ -> x.
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g, '$1$2');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // Leading block markers: heading #, blockquote >, list bullet/number.
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/, '');
  s = s.replace(/^[ \t]*>+[ \t]*/, '');
  s = s.replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/, '');
  // @Name / @Display-Name -> Name (never "at Name").
  s = s.replace(/@([A-Za-z0-9][A-Za-z0-9._-]*)/g, '$1');
  // Bare node ids still sitting in prose ("see doc-1784…-abc for details") ->
  // the kind noun. Runs after link handling so it only catches ids that were
  // never wrapped in a chip/link.
  s = s.replace(NODE_ID_TOKEN_RE, (_m, pre: string, legacy?: string, prefixed?: string) => {
    return `${pre}${nodeKindNoun(legacy ?? prefixed ?? '')}`;
  });
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Count list items in a grouped list segment. */
function countListItems(block: string): number {
  return block.split('\n').filter((line) => /^[ \t]*([-*+]|\d+[.)])[ \t]+\S/.test(line)).length;
}

/** Render a short list as spoken sentences (one clause per item). */
function shortListToSpeech(block: string): string {
  const items = block
    .split('\n')
    .map((line) => line.replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/, '').trim())
    .filter(Boolean)
    .map((item) => cleanProseForSpeech(item));
  return items
    .filter(Boolean)
    .map((item) => (/[.!?…]$/.test(item) ? item : `${item}.`))
    .join(' ');
}

/** Decide how a single segment should be spoken. */
export function filterSegment(
  segment: TextSegment,
  options: SpeakabilityOptions = {}
): SpeakableResult {
  const placeholders = { ...DEFAULT_PLACEHOLDERS, ...(options.placeholders ?? {}) };
  const maxListItems = options.maxListItems ?? 4;

  switch (segment.kind) {
    case 'code':
      return { speak: placeholders.code, kind: 'placeholder', placeholderFor: 'code' };
    case 'table':
      return { speak: placeholders.table, kind: 'placeholder', placeholderFor: 'table' };
    case 'list': {
      const items = countListItems(segment.text);
      if (items > maxListItems) {
        return { speak: placeholders.list, kind: 'placeholder', placeholderFor: 'list' };
      }
      const speak = shortListToSpeech(segment.text);
      return speak ? { speak, kind: 'sentence' } : EMPTY;
    }
    case 'sentence':
    default: {
      const speak = cleanProseForSpeech(segment.text);
      return speak ? { speak, kind: 'sentence' } : EMPTY;
    }
  }
}

/**
 * Filter a batch of segments, dropping empties and collapsing consecutive
 * identical placeholders (a multi-part table never says "I've put a table in
 * the thread" twice in a row).
 */
export function filterSegments(
  segments: readonly TextSegment[],
  options: SpeakabilityOptions = {}
): SpeakableResult[] {
  const out: SpeakableResult[] = [];
  for (const seg of segments) {
    const r = filterSegment(seg, options);
    if (r.kind === 'empty') continue;
    const prev = out[out.length - 1];
    if (
      r.kind === 'placeholder' &&
      prev &&
      prev.kind === 'placeholder' &&
      prev.placeholderFor === r.placeholderFor
    ) {
      continue; // suppress repeated block placeholder
    }
    out.push(r);
  }
  return out;
}

/** Convenience: the spoken string for a segment, or null if nothing to say. */
export function toSpeech(segment: TextSegment, options?: SpeakabilityOptions): string | null {
  const r = filterSegment(segment, options);
  return r.kind === 'empty' ? null : r.speak;
}
