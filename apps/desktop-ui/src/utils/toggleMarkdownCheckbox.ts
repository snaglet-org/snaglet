/**
 * Toggle a GFM task-list checkbox in a markdown string using the
 * source offset of its parent list-item.
 *
 * The offset points to the start of the `<li>` line in the source
 * (stamped by our rehype plugin as `data-source-offset`). From that
 * position we scan forward for the first `[ ]` or `[x]` bracket and
 * flip it.
 *
 * This avoids the fragile "nth checkbox" ordinal approach that breaks
 * when plugins reorder nodes.
 */
export function toggleMarkdownCheckbox(markdown: string, sourceOffset: number): string {
  // From the list-item start offset, find the first checkbox bracket.
  // GFM spec: `- [ ] ...` / `* [x] ...` / `+ [ ] ...`
  // The bracket always appears on the same line as the list marker.
  const rest = markdown.slice(sourceOffset);
  const match = rest.match(/\[([ xX])\]/);
  if (!match || match.index === undefined) return markdown;

  const bracketStart = sourceOffset + match.index; // position of `[`
  const inner = match[1]; // ` ` or `x`/`X`
  const toggled = inner === ' ' ? 'x' : ' ';

  return markdown.slice(0, bracketStart + 1) + toggled + markdown.slice(bracketStart + 2);
}
