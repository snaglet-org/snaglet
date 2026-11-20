// Live-preview styling for the raw markdown (source) editor. Splits the text
// into lines and spans by markdown role, keeping every character, so a styled
// copy drawn behind the textarea lines up with what is typed. The text itself
// stays plain markdown. Line-based on purpose: it only has to look right as
// you type, not parse every CommonMark corner.

type SourceLineKind = 'text' | 'heading' | 'list' | 'quote' | 'fence' | 'code' | 'rule';

type SourceSpanKind = 'plain' | 'marker' | 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'url';

interface SourceSpan {
  kind: SourceSpanKind;
  text: string;
}

export interface SourceLine {
  kind: SourceLineKind;
  /** Heading level, 1-6. */
  level?: number;
  spans: SourceSpan[];
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^( {0,3}#{1,6}(?:[ \t]+|$))(.*)$/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^( {0,3}>[ \t]?)(.*)$/;
const LIST_RE = /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)(.*)$/;

// Inline spans, first match wins: code, bold, strike, italic, link.
const INLINE_RE = new RegExp(
  [
    '(`[^`\\n]+`)',
    '(\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)',
    '(~~[^~\\n]+~~)',
    '(\\*[^*\\s][^*\\n]*?\\*|(?<![\\w])_[^_\\s][^_\\n]*?_(?![\\w]))',
    '(!?\\[[^\\]\\n]*\\]\\([^)\\s]*\\))',
  ].join('|'),
  'g'
);

function wrapped(kind: SourceSpanKind, text: string, marker: number): SourceSpan[] {
  return [
    { kind: 'marker', text: text.slice(0, marker) },
    { kind, text: text.slice(marker, text.length - marker) },
    { kind: 'marker', text: text.slice(text.length - marker) },
  ];
}

function linkSpans(text: string): SourceSpan[] {
  const open = text.indexOf('[') + 1;
  const close = text.indexOf('](');
  return [
    { kind: 'marker', text: text.slice(0, open) },
    { kind: 'link', text: text.slice(open, close) },
    { kind: 'marker', text: '](' },
    { kind: 'url', text: text.slice(close + 2, -1) },
    { kind: 'marker', text: ')' },
  ].filter((span) => span.text.length > 0) as SourceSpan[];
}

function inlineSpans(text: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > at) spans.push({ kind: 'plain', text: text.slice(at, index) });
    const [whole, code, bold, strike, italic] = match;
    if (code) spans.push({ kind: 'code', text: whole });
    else if (bold) spans.push(...wrapped('bold', whole, 2));
    else if (strike) spans.push(...wrapped('strike', whole, 2));
    else if (italic) spans.push(...wrapped('italic', whole, 1));
    else spans.push(...linkSpans(whole));
    at = index + whole.length;
  }
  if (at < text.length) spans.push({ kind: 'plain', text: text.slice(at) });
  return spans;
}

function prefixed(kind: SourceLineKind, marker: string, rest: string): SourceLine {
  return { kind, spans: [{ kind: 'marker', text: marker }, ...inlineSpans(rest)] };
}

export function highlightMarkdownSource(text: string): SourceLine[] {
  let fence: string | null = null;
  return text.split('\n').map((line): SourceLine => {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
        return { kind: 'fence', spans: [{ kind: 'marker', text: line }] };
      }
      return { kind: 'code', spans: line ? [{ kind: 'plain', text: line }] : [] };
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return { kind: 'fence', spans: [{ kind: 'marker', text: line }] };
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].trim().length;
      return { ...prefixed('heading', heading[1], heading[2]), level };
    }
    if (RULE_RE.test(line)) return { kind: 'rule', spans: [{ kind: 'marker', text: line }] };
    const quote = QUOTE_RE.exec(line);
    if (quote) return prefixed('quote', quote[1], quote[2]);
    const list = LIST_RE.exec(line);
    if (list) return prefixed('list', list[1], list[2]);
    return { kind: 'text', spans: inlineSpans(line) };
  });
}
