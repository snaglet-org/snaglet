/**
 * Turn bare ids in text into mdast links (`doc-…` → chip) and images
 * (`!doc-…` → include block), along with agent mentions and inline code that
 * is exactly an id. Link labels and code blocks are left alone. Must run
 * before `remarkLiftImageParagraphs` so a standalone `!doc-…` paragraph
 * becomes a block include.
 */
import type { Plugin } from 'unified';
import type { Root, Text, InlineCode, Link, Image, PhrasingContent } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';
import { NODE_ID_BODY_SOURCE, PREFIXED_KINDS } from './nodeRef';
import { findAgentMentionTokens } from '@desktop/utils/agentMentionMarkdown';
import { getAgentsCached } from '@desktop/features/rich-markdown/editor/agentMentionCache';

// Only valid id bodies match (`NODE_ID_BODY_SOURCE`), so `task-foo` stays
// text. The lookarounds keep a partial id from being cut out of a longer
// token.
const BARE_NODE_RE = new RegExp(
  `(?<![A-Za-z0-9_\\-])(!?)((?:${PREFIXED_KINDS.join('|')})-${NODE_ID_BODY_SOURCE})(?![A-Za-z0-9_\\-])`,
  'g'
);

// Exact match for `inlineCode`: a backticked id (or `!id`) is a chip too.
const INLINECODE_NODE_RE = new RegExp(
  `^(!?)((?:${PREFIXED_KINDS.join('|')})-${NODE_ID_BODY_SOURCE})$`
);

function splitValue(value: string): PhrasingContent[] | null {
  if (!value) return null;
  const out: PhrasingContent[] = [];
  let cursor = 0;
  let matched = false;
  const agentMentions = findAgentMentionTokens(value, getAgentsCached());
  for (const mention of agentMentions) {
    matched = true;
    const start = mention.start;
    if (start > cursor) {
      const prefix = splitBareNodeValue(value.slice(cursor, start));
      out.push(...prefix);
    }
    out.push({
      type: 'link',
      url: mention.href,
      children: [{ type: 'text', value: mention.title.trim() || 'Agent' } satisfies Text],
    } satisfies Link);
    cursor = mention.end;
  }
  if (cursor < value.length) {
    out.push(...splitBareNodeValue(value.slice(cursor)));
  }
  return matched || out.some((node) => node.type !== 'text' || node.value !== value) ? out : null;
}

function splitBareNodeValue(value: string): PhrasingContent[] {
  if (!value) return [];
  BARE_NODE_RE.lastIndex = 0;
  const out: PhrasingContent[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_NODE_RE.exec(value)) !== null) {
    const [full, bang, id] = match;
    const start = match.index;
    if (start > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, start) } satisfies Text);
    }
    if (bang === '!' || id.startsWith('image-')) {
      // `!doc-…` becomes an image for the `img` handler; only docs get the
      // block-include property `remarkLiftImageParagraphs` would add. A bare
      // `image-…` id is always an image.
      out.push({
        type: 'image',
        url: id,
        alt: '',
        data: id.startsWith('doc-') ? { hProperties: { 'data-block-include': '' } } : undefined,
      } satisfies Image);
    } else {
      out.push({
        type: 'link',
        url: id,
        children: [{ type: 'text', value: id } satisfies Text],
      } satisfies Link);
    }
    cursor = start + full.length;
  }
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) } satisfies Text);
  }
  return out.length > 0 ? out : [{ type: 'text', value } satisfies Text];
}

/**
 * The link or image for inline code that is exactly a node id (optionally
 * `!`-prefixed), or null so other code stays literal.
 */
function rewriteInlineCode(value: string): Link | Image | null {
  const m = INLINECODE_NODE_RE.exec(value);
  if (!m) return null;
  const [, bang, id] = m;
  if (bang === '!' || id.startsWith('image-')) {
    return {
      type: 'image',
      url: id,
      alt: '',
      data: id.startsWith('doc-') ? { hProperties: { 'data-block-include': '' } } : undefined,
    } satisfies Image;
  }
  return {
    type: 'link',
    url: id,
    children: [{ type: 'text', value: id } satisfies Text],
  } satisfies Link;
}

const remarkBareNodeRefs: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      // A link's label stays a label.
      if (parent.type === 'link' || parent.type === 'linkReference') return;
      const replacements = splitValue(node.value);
      if (!replacements) return;
      (parent.children as PhrasingContent[]).splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });
    // Backticked ids parse as inlineCode, which the text pass doesn't visit.
    visit(tree, 'inlineCode', (node: InlineCode, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      if (parent.type === 'link' || parent.type === 'linkReference') return;
      const replacement = rewriteInlineCode(node.value);
      if (!replacement) return;
      (parent.children as PhrasingContent[]).splice(index, 1, replacement);
      return [SKIP, index + 1];
    });
  };
};

export default remarkBareNodeRefs;
