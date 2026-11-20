/**
 * `<br>` is how a GFM table cell holds several lines. Raw HTML is not
 * rendered, so a `<br>` (or `<br/>`, `<br />`) inside a table cell becomes a
 * line break here, as it does in the rich editor. Anywhere else it stays
 * text, as written.
 */
import type { Plugin } from 'unified';
import type { Break, Root } from 'mdast';
import { visit } from 'unist-util-visit';

const CELL_BREAK_RE = /^<br\s*\/?>$/i;

const remarkTableCellBreaks: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'tableCell', (cell) => {
    visit(cell, 'html', (node, index, parent) => {
      if (!parent || index === undefined || !CELL_BREAK_RE.test(node.value.trim())) return;
      parent.children.splice(index, 1, { type: 'break' } satisfies Break);
    });
  });
};

export default remarkTableCellBreaks;
