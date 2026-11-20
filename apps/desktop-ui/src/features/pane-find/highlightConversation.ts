import { findText } from './findText';

type HighlightRuntime = typeof globalThis & {
  Highlight?: new (...ranges: Range[]) => unknown;
  CSS?: { highlights?: Map<string, unknown> };
};

/** Every match of `query` in the visible text under `element`, as DOM ranges. */
export function findTextRanges(
  element: HTMLElement,
  query: string,
  caseSensitive: boolean
): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest('button, [role="button"], [aria-hidden="true"]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.textContent ?? '';
  }
  for (const match of findText(text, query, caseSensitive)) {
    const first = nodes.find((entry) => entry.start + entry.node.length > match.from);
    const last = nodes.find((entry) => entry.start + entry.node.length >= match.to);
    if (!first || !last) continue;
    const range = document.createRange();
    range.setStart(first.node, match.from - first.start);
    range.setEnd(last.node, match.to - last.start);
    ranges.push(range);
  }
  return ranges;
}

/**
 * Paint `ranges` with the pane-find CSS highlight and optionally scroll the
 * `occurrence`-th one into view; the returned function removes the highlight.
 */
export function paintFindRanges(ranges: Range[], occurrence: number, scroll = true): () => void {
  const runtime = globalThis as HighlightRuntime;
  const registry = runtime.CSS?.highlights;
  if (runtime.Highlight && registry)
    registry.set('snaglet-pane-find', new runtime.Highlight(...ranges));
  const selected = ranges[Math.min(occurrence, ranges.length - 1)];
  if (scroll) selected?.startContainer.parentElement?.scrollIntoView?.({ block: 'center' });
  return () => {
    registry?.delete('snaglet-pane-find');
  };
}

/** CSS Highlights leave React-owned markdown DOM and copied text untouched. */
export function highlightConversation(
  element: HTMLElement,
  query: string,
  caseSensitive: boolean,
  occurrence: number,
  scroll = true
): () => void {
  const content = element.querySelector<HTMLElement>('.snaglet-message-find-text') ?? element;
  const clearHighlight = paintFindRanges(
    findTextRanges(content, query, caseSensitive),
    occurrence,
    scroll
  );
  element.classList.add('snaglet-find-message');
  return () => {
    clearHighlight();
    element.classList.remove('snaglet-find-message');
  };
}
