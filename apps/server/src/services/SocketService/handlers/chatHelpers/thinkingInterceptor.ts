/**
 * thinkingInterceptor.ts — Streaming/`<thinking>`-tag handling.
 * Extracted from chatHelpers.ts (behavior-preserving).
 *
 * Models sometimes emit <thinking>...</thinking> as plain text in their
 * response.  This interceptor splits the stream so thinking content goes
 * to `onThinking` while regular text goes to `onText`.  It also strips
 * the tags from a completed reply string via `stripThinkingTags`.
 */

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';

export interface ThinkingInterceptor {
  /** Feed a streaming chunk — routes content to onText / onThinking. */
  push(chunk: string): void;
  /** Flush any buffered partial tag as plain text. */
  flush(): void;
}

/**
 * Creates a streaming interceptor that detects voluntary `<thinking>` tags
 * in text chunks and routes them to separate callbacks.
 */
export function createThinkingInterceptor(
  onText: (text: string) => void,
  onThinking: (text: string) => void
): ThinkingInterceptor {
  let insideThinking = false;
  let buffer = '';

  function process(text: string) {
    let remaining = text;

    while (remaining.length > 0) {
      if (insideThinking) {
        const closeIdx = remaining.indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          // No closing tag yet — all thinking content
          onThinking(remaining);
          remaining = '';
        } else {
          // Emit thinking up to the close tag, then switch back
          if (closeIdx > 0) onThinking(remaining.slice(0, closeIdx));
          insideThinking = false;
          remaining = remaining.slice(closeIdx + CLOSE_TAG.length);
        }
      } else {
        const openIdx = remaining.indexOf(OPEN_TAG);
        if (openIdx === -1) {
          // Check if we might be at the start of a partial tag
          const partialMatch = partialTagMatch(remaining, OPEN_TAG);
          if (
            partialMatch > 0 &&
            remaining.length - (remaining.length - partialMatch) < OPEN_TAG.length
          ) {
            // Buffer the potential partial tag
            buffer += remaining.slice(remaining.length - partialMatch);
            const textBefore = remaining.slice(0, remaining.length - partialMatch);
            if (textBefore) onText(textBefore);
            remaining = '';
          } else {
            onText(remaining);
            remaining = '';
          }
        } else {
          // Emit text before the tag, then switch to thinking mode
          if (openIdx > 0) onText(remaining.slice(0, openIdx));
          insideThinking = true;
          remaining = remaining.slice(openIdx + OPEN_TAG.length);
        }
      }
    }
  }

  return {
    push(chunk: string) {
      if (buffer.length > 0) {
        const combined = buffer + chunk;
        buffer = '';
        process(combined);
      } else {
        process(chunk);
      }
    },
    flush() {
      if (buffer.length > 0) {
        onText(buffer);
        buffer = '';
      }
    },
  };
}

/** Check how many trailing chars of `text` match a prefix of `tag`. */
function partialTagMatch(text: string, tag: string): number {
  const maxCheck = Math.min(text.length, tag.length - 1);
  for (let len = maxCheck; len >= 1; len--) {
    if (text.slice(-len) === tag.slice(0, len)) return len;
  }
  return 0;
}

/**
 * Strip `<thinking>...</thinking>` blocks from a completed reply string.
 * Returns `{ reply, thinking }`.
 */
export function stripThinkingTags(text: string): { reply: string; thinking: string } {
  let thinking = '';
  const reply = text.replace(/<thinking>([\s\S]*?)<\/thinking>/g, (_match, content: string) => {
    thinking += content;
    return '';
  });
  return { reply: reply.trim(), thinking };
}
