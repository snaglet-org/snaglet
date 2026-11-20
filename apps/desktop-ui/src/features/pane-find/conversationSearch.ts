import type { ThreadMessage } from '@desktop/utils/api';
import { findText, type TextMatch } from './findText';

export interface ConversationMatch extends TextMatch {
  messageId: string;
  content: string;
}

export interface ConversationPage {
  messages: ThreadMessage[];
  hasMoreOlder: boolean;
}

/** Scans cursor pages without retaining or mounting non-matching message bodies. */
export async function scanConversation(
  query: string,
  caseSensitive: boolean,
  signal: AbortSignal,
  fetchPage: (before: string | undefined, signal: AbortSignal) => Promise<ConversationPage>,
  onPage: (matches: ConversationMatch[], scanned: number, done: boolean) => void
): Promise<void> {
  let before: string | undefined;
  let scanned = 0;
  const visited = new Set<string>();
  while (!signal.aborted) {
    const page = await fetchPage(before, signal);
    if (signal.aborted) return;
    const fresh = page.messages.filter((message) => !visited.has(message.id));
    for (const message of fresh) visited.add(message.id);
    scanned += fresh.length;
    const matches = fresh.flatMap((message) =>
      findText(message.content, query, caseSensitive).map((match) => ({
        ...match,
        messageId: message.id,
        content: message.content,
      }))
    );
    onPage(matches, scanned, !page.hasMoreOlder);
    if (!page.hasMoreOlder) return;
    const next = page.messages[0]?.id;
    if (!next || next === before || !fresh.length)
      throw new Error('History paging stopped making progress. Retry to finish searching.');
    before = next;
  }
}
