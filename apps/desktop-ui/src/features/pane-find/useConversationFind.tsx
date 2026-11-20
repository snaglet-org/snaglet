import { useEffect, useMemo, useRef, useState } from 'react';
import { threadsApi, type ThreadMessage } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { useWs } from '@desktop/ws/useWs';
import { FindBar } from './FindBar';
import { scanConversation, type ConversationMatch } from './conversationSearch';
import { usePaneFindSession } from './PaneFindContext';
import { compareInstants } from '@desktop/utils/chronology';
import styles from './FindBar.module.scss';

/**
 * Frames that change this thread's persisted history: a new message, an edit
 * to one (its text is what find matches), a clear, or a trim.
 */
const HISTORY_CHANGED_FRAMES = new Set([
  'socket:chat:message_created',
  'socket:chat:message_updated',
  'socket:thread:cleared',
  'socket:thread:trimmed',
]);

export interface ConversationFindTarget {
  messageId: string;
  query: string;
  caseSensitive: boolean;
  occurrence: number;
  request: string;
}

export function useConversationFind(threadId: string, messages: ThreadMessage[]) {
  const session = usePaneFindSession(true, threadId);
  const { addMessageListener } = useWs();
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([threadId, session.open, session.query, session.caseSensitive, retry]);
  const [search, setSearch] = useState<{
    key: string;
    matches: ConversationMatch[];
    scanned: number;
    done: boolean;
    error: string | null;
  }>({ key: '', matches: [], scanned: 0, done: false, error: null });
  const [windowState, setWindowState] = useState<{
    key: string;
    messages: ThreadMessage[];
    error: string | null;
  }>({ key: '', messages: [], error: null });
  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  // Changes to persisted history invalidate results, including deletions and
  // edits that cannot be inferred by comparing the currently loaded
  // 50-message window.
  useEffect(() => {
    if (!session.open) return;
    return addMessageListener((frame) => {
      const payload = frame.payload as { threadId?: string } | undefined;
      if (payload?.threadId !== threadId) return;
      if (HISTORY_CHANGED_FRAMES.has(frame.type)) setRetry((n) => n + 1);
    });
  }, [addMessageListener, session.open, threadId]);
  useEffect(() => {
    if (!session.open || !session.query) return;
    const controller = new AbortController();
    let resultCount = 0;
    setSearch({ key, matches: [], scanned: 0, done: false, error: null });
    session.setIndex(0);
    const timer = window.setTimeout(() => {
      void scanConversation(
        session.query,
        session.caseSensitive,
        controller.signal,
        (before, signal) => threadsApi.getMessages(threadId, { before, limit: 200, signal }),
        (older, scanned, done) => {
          if (resultCount && older.length) session.setIndex((index) => index + older.length);
          resultCount += older.length;
          setSearch((previous) => ({
            key,
            matches: [...older, ...previous.matches],
            scanned,
            done,
            error: null,
          }));
        }
      ).catch((error: unknown) => {
        if (!controller.signal.aborted)
          setSearch((previous) => ({ ...previous, error: getErrorMessage(error) }));
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, threadId, session.open, session.query, session.caseSensitive, session.setIndex]);
  const matches = search.key === key && session.open && session.query ? search.matches : [];
  const current = matches[Math.min(session.index, matches.length - 1)];
  const targetKey = current ? JSON.stringify([key, current.messageId]) : '';
  useEffect(() => {
    if (!current) return;
    const controller = new AbortController();
    // A loaded hit needs no REST request, even if the render cap hid it.
    if (latestMessages.current.some((message) => message.id === current.messageId)) {
      setWindowState({ key: targetKey, messages: [], error: null });
      return;
    }
    void threadsApi
      .getMessages(threadId, { around: current.messageId, limit: 50, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setWindowState({
          key: targetKey,
          messages: page.messages,
          error: page.messages.some((message) => message.id === current.messageId)
            ? null
            : 'This message is no longer available. Retry the search.',
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setWindowState({ key: targetKey, messages: [], error: getErrorMessage(error) });
      });
    return () => controller.abort();
  }, [targetKey, threadId, current?.messageId]);
  const displayedMessages = useMemo(() => {
    if (!session.open || windowState.key !== targetKey || !windowState.messages.length)
      return messages;
    const byId = new Map(windowState.messages.map((message) => [message.id, message]));
    for (const message of messages) byId.set(message.id, message);
    return [...byId.values()].sort(
      (a, b) => compareInstants(a.createdAt, b.createdAt) || a.id.localeCompare(b.id)
    );
  }, [messages, windowState, targetKey, session.open]);
  const target: ConversationFindTarget | null = current
    ? {
        messageId: current.messageId,
        query: session.query,
        caseSensitive: session.caseSensitive,
        occurrence: matches
          .slice(0, session.index)
          .filter((match) => match.messageId === current.messageId).length,
        request: `${key}:${current.messageId}:${current.from}`,
      }
    : null;
  const error = search.key === key ? search.error : null;
  const windowError = windowState.key === targetKey ? windowState.error : null;
  return {
    open: session.open,
    displayedMessages,
    target,
    bar: (
      <FindBar
        session={session}
        count={matches.length}
        label="Find in conversation"
        status={
          <>
            {error
              ? 'Search incomplete'
              : session.query
                ? search.key === key && search.done
                  ? `All ${search.scanned} saved messages searched`
                  : `Searching older messages… ${search.key === key ? search.scanned : 0} searched`
                : 'Search message text and markdown throughout this conversation.'}
            {(error || windowError) && (
              <>
                {' '}
                · {error || windowError}{' '}
                <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
              </>
            )}
          </>
        }
      >
        {current && (
          <div className={styles.excerpt} aria-label="Matching message excerpt">
            {current.from > 60 ? '…' : ''}
            {current.content.slice(Math.max(0, current.from - 60), current.from)}
            <mark>{current.content.slice(current.from, current.to)}</mark>
            {current.content.slice(current.to, current.to + 100)}
            {current.to + 100 < current.content.length ? '…' : ''}
          </div>
        )}
      </FindBar>
    ),
  };
}
