import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import {
  externalUrl,
  hasOpenLinkModifier,
  inEditableText,
  launchExternalUrl,
  openExternalUrl,
  openLinkHint,
} from '@desktop/utils/externalLinks';

interface LinkOpenOptions {
  /** Opens an external URL; the system browser by default. */
  openUrl: (url: string) => Promise<void>;
}

const linkOpenKey = new PluginKey<DecorationSet>('linkOpen');

/** The external URL a ⌘/Ctrl-click on a link in this editor's text opens, or null. */
function modClickUrl(view: EditorView, event: MouseEvent): string | null {
  if (event.button !== 0 || !hasOpenLinkModifier(event)) return null;
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!anchor || !view.dom.contains(anchor) || !inEditableText(anchor)) return null;
  return externalUrl(anchor.getAttribute('href') ?? '', window.location.origin);
}

/** A hover hint over every external link in the doc. Decorations, not
 *  attributes on the link's own `<a>`, so the hint never reaches the doc. */
function linkHints(doc: PMNode): DecorationSet {
  const hints: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = node.marks.find((mark) => mark.type.name === 'link');
    const url = link ? externalUrl(String(link.attrs.href ?? ''), window.location.origin) : null;
    if (url) hints.push(Decoration.inline(pos, pos + node.nodeSize, { title: openLinkHint(url) }));
  });
  return DecorationSet.create(doc, hints);
}

/**
 * LinkOpen — ⌘-click (Ctrl-click off macOS) on a web or mail link in the
 * rich editor opens it in the system browser. A plain click still places the
 * caret, so link text stays editable, and hovering a link says how to open it.
 *
 * Only `http(s):` / `mailto:` links off the app's origin open. Node refs are
 * chips, not links, and relative links stay put. Links in read-only islands
 * (an included doc's preview) already open on a plain click, through
 * utils/externalLinks in the desktop app, so this skips them.
 */
export const LinkOpen = Extension.create<LinkOpenOptions>({
  name: 'linkOpen',

  addOptions() {
    return { openUrl: openExternalUrl };
  },

  addProseMirrorPlugins() {
    const { openUrl } = this.options;
    return [
      new Plugin<DecorationSet>({
        key: linkOpenKey,
        state: {
          init: (_config, state) => linkHints(state.doc),
          apply: (tr, hints) => (tr.docChanged ? linkHints(tr.doc) : hints),
        },
        props: {
          decorations: (state) => linkOpenKey.getState(state),
          // ProseMirror turns a ⌘-click (Ctrl-click off macOS) into a node
          // selection of the clicked paragraph. Claim the click so opening a
          // link leaves the selection alone.
          handleClick: (view, _pos, event) => modClickUrl(view, event) !== null,
          handleDOMEvents: {
            click: (view, event) => {
              if (event.defaultPrevented) return false;
              const url = modClickUrl(view, event);
              if (!url) return false;
              event.preventDefault();
              launchExternalUrl(url, openUrl);
              return true;
            },
          },
        },
      }),
    ];
  },
});
