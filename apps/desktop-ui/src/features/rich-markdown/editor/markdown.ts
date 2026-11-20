// Converts between stored markdown (`text [Title](href) text`, `![](href)`)
// and the ProseMirror doc of paragraphs and chips: `markdownToDoc` and
// `docToMarkdown` round-trip. Only links whose href is a node ref become chips;
// other links and prose stay text, verbatim.

import type { Editor } from '@tiptap/react';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
  BARE_TABLE_ID_SOURCE,
  NODE_HREF_SOURCE,
  TOOL_HREF_SOURCE,
  canonicalNodeHref,
  idOnlyChipValue,
  parseNodeRef,
  tableChipHrefForBareId,
} from '@desktop/features/rich-markdown/renderer/nodeRef';
import { agentMentionMarkdown, findAgentMentionTokens } from '@desktop/utils/agentMentionMarkdown';
import { getAgentsCached } from './agentMentionCache';
import { escapeChipTitle, unescapeChipTitle } from '@desktop/utils/nodeChip';

const CHIP_RE = /(!?)\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

// Matches a bare node-ref id anywhere in text, in the same scheme and
// prefixed forms `parseNodeRef` accepts, so hyphenated words don't match.
const BARE_ID_RE = new RegExp(NODE_HREF_SOURCE, 'g');
// Id-only inputs also store a table chip as its bare catalog id and a tool
// chip as its `tool:<slug id>` href; prose chips neither.
const ID_ONLY_BARE_RE = new RegExp(
  `${TOOL_HREF_SOURCE}|${NODE_HREF_SOURCE}|${BARE_TABLE_ID_SOURCE}`,
  'g'
);

interface BareIdOptions {
  parseBareIds: boolean;
  /** Also chip bare table catalog ids and `tool:<slug id>` hrefs (with
   *  `parseBareIds`). Id-only (`passIdOnly`) inputs only: prose never chips a
   *  bare `table-…` or `tool:create`. */
  parseBareTableIds: boolean;
}

interface TextToken {
  type: 'text';
  text: string;
}
interface ChipToken {
  type: 'chip';
  href: string;
  title: string;
  include: boolean;
}
type Token = TextToken | ChipToken;

/** Tokenize one line of markdown into text and chip tokens: agent mentions,
 *  `[Title](href)` and `![](href)`, plus bare node ids when `parseBareIds`
 *  is set. */
function tokenizeLine(value: string, { parseBareIds, parseBareTableIds }: BareIdOptions): Token[] {
  // First pass: explicit agent mentions, then link/include markdown forms.
  const tokens: Token[] = [];
  let last = 0;
  const agentMentions = findAgentMentionTokens(value, getAgentsCached());
  for (const mention of agentMentions) {
    if (mention.start > last) {
      tokens.push(...tokenizeChipMarkdown(value.slice(last, mention.start)));
    }
    tokens.push({ type: 'chip', href: mention.href, title: mention.title, include: false });
    last = mention.end;
  }
  if (last < value.length) tokens.push(...tokenizeChipMarkdown(value.slice(last)));

  if (!parseBareIds) return tokens;

  // Second pass: walk the text tokens and split out any bare node
  // ids. Chip tokens from the first pass are kept as-is.
  const out: Token[] = [];
  for (const t of tokens) {
    if (t.type !== 'text') {
      out.push(t);
      continue;
    }
    let cursor = 0;
    const bareRe = parseBareTableIds ? ID_ONLY_BARE_RE : BARE_ID_RE;
    bareRe.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = bareRe.exec(t.text))) {
      const match = mm[0];
      const href = tableChipHrefForBareId(match) ?? match;
      if (mm.index > cursor) out.push({ type: 'text', text: t.text.slice(cursor, mm.index) });
      out.push({ type: 'chip', href, title: '', include: false });
      cursor = mm.index + match.length;
    }
    if (cursor < t.text.length) out.push({ type: 'text', text: t.text.slice(cursor) });
  }
  return out;
}

function tokenizeChipMarkdown(value: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  CHIP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHIP_RE.exec(value))) {
    const [whole, bang, title, href] = m;
    if (m.index > last) tokens.push({ type: 'text', text: value.slice(last, m.index) });
    if (parseNodeRef(href)) {
      tokens.push({
        type: 'chip',
        href,
        title: unescapeChipTitle(title ?? ''),
        include: bang === '!',
      });
    } else {
      tokens.push({ type: 'text', text: whole });
    }
    last = m.index + whole.length;
  }
  if (last < value.length) tokens.push({ type: 'text', text: value.slice(last) });
  return tokens;
}

export function markdownToDoc(
  markdown: string,
  schema: Schema,
  options: { parseBareIds?: boolean; parseBareTableIds?: boolean } = {}
): PMNode {
  const paragraphType = schema.nodes.paragraph;
  const chipType = schema.nodes.chip;
  if (!paragraphType || !chipType) {
    throw new Error('Editor schema missing paragraph or chip node');
  }
  const bareIds: BareIdOptions = {
    parseBareIds: options.parseBareIds === true,
    parseBareTableIds: options.parseBareIds === true && options.parseBareTableIds === true,
  };
  const lines = markdown.split('\n');
  const paragraphs = lines.map((line) => {
    const tokens = tokenizeLine(line, bareIds);
    const inline: PMNode[] = [];
    for (const t of tokens) {
      if (t.type === 'text') {
        if (t.text.length > 0) inline.push(schema.text(t.text));
      } else {
        const ref = parseNodeRef(t.href);
        inline.push(
          chipType.create({
            href: t.href,
            title: t.title,
            include: t.include,
            kind: ref?.kind ?? 'doc',
          })
        );
      }
    }
    return paragraphType.create(null, inline);
  });
  return schema.nodes.doc.create(
    null,
    paragraphs.length > 0 ? paragraphs : [paragraphType.create()]
  );
}

export function docToMarkdown(editor: Editor, options: { passIdOnly?: boolean } = {}): string {
  const passIdOnly = options.passIdOnly === true;
  const lines: string[] = [];
  editor.state.doc.forEach((paragraph) => {
    if (paragraph.type.name !== 'paragraph') return;
    let line = '';
    paragraph.forEach((inline) => {
      if (inline.type.name === 'text') {
        line += inline.text ?? '';
      } else if (inline.type.name === 'chip') {
        const href = canonicalNodeHref(String(inline.attrs.href ?? ''));
        const title = String(inline.attrs.title ?? '');
        const include = inline.attrs.include === true;
        const kind = String(inline.attrs.kind ?? '');
        if (passIdOnly) {
          // The host stores chips as raw ids — emit just the href.
          // Include semantics aren't meaningful here (a tool param
          // taking an id doesn't have a "parse content" toggle on the
          // server side); we drop the bang.
          line += idOnlyChipValue(href);
        } else {
          line +=
            !include && kind === 'agent'
              ? agentMentionMarkdown(title)
              : include
                ? `![](${href})`
                : `[${escapeChipTitle(title)}](${href})`;
        }
      }
    });
    lines.push(line);
  });
  return lines.join('\n');
}
