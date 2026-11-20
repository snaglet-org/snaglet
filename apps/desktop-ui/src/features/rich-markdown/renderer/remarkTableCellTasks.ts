/**
 * A table cell line that starts with a task marker shows a checkbox, as the
 * rich editor shows a task item there: `[ ]` or `[x]` (`[X]`), or `☐` / `☑`,
 * which older saves wrote. A line starts at the cell's start or after a line
 * break (`remarkTableCellBreaks`), spaces before the marker included, and the
 * marker stands alone: a space, a break or the cell's end follows it. Only
 * plain text directly in the cell counts: an escaped `\[ \]`, inline code, a
 * link, a chip or text inside emphasis stays as it is. This matches what the
 * rich editor reads as a task (`markCellTasks` in `editor/richMarkdown.ts`).
 *
 * The checkbox is read-only, like a GFM task list's. A `[ ]` / `[x]` one
 * carries its source offset (`data-source-offset`), so a host that toggles
 * task checkboxes (`onCheckboxToggle`) can flip it in the markdown.
 */
import type { Plugin } from 'unified';
import type { PhrasingContent, Root } from 'mdast';
import { visit } from 'unist-util-visit';

const MARKER_RE = /^([ \t]*)(\[([ xX])\]|☐|☑)([ \t]+|$)/;

const remarkTableCellTasks: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value ?? '');
  visit(tree, 'tableCell', (cell) => {
    const children = cell.children;
    for (let index = 0; index < children.length; index++) {
      const node = children[index];
      const lineStart = index === 0 || children[index - 1].type === 'break';
      if (!lineStart || node.type !== 'text') continue;
      const match = MARKER_RE.exec(node.value);
      if (!match) continue;
      const [whole, lead, marker, box, space] = match;
      const next = children[index + 1];
      if (!space && whole.length === node.value.length && next && next.type !== 'break') continue;
      const textStart = node.position?.start.offset;
      const start = textStart === undefined ? undefined : textStart + lead.length;
      // The source shows whether the brackets were escaped.
      if (box !== undefined && (start === undefined || source[start] !== '[')) continue;
      const checked = box === undefined ? marker === '☑' : box !== ' ';
      const checkbox = {
        type: 'cellTask',
        data: {
          hName: 'input',
          hProperties: {
            type: 'checkbox',
            checked,
            disabled: true,
            ...(box !== undefined && { 'data-source-offset': String(start) }),
          },
        },
      } as unknown as PhrasingContent;
      const rest = node.value.slice(whole.length);
      children.splice(
        index,
        1,
        checkbox,
        ...(rest ? [{ type: 'text' as const, value: rest }] : [])
      );
    }
  });
};

export default remarkTableCellTasks;
