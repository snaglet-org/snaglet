/**
 * useDraftPersistence — the chat composer's draft, one per thread, on top
 * of the shared `usePersistentDraft`. Chat drafts live under their own
 * `snaglet:chat-draft:` prefix, which stored drafts already rely on.
 */
import { useCallback } from 'react';
import { usePersistentDraft } from '@desktop/features/composer';

const STORAGE_PREFIX = 'snaglet:chat-draft:';

function chatDraftKey(threadId: string | undefined): string | undefined {
  return threadId ? STORAGE_PREFIX + threadId : undefined;
}

/**
 * Hook: the thread's draft text with localStorage persistence.
 *
 * Returns { draftText, setDraftText, clearDraft }. `clearDraft()` wipes the
 * stored draft after a successful send; without a thread there is no draft
 * to clear, so it leaves the text alone.
 */
export function useDraftPersistence(threadId: string | undefined) {
  const { draftText, setDraftText, clearDraft: clear } = usePersistentDraft(chatDraftKey(threadId));
  const clearDraft = useCallback(() => {
    if (threadId) clear();
  }, [threadId, clear]);
  return { draftText, setDraftText, clearDraft };
}
