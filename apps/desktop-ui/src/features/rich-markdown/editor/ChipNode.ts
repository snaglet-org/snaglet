// TipTap node for an inline workspace-node chip. It renders the same DOM as
// MarkdownRenderer, so the global `.md-chip` styles apply. As an inline atom
// it moves, deletes and selects as one unit.

import {
  Node,
  mergeAttributes,
  nodeInputRule,
  nodePasteRule,
  type ExtendedRegExpMatchArray,
  type InputRule,
} from '@tiptap/core';
import type { NodeType } from '@tiptap/pm/model';
import { ReactNodeViewRenderer } from '@tiptap/react';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  type Transaction,
  type EditorState,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import {
  hasChipDragData,
  isChipKind,
  unescapeChipTitle,
  writeChipDragPayload,
} from '@desktop/utils/nodeChip';
import { NODE_HREF_SOURCE, parseNodeRef } from '@desktop/features/rich-markdown/renderer/nodeRef';
import { INCLUDABLE_KINDS } from '@desktop/features/rich-markdown/renderer/nodeRef';
import { TRANSCLUDE_TIP } from '@desktop/features/rich-markdown/renderer/transclusions';
import { ChipNodeView } from './ChipNodeView';
import { unique } from '@snaglet/shared/utils';

export interface ChipNodeOptions {
  /** Show the `.md-chip-toggle` on includable chips to flip between
   *  `[Title](doc)` and `![](doc)`. ChipNodeView handles the click.
   *  Default false. */
  showIncludeToggle: boolean;
  /** Turn typed or pasted bare node ids (`doc-abc-123`,
   *  `tool:workspace_search`) into chips, for `passIdOnly` surfaces.
   *  Default false. */
  parseBareIds: boolean;
}

/** Plugin key for the external-chip drop-indicator caret. */
const chipDropIndicatorKey = new PluginKey<DecorationSet>('chip-drop-indicator');
const CHIP_HREF_SOURCE = '[^)\\s]+';

/** A chip's title from its HTML: the renderer's chips carry the link label as
 *  written in `data-chip-title`; otherwise the text shown. */
function chipTitleFromHTML(el: HTMLElement): string {
  return (
    el.getAttribute('data-chip-title') ??
    el.querySelector('.md-chip-title')?.textContent ??
    ''
  ).trim();
}

/**
 * `nodeInputRule` that only fires when `getAttributes` accepts the match.
 * TipTap's version treats a null result as "no attributes" and still inserts
 * an empty node, so every typed `[text](https://…)` became a blank chip.
 */
function chipInputRule(config: {
  find: RegExp;
  type: NodeType;
  getAttributes: (match: ExtendedRegExpMatchArray) => Record<string, unknown> | null;
}): InputRule {
  const rule = nodeInputRule(config);
  const insert = rule.handler;
  // A null handler result tells TipTap the rule did not apply, so the typed
  // character goes in as plain text.
  rule.handler = (props) => (config.getAttributes(props.match) ? insert(props) : null);
  return rule;
}

/**
 * The node view element of the chip a drag started on, if any. A drag that
 * begins on an already selected chip starts from its label's text node.
 */
function closestChipWrapper(target: EventTarget | null): HTMLElement | null {
  // `Node` in this module is TipTap's extension class, so a text node is
  // recognized by what it is not rather than by `instanceof`.
  const element =
    target instanceof Element
      ? target
      : ((target as { parentElement?: Element | null } | null)?.parentElement ?? null);
  return element?.closest<HTMLElement>('[data-node-view-wrapper][data-node-url]') ?? null;
}

/** The document position of the chip node rendered by `wrapper`. */
function draggedChipPos(view: EditorView, wrapper: HTMLElement): number | null {
  if (!view.dom.contains(wrapper)) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(wrapper, 0);
  } catch {
    return null;
  }
  for (const candidate of [pos, pos - 1]) {
    if (candidate >= 0 && view.state.doc.nodeAt(candidate)?.type.name === 'chip') return candidate;
  }
  return null;
}
const CHIP_TITLE_SOURCE = '(?:\\\\.|[^\\]\\\\])*';

