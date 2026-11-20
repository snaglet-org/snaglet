/**
 * Chat-specific Markdown boundary.
 *
 * Workspace documents keep CommonMark hard-break semantics: a hard break
 * serializes as a backslash followed by a newline. Chat messages are different:
 * the wire/persisted transcript stores the user's visible line break as an
 * actual newline, not as an implementation marker. These helpers are deliberately
 * scoped to ChatView so document/editor Markdown round-trips do not change.
 */

/**
 * Convert TipTap/prosemirror-markdown hardBreak serialization (`\\\n`) into the
 * chat wire contract (plain `\n`). Runs of backslashes are parity-aware: the
 * final odd backslash is the synthetic hard-break marker, while preceding pairs
 * are intentional literal backslashes escaped by the Markdown serializer.
 */
export function normalizeChatComposerMarkdown(markdown: string): string {
  return markdown.replace(/(\\+)(\r?\n)/g, (_match, slashes: string, newline: string) => {
    if (slashes.length % 2 === 0) return `${slashes}${newline}`;
    return `${'\\'.repeat((slashes.length - 1) / 2)}${newline}`;
  });
}

/**
 * Render chat wire newlines as visible hard line breaks without mutating the
 * stored/sent message and without teaching every workspace Markdown surface to
 * treat softbreaks as hardbreaks. Blank lines remain paragraph breaks. Fenced
 * code blocks keep their bytes exactly so code/table-ish transcripts do not get
 * invisible trailing spaces injected into code lines.
 */
export function markdownForChatMessageRender(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let inFence = false;
  let fenceMarker: '`' | '~' | null = null;
  let fenceLength = 0;

  return lines
    .map((line, index) => {
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
      const wasFenceLine = Boolean(fence);

      if (fence) {
        const marker = fence[1][0] as '`' | '~';
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
          fenceLength = fence[1].length;
        } else if (marker === fenceMarker && fence[1].length >= fenceLength) {
          inFence = false;
          fenceMarker = null;
          fenceLength = 0;
        }
      }

      if (index === lines.length - 1) return line;
      const next = lines[index + 1];
      const shouldHardBreak = !inFence && !wasFenceLine && line.length > 0 && next.length > 0;
      return `${line}${shouldHardBreak ? '  ' : ''}\n`;
    })
    .join('');
}

/**
 * Map an offset in `markdownForChatMessageRender(content)` back to `content`.
 *
 * The render form only drops the CR of a CRLF (a lone CR becomes LF) and
 * inserts hard-break spaces before line ends, so walking both strings in
 * step and skipping what the render added lands on the same character in
 * the stored text. Task-list checkboxes need this: the renderer reports the
 * offset of a list item in the text it rendered, and the toggle is applied
 * to the stored message.
 */
export function chatRenderOffsetToSource(content: string, renderedOffset: number): number {
  const rendered = markdownForChatMessageRender(content);
  let i = 0;
  let j = 0;
  while (j < renderedOffset && i < content.length) {
    const source = content[i];
    if (source === '\r' && content[i + 1] === '\n') {
      i += 1;
      continue;
    }
    if (source === rendered[j] || (source === '\r' && rendered[j] === '\n')) {
      i += 1;
      j += 1;
      continue;
    }
    j += 1;
  }
  return i;
}
