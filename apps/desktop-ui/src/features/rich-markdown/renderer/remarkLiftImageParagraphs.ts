import type { Heading, Image, Link, Paragraph, PhrasingContent, Root } from 'mdast';
import type { Parent as UnistParent } from 'unist';
import { visit, SKIP } from 'unist-util-visit';
import { INCLUDABLE_KINDS, parseNodeRef } from './nodeRef';

/**
 * True for images that render as block elements: includes (`doc-…`, `page:…`
 * → `TransclusionBlock`) and stored images (`image-…` → `StoredImagePreview`,
 * whose loading and error states are `<div>`s). Both must leave the `<p>`,
 * since a `<div>` inside a `<p>` is invalid and React flags it.
 */
function isLiftableImage(img: Image): boolean {
  const ref = parseNodeRef(img.url || '');
  if (!ref) return false;
  return INCLUDABLE_KINDS.has(ref.kind) || ref.kind === 'image';
}

/**
 * A stored image in link form (`[filename.png](image-…)`) parses as a `link`
 * but also renders as `<StoredImagePreview>`, so it is lifted too. Doc links
 * stay inline as chips.
 */
function isLiftableImageLink(node: PhrasingContent): node is Link {
  if (node.type !== 'link') return false;
  const ref = parseNodeRef(node.url || '');
  return ref?.kind === 'image';
}

/** True for either the image-form or link-form of a block-level stored image / include. */
function isLiftableChild(node: PhrasingContent): boolean {
  if (node.type === 'image') return isLiftableImage(node as Image);
  return isLiftableImageLink(node);
}

/**
 * Lift block-rendering images (`![](doc-…)`, `![](page:…)`, `![](image-…)`)
 * out of their paragraphs: a lone image replaces the paragraph, otherwise the
 * paragraph is split around it. Also lifts an include out of a setext heading
 * (`![](doc-x)` followed by `---`), which would otherwise swallow it.
 */
export default function remarkLiftImageParagraphs() {
  return (tree: Root) => {
    // A heading whose only child is a liftable image (the setext case) is
    // replaced by the image.
    visit(tree, 'heading', (node: Heading, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      if (node.children.length !== 1) return;
      const only = node.children[0];
      if (only.type !== 'image') return;
      const img = only as Image;
      if (!isLiftableImage(img)) return;
      flagAsBlockInclude(img);
      (parent as UnistParent).children[index] = img;
      return SKIP;
      // Link-form stored images never end up as setext heading text.
    });

    visit(tree, 'paragraph', (node: Paragraph, index, parent) => {
      if (!parent || typeof index !== 'number') return;

      // Indices of liftable children, in image or link form.
      const imageIndices: number[] = [];
      for (let i = 0; i < node.children.length; i++) {
        if (isLiftableChild(node.children[i])) {
          imageIndices.push(i);
        }
      }

      if (imageIndices.length === 0) return;

      // A lone liftable child replaces the paragraph. Only image nodes get
      // the block-include flag; the `a` renderer needs none.
      if (node.children.length === 1) {
        const only = node.children[0];
        if (only.type === 'image') flagAsBlockInclude(only as Image);
        (parent as UnistParent).children[index] = only;
        return SKIP;
      }

      // Otherwise split the paragraph around each liftable child.
      const replacements: (Paragraph | Image | Link)[] = [];
      let currentChildren: PhrasingContent[] = [];

      for (let i = 0; i < node.children.length; i++) {
        if (imageIndices.includes(i)) {
          // Flush any accumulated text children as a paragraph
          if (currentChildren.length > 0) {
            const trimmed = trimBoundaryWhitespace(currentChildren);
            if (trimmed.length > 0) {
              replacements.push({ type: 'paragraph', children: trimmed });
            }
            currentChildren = [];
          }
          // Lift the child, flagging image nodes only.
          const lifted = node.children[i];
          if (lifted.type === 'image') flagAsBlockInclude(lifted as Image);
          replacements.push(lifted as Image | Link);
        } else {
          currentChildren.push(node.children[i]);
        }
      }

      // Flush remaining children
      if (currentChildren.length > 0) {
        const trimmed = trimBoundaryWhitespace(currentChildren);
        if (trimmed.length > 0) {
          replacements.push({ type: 'paragraph', children: trimmed });
        }
      }

      // Replace the original paragraph with the split nodes
      (parent as UnistParent).children.splice(index, 1, ...replacements);
      return SKIP;
    });
  };
}

type HastData = { hProperties?: Record<string, string> };

/** Tag an image so the `img` renderer emits TransclusionBlock. */
function flagAsBlockInclude(img: Image) {
  img.data = img.data ?? {};
  const d = img.data as HastData;
  d.hProperties = { ...(d.hProperties ?? {}), 'data-block-include': '' };
}

/**
 * Remove leading/trailing whitespace-only text nodes.
 * Keeps the paragraph clean after splitting around an image.
 */
function trimBoundaryWhitespace(children: PhrasingContent[]): PhrasingContent[] {
  let start = 0;
  let end = children.length - 1;
  while (start <= end && isWhitespaceOnly(children[start])) start++;
  while (end >= start && isWhitespaceOnly(children[end])) end--;
  return children.slice(start, end + 1);
}

function isWhitespaceOnly(node: PhrasingContent): boolean {
  return node.type === 'text' && /^\s*$/.test(node.value);
}
