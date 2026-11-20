/**
 * Rewrite the server's `<image id="image-…"/>` markers (tool screenshots,
 * uploads; grammar from the server's `imageMarkers.ts`, self-closing or
 * paired) into mdast image nodes whose `src` is the id. remark-parse usually
 * yields the marker as inline `html`, but it can also sit inside `text`, so
 * both are walked. Runs before `remarkLiftImageParagraphs`.
 */
import type { Plugin } from 'unified';
import type { Root, Text, Image, Html, PhrasingContent } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

const MARKER_RE = /<image\s+id="([^"]+)"\s*\/?>(?:<\/image>)?/gi;

function splitValue(value: string): PhrasingContent[] | null {
  if (!value || !value.includes('<image')) return null;
  MARKER_RE.lastIndex = 0;
  const out: PhrasingContent[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let matched = false;
  while ((match = MARKER_RE.exec(value)) !== null) {
    matched = true;
    const [full, id] = match;
    const start = match.index;
    if (start > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, start) } satisfies Text);
    }
    out.push({ type: 'image', url: id, alt: '' } satisfies Image);
    cursor = start + full.length;
  }
  if (!matched) return null;
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) } satisfies Text);
  }
  return out;
}

const remarkImageMarkers: Plugin<[], Root> = () => {
  return (tree) => {
    // `html` nodes: the usual place for a marker.
    visit(tree, 'html', (node: Html, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      const replacements = splitValue(node.value);
      if (!replacements) return;
      (parent.children as PhrasingContent[]).splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });

    // `text` nodes: a marker that arrived escaped or wrapped.
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      const replacements = splitValue(node.value);
      if (!replacements) return;
      (parent.children as PhrasingContent[]).splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });
  };
};

export default remarkImageMarkers;
