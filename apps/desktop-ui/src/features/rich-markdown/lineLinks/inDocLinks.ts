// inDocLinks.ts — links to a heading of the doc they sit in: `#h=…`, GitHub's
// `#slug`, or the doc's own id with `#h=…`. They scroll there in place, as an
// outline jump does (jump.ts), instead of opening anything. The rendered
// editor follows one on a click; the markdown view on ⌘-click, since a plain
// click there places the caret.

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  LINK_LABEL_SOURCE,
  maskCodeRegions,
  parseInDocHeadingHref,
  splitDocRef,
  type HeadingRef,
} from '@snaglet/shared/utils';

export interface InDocLink {
  /** The heading the link names. */
  ref: HeadingRef;
  /** The href as written, for a "no such heading" note. */
  href: string;
}

/** The heading a link in doc `docId` scrolls to in place, or null. */
function inDocHeading(href: string, docId: string): HeadingRef | null {
  const relative = parseInDocHeadingHref(href);
  if (relative) return relative;
  const { id, anchor } = splitDocRef(href);
  return id === docId && anchor && 'heading' in anchor ? anchor.heading : null;
}

/** `[label](href)` with an optional leading `!`; group 1 is the `!`, group 2 the href. */
const LINK_RE = new RegExp(String.raw`(!?)\[${LINK_LABEL_SOURCE}\]\(([^)\s]+)\)`, 'g');

/**
 * The in-doc heading link written around source offset `offset` (the caret a
 * click leaves), or null. Code and transclusions (`![…](…)`) are not links.
 */
export function inDocLinkAt(markdown: string, offset: number, docId: string): InDocLink | null {
  const masked = maskCodeRegions(markdown);
  const start = masked.lastIndexOf('\n', offset - 1) + 1;
  const end = masked.indexOf('\n', offset);
  const line = masked.slice(start, end < 0 ? masked.length : end);
  for (const match of line.matchAll(LINK_RE)) {
    const from = start + match.index;
    if (offset < from || offset > from + match[0].length) continue;
    if (match[1] === '!') return null;
    const href = match[2] ?? '';
    const ref = inDocHeading(href, docId);
    return ref ? { ref, href } : null;
  }
  return null;
}

export const inDocLinkKey = new PluginKey('inDocLink');

/**
 * The in-doc heading link a click on the editor's own text landed on. Not a
 * link inside a read-only island (a transcluded doc: its links name its own
 * headings), and not the end of a drag that selected text.
 */
function clickedLink(view: EditorView, event: MouseEvent): InDocLink | null {
  if (event.button !== 0 || event.shiftKey || event.altKey) return null;
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!anchor || anchor.closest('[contenteditable]') !== view.dom) return null;
  const selection = view.dom.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) return null;
  const href = anchor.getAttribute('href') ?? '';
  const ref = parseInDocHeadingHref(href);
  return ref ? { ref, href } : null;
}

/** Rendered editor: a click on an in-doc heading link calls `follow` instead of placing the caret. */
export function createInDocLinkPlugin(follow: (link: InDocLink) => void): Plugin {
  return new Plugin({
    key: inDocLinkKey,
    props: {
      // Claim the click so ProseMirror leaves the selection where it was.
      handleClick: (view, _pos, event) => clickedLink(view, event) !== null,
      handleDOMEvents: {
        click: (view, event) => {
          if (event.defaultPrevented) return false;
          const link = clickedLink(view, event);
          if (!link) return false;
          event.preventDefault();
          follow(link);
          return true;
        },
      },
    },
  });
}