export const ChipNode = Node.create<ChipNodeOptions>({
  name: 'chip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  // Chips can be dragged to any chip-aware surface. The `dragstart` handler
  // below writes the `NODE_CHIP_MIME` payload; an in-document drop moves it.
  draggable: true,

  addOptions() {
    return { showIncludeToggle: false, parseBareIds: false };
  },

  addNodeView() {
    // React NodeView so include chips can render `TransclusionBlock`.
    // `renderHTML` below is used only for copy/paste and tests.
    return ReactNodeViewRenderer(ChipNodeView);
  },

  addProseMirrorPlugins() {
    // Include isolation: an include chip (`![](doc-x)`) renders as a block,
    // so any paragraph holding one alongside other content is split around
    // it (after typing, paste or drop). ChipNodeView does the same split for
    // an explicit toggle click.
    return [
      new Plugin({
        appendTransaction: (transactions, _old: EditorState, newState: EditorState) => {
          if (!transactions.some((t: Transaction) => t.docChanged)) return null;

          // Collect split positions first, then apply in reverse so earlier
          // splits don't shift later positions.
          const splits: number[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'paragraph') return undefined;
            const includes: { absPos: number }[] = [];
            let hasOther = false;
            node.forEach((child, offset) => {
              const absPos = pos + 1 + offset;
              if (child.type.name === 'chip' && child.attrs.include === true) {
                includes.push({ absPos });
              } else if (child.type.name === 'text' || child.type.name === 'chip') {
                hasOther = true;
              }
            });
            if (includes.length > 0 && hasOther) {
              for (const inc of includes) {
                splits.push(inc.absPos); // split before the include
                splits.push(inc.absPos + 1); // split after the include
              }
            }
            return false; // don't descend into paragraphs
          });
          if (splits.length === 0) return null;

          const tr = newState.tr;
          // Apply largest positions first so earlier mappings stay valid.
          const uniq = unique(splits).sort((a, b) => b - a);
          for (const pos of uniq) {
            try {
              const $pos = tr.doc.resolve(pos);
              if (
                $pos.parent.type.name === 'paragraph' &&
                $pos.parentOffset > 0 &&
                $pos.parentOffset < $pos.parent.content.size
              ) {
                tr.split(pos);
              }
            } catch {
              /* invalid split position — skip */
            }
          }
          return tr.steps.length > 0 ? tr : null;
        },
      }),

      // Drop caret for chips dragged in from outside the editor.
      // ProseMirror's dropcursor only draws when `view.dragging` is set,
      // which external drags never set (and WKWebView is worse), so this
      // draws its own caret from the `dragover` coordinates.
      new Plugin({
        key: chipDropIndicatorKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(chipDropIndicatorKey) as { pos: number | null } | undefined;
            if (meta === undefined) {
              // No indicator change this tx — just map existing decos.
              return old.map(tr.mapping, tr.doc);
            }
            if (meta.pos === null) return DecorationSet.empty;
            const widget = Decoration.widget(
              meta.pos,
              () => {
                const el = document.createElement('span');
                el.className = 'snaglet-chip-drop-indicator';
                return el;
              },
              { side: -1, key: 'chip-drop-indicator' }
            );
            return DecorationSet.create(tr.doc, [widget]);
          },
        },
        props: {
          decorations(state) {
            return chipDropIndicatorKey.getState(state);
          },
          handleDOMEvents: {
            // Writes the chip payload that chip-aware drop targets read. The
            // node view can't: NodeViewWrapper owns `onDragStart`, and
            // ProseMirror's dragstart clears earlier writes. This replaces
            // ProseMirror's handler and sets `view.dragging` the same way,
            // so an in-document drop still moves the chip.
            dragstart: (view, event) => {
              const wrapper = closestChipWrapper(event.target);
              const pos = wrapper ? draggedChipPos(view, wrapper) : null;
              if (!wrapper || pos === null || !event.dataTransfer) return false;
              if (wrapper.getAttribute('aria-disabled') === 'true') {
                event.preventDefault();
                return true;
              }
              const node = view.state.doc.nodeAt(pos);
              const kind = String(node?.attrs.kind ?? '');
              if (!node || !isChipKind(kind)) return false;
              const href = String(node.attrs.href ?? '');
              const id = parseNodeRef(href)?.id ?? href;
              const shown = wrapper.querySelector('.md-chip-title')?.textContent?.trim();
              const title = shown || String(node.attrs.title ?? '') || null;
              writeChipDragPayload(event.dataTransfer, {
                chip: { id, kind, title },
                dragLabel: `${kind}: ${title ?? id}`,
              });
              const selection = NodeSelection.create(view.state.doc, pos);
              view.dispatch(view.state.tr.setSelection(selection));
              view.dragging = {
                slice: selection.content(),
                move: !(event.altKey || event.ctrlKey),
              };
              return true;
            },
            dragover: (view, event) => {
              if (!event.dataTransfer || !hasChipDragData(event.dataTransfer)) {
                return false;
              }
              const coords = { left: event.clientX, top: event.clientY };
              const found = view.posAtCoords(coords);
              const pos = found ? found.pos : null;
              const current = chipDropIndicatorKey.getState(view.state);
              const currentPos =
                current && current !== DecorationSet.empty
                  ? (current.find()[0]?.from ?? null)
                  : null;
              if (pos !== currentPos) {
                view.dispatch(view.state.tr.setMeta(chipDropIndicatorKey, { pos }));
              }
              // Let the editor's own dragover handler also run (it sets
              // dropEffect / data-chip-drag-over). We don't consume the event.
              return false;
            },
            dragleave: (view, event) => {
              const related = event.relatedTarget as globalThis.Node | null;
              // Only clear when leaving the editor entirely.
              if (related && view.dom.contains(related)) return false;
              if (chipDropIndicatorKey.getState(view.state) !== DecorationSet.empty) {
                view.dispatch(view.state.tr.setMeta(chipDropIndicatorKey, { pos: null }));
              }
              return false;
            },
            drop: (view) => {
              if (chipDropIndicatorKey.getState(view.state) !== DecorationSet.empty) {
                view.dispatch(view.state.tr.setMeta(chipDropIndicatorKey, { pos: null }));
              }
              // Don't consume — the editor's own drop handler inserts the chip.
              return false;
            },
            dragend: (view) => {
              if (chipDropIndicatorKey.getState(view.state) !== DecorationSet.empty) {
                view.dispatch(view.state.tr.setMeta(chipDropIndicatorKey, { pos: null }));
              }
              return false;
            },
          },
        },
      }),
    ];
  },

  addAttributes() {
    // Per-attribute renderHTML is empty: the node-level `renderHTML` writes
    // the data-* attributes, and TipTap would otherwise also emit bare
    // `href`, `kind`, `title` and `include` attributes.
    return {
      href: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-node-url') ?? '',
        renderHTML: () => ({}),
      },
      kind: {
        default: 'doc',
        parseHTML: (el) => el.getAttribute('data-node-kind') ?? 'doc',
        renderHTML: () => ({}),
      },
      title: {
        default: '',
        parseHTML: (el) => chipTitleFromHTML(el),
        renderHTML: () => ({}),
      },
      include: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-chip-include') === 'true',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        // The editor's own chips are spans; the renderer's (docs, chat,
        // previews) are `<a>` links. Both carry the href in data-node-url, so
        // a chip copied from either pastes back as a chip. Ahead of the
        // link mark's `a[href]` rule, which would keep only the text,
        // badges and buttons included.
        tag: '.md-chip[data-node-url]',
        priority: 60,
        getAttrs: (el) => {
          const element = el as HTMLElement;
          return {
            href: element.getAttribute('data-node-url') ?? '',
            kind: element.getAttribute('data-node-kind') ?? 'doc',
            title: chipTitleFromHTML(element),
            include: element.getAttribute('data-chip-include') === 'true',
          };
        },
      },
    ];
  },

  addInputRules() {
    // Fires on the closing `)` of a link or include. `parseNodeRef` rejects
    // hrefs that aren't node refs, so http links are left to the link rule.
    // `find` has no
    // capture groups because `nodeInputRule` replaces only `match[1]` when one
    // exists; the captures live in the sub-regexes instead.
    const linkInner = new RegExp(`^\\[(${CHIP_TITLE_SOURCE})\\]\\((${CHIP_HREF_SOURCE})\\)$`);
    const includeInner = new RegExp(`^!\\[\\]\\((${CHIP_HREF_SOURCE})\\)$`);
    const rules = [
      chipInputRule({
        find: new RegExp(`(?<!!)\\[${CHIP_TITLE_SOURCE}\\]\\(${CHIP_HREF_SOURCE}\\)$`),
        type: this.type,
        getAttributes: (match) => {
          const inner = linkInner.exec(match[0]);
          if (!inner) return null;
          const [, title, href] = inner;
          const ref = parseNodeRef(href);
          if (!ref) return null;
          return { href, title: unescapeChipTitle(title), kind: ref.kind, include: false };
        },
      }),
      chipInputRule({
        find: new RegExp(`!\\[\\]\\(${CHIP_HREF_SOURCE}\\)$`),
        type: this.type,
        getAttributes: (match) => {
          const inner = includeInner.exec(match[0]);
          if (!inner) return null;
          const [, href] = inner;
          const ref = parseNodeRef(href);
          if (!ref) return null;
          return { href, title: ref.kind, kind: ref.kind, include: true };
        },
      }),
    ];

    if (this.options.parseBareIds) {
      // A typed bare node id becomes a chip when the following space lands.
      // Only capture group 1 (the id) is replaced, so the surrounding
      // whitespace stays. The leading boundary skips ids inside longer
      // tokens.
      rules.push(
        chipInputRule({
          find: new RegExp(`(?:^|\\s)(${NODE_HREF_SOURCE})\\s$`),
          type: this.type,
          getAttributes: (match) => {
            const href = match[1];
            const ref = parseNodeRef(href);
            if (!ref) return null;
            return { href, title: ref.kind, kind: ref.kind, include: false };
          },
        })
      );
    }

    return rules;
  },

  addPasteRules() {
    // Pasted node links and includes become chips; http links stay text.
    const rules = [
      nodePasteRule({
        find: new RegExp(`(?<!!)\\[(${CHIP_TITLE_SOURCE})\\]\\((${CHIP_HREF_SOURCE})\\)`, 'g'),
        type: this.type,
        getAttributes: (match) => {
          const [, title, href] = match;
          const ref = parseNodeRef(href);
          if (!ref) return null;
          return { href, title: unescapeChipTitle(title), kind: ref.kind, include: false };
        },
      }),
      nodePasteRule({
        find: new RegExp(`!\\[\\]\\((${CHIP_HREF_SOURCE})\\)`, 'g'),
        type: this.type,
        getAttributes: (match) => {
          const [, href] = match;
          const ref = parseNodeRef(href);
          if (!ref) return null;
          return { href, title: ref.kind, kind: ref.kind, include: true };
        },
      }),
    ];
    if (this.options.parseBareIds) {
      // Pasted bare ids become chips too, when whitespace-bounded. The link
      // rules above run first, so the id inside `[Title](doc-x)` doesn't
      // also match.
      rules.push(
        nodePasteRule({
          find: new RegExp(`(?:^|(?<=\\s))(${NODE_HREF_SOURCE})(?=\\s|$)`, 'g'),
          type: this.type,
          getAttributes: (match) => {
            const href = match[1];
            const ref = parseNodeRef(href);
            if (!ref) return null;
            return { href, title: ref.kind, kind: ref.kind, include: false };
          },
        })
      );
    }
    return rules;
  },

  renderHTML({ HTMLAttributes, node }) {
    const include = node.attrs.include === true;
    const kind = String(node.attrs.kind || 'doc');
    const title = String(node.attrs.title || kind);
    const href = String(node.attrs.href || '');
    const classes = include ? `md-chip md-chip-${kind} md-chip-include` : `md-chip md-chip-${kind}`;
    const attrs = mergeAttributes(HTMLAttributes, {
      class: classes,
      'data-node-kind': kind,
      'data-node-url': href,
      'data-chip-include': include ? 'true' : 'false',
      contenteditable: 'false',
    });
    // The include toggle renders only when the host opts in and the kind is
    // includable.
    const showToggle = this.options.showIncludeToggle && INCLUDABLE_KINDS.has(kind);
    const children: unknown[] = [];
    if (include) {
      children.push(['span', { class: 'md-chip-include-mark', 'aria-hidden': 'true' }, '↳']);
    }
    children.push(['span', { class: 'md-chip-title' }, title]);
    if (showToggle) {
      children.push([
        'span',
        {
          class: 'md-chip-toggle',
          role: 'button',
          'aria-label': include ? 'Turn this transclusion back into a link' : TRANSCLUDE_TIP,
          'data-toggle-direction': include ? 'link' : 'include',
        },
        include ? 'Show as link' : 'Transclude',
      ]);
    }
    return ['span', attrs, ...(children as never[])];
  },
});
