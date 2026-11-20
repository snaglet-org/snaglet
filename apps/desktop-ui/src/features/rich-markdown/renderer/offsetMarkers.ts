import type { Element, Root } from 'hast';
import { SKIP, visit } from 'unist-util-visit';

/**
 * Rehype plugin that stamps each GFM task-list checkbox with the source
 * offset of its list item (`data-source-offset`), so a toggle in the
 * rendered view can flip the matching `[ ]` / `[x]` in the markdown.
 */
export default function rehypeOffsetMarkers() {
  return (tree: Root) => {
    // A nested visit finds <input type="checkbox"> descendants at any
    // depth — loose lists wrap content in <p>, so the input is not always a
    // direct child of <li>.
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'li') return;
      const startOffset = node.position?.start?.offset;
      if (startOffset === undefined) return;

      visit(node, 'element', (desc: Element) => {
        // A table's checkboxes carry their own cells' offsets (remarkTableCellTasks).
        if (desc.tagName === 'table') return SKIP;
        if (
          desc.tagName === 'input' &&
          (desc.properties as Record<string, unknown>)?.type === 'checkbox'
        ) {
          if (!desc.properties) (desc as Element).properties = {};
          (desc.properties as Record<string, unknown>)['data-source-offset'] = String(startOffset);
        }
      });
    });
  };
}
