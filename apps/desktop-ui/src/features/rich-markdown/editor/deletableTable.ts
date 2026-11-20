import { Table, TableView } from '@tiptap/extension-table';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import buttonStyles from '@desktop/components/controls/Button/Button.module.scss';

/** Marks the frame of the table that holds the caret (its × and Expand show). */
const ACTIVE_ATTR = 'data-table-active';
const BUTTON_ATTR = 'data-table-delete';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Fired from a table's frame, bubbling, when its Expand button is pressed;
 * the editor's host opens the table large (see `useTableDialog`).
 */
export const TABLE_EXPAND_EVENT = 'snaglet-table-expand';

export interface TableExpandDetail {
  /** The table node as it is at the press. */
  table: PMNode;
}

/** Keep the caret and focus where they are until the click lands. */
const keepFocus = (event: Event) => event.preventDefault();

/**
 * The Expand button in its strip by the ×. It is drawn with the shared
 * Button's classes, so it matches the message table's Expand, and lives
 * outside the document like the ×.
 */
function expandBar(onExpand: () => void): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'tableBar';
  bar.setAttribute('contenteditable', 'false');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = [buttonStyles.button, buttonStyles.variantNeutral, buttonStyles.sizeSm].join(
    ' '
  );
  button.setAttribute('aria-label', 'Expand table');
  const label = document.createElement('span');
  label.className = buttonStyles.content;
  label.textContent = 'Expand';
  button.appendChild(label);
  button.addEventListener('mousedown', keepFocus);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onExpand();
  });
  bar.appendChild(button);
  return bar;
}

function deleteIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3 3l6 6M9 3l-6 6');
  svg.appendChild(path);
  return svg;
}

/**
 * The rich editor's table: prosemirror-tables' `TableView` (a scrolling
 * `div.tableWrapper` around the table) inside a `div.tableFrame` that also
 * holds a small × and an Expand button inside the table's top-right corner,
 * over the right end of its header row. Both sit outside the scrolling
 * wrapper, so they stay at the corner while a wide table scrolls, and outside
 * the document content, so they never serialize, select or copy.
 *
 * The × deletes this table, found by its own DOM rather than the caret, as
 * one undo step, then puts the caret in the block after (or before, if the
 * table was last). Only an editable editor shows it (`TableDeleteControl`
 * keeps it in step). Expand, in read-only editors too, fires
 * `TABLE_EXPAND_EVENT` with this table's node. ProseMirror ignores events on
 * both, so Enter and Space press the buttons instead of editing the doc.
 */
class DeletableTableView extends TableView {
  readonly button: HTMLButtonElement;
  private readonly bar: HTMLDivElement;
  private readonly view: EditorView;

  constructor(
    node: PMNode,
    cellMinWidth: number,
    view: EditorView,
    HTMLAttributes?: Record<string, unknown>
  ) {
    super(node, cellMinWidth, view, HTMLAttributes);
    this.view = view;
    const frame = document.createElement('div');
    frame.className = 'tableFrame';
    frame.appendChild(this.dom);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tableDelete';
    button.setAttribute(BUTTON_ATTR, '');
    button.setAttribute('aria-label', 'Delete table');
    button.title = 'Delete table';
    button.setAttribute('contenteditable', 'false');
    button.hidden = !view.editable;
    button.appendChild(deleteIcon());
    button.addEventListener('mousedown', keepFocus);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      this.deleteTable();
    });
    frame.appendChild(button);
    this.button = button;

    this.bar = expandBar(() => {
      const detail: TableExpandDetail = { table: this.node };
      frame.dispatchEvent(new CustomEvent(TABLE_EXPAND_EVENT, { bubbles: true, detail }));
    });
    frame.appendChild(this.bar);
    this.dom = frame;
  }

  stopEvent(event: Event): boolean {
    const { target } = event;
    return target instanceof Node && (this.button.contains(target) || this.bar.contains(target));
  }

  /** This table's position, found by matching its rendered DOM. */
  private position(): number | null {
    const { view } = this;
    let found: number | null = null;
    view.state.doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (node.type.name !== 'table') return true;
      if (view.nodeDOM(pos) === this.dom) found = pos;
      return false;
    });
    return found;
  }

  private deleteTable(): void {
    const { view } = this;
    if (!view.editable) return;
    const pos = this.position();
    const node = pos === null ? null : view.state.doc.nodeAt(pos);
    if (pos === null || !node) return;
    const tr = view.state.tr.delete(pos, pos + node.nodeSize);
    const at = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
    tr.setSelection(Selection.near(at, 1)).scrollIntoView();
    // Its own undo step, never merged with typing just before it.
    closeHistory(tr);
    view.dispatch(tr);
    view.focus();
  }
}

const tableDeleteKey = new PluginKey<DecorationSet>('tableDeleteControl');

/** The table that holds the selection, if any, flagged on its frame. */
function activeTableDecoration(doc: PMNode, selection: Selection): DecorationSet {
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'table') {
      const start = $from.before(depth);
      return DecorationSet.create(doc, [
        Decoration.node(start, start + node.nodeSize, { [ACTIVE_ATTR]: '' }),
      ]);
    }
  }
  return DecorationSet.empty;
}

/**
 * The rich editor's `Table`: GFM tables drawn by `DeletableTableView`, plus a
 * plugin that flags the table holding the caret and shows the × buttons only
 * while the editor is editable (read-only editors never show them).
 */
export const DeletableTable = Table.extend({
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: tableDeleteKey,
        props: {
          decorations: (state) => activeTableDecoration(state.doc, state.selection),
        },
        view: (view) => {
          const sync = () => {
            for (const button of view.dom.querySelectorAll<HTMLButtonElement>(`[${BUTTON_ATTR}]`)) {
              // A nested editor's buttons follow that editor.
              if (button.closest('.ProseMirror') === view.dom) button.hidden = !view.editable;
            }
          };
          sync();
          return { update: sync };
        },
      }),
    ];
  },
}).configure({
  // Markdown can't store column widths.
  resizable: false,
  View: DeletableTableView,
});
