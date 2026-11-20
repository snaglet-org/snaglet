import { useCallback, useEffect, useRef, useState } from 'react';
import { memoriesApi, type MemoryRecord } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';

/** Keep a proposal (it becomes a remembered memory) or remove it (a hard delete). */
export type ProposedAction = 'keep' | 'remove';

/**
 * Put a memory back into a list ordered newest first (by `updatedAt`, the
 * order the server lists both memories and proposals in), unless it is
 * already there. A keep or delete that failed puts its card back where it was.
 */
export function insertNewestFirst(list: MemoryRecord[], memory: MemoryRecord): MemoryRecord[] {
  if (list.some((m) => m.id === memory.id)) return list;
  const at = list.findIndex((m) => m.updatedAt < memory.updatedAt);
  return at === -1 ? [...list, memory] : [...list.slice(0, at), memory, ...list.slice(at)];
}

/** A 404 from a delete: the memory is already gone, which is what was asked for. */
export function isAlreadyGone(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

/**
 * The thread's proposed memories: facts about you that an agent proposed,
 * held inert until you keep them. They are yours, not one agent's, so the list
 * is the thread's and every agent's Memories list shows the same one, first.
 *
 * Keep and remove are optimistic: the card leaves at once. A failed call puts
 * it back, sets `proposedError`, and reads the list again. A remove that finds
 * the proposal already gone (404) succeeded.
 */
export function useProposedMemories(threadId: string) {
  const [proposed, setProposed] = useState<MemoryRecord[]>([]);
  const [proposedError, setProposedError] = useState<string | null>(null);
  // Only the newest read may write: an older, slower answer (or one for the
  // previous thread) must not bring back a card that was just kept.
  const request = useRef(0);
  // Cards kept or removed here, in flight or done. A read that the server
  // answered before the keep or remove committed still lists them, so every
  // read leaves them out (a failed call takes its card out of this set).
  const gone = useRef(new Set<string>());
  // A failure that lands after a thread switch must not touch the new list.
  const threadRef = useRef(threadId);
  threadRef.current = threadId;

  // `keepError`: the read after a failed keep or remove must not wipe that error.
  const loadProposed = useCallback(
    (keepError = false) => {
      const n = ++request.current;
      memoriesApi
        .listProposed(threadId)
        .then((rows) => {
          if (n !== request.current) return;
          setProposed(rows.filter((m) => !gone.current.has(m.id)));
          if (!keepError) setProposedError(null);
        })
        .catch((err: unknown) => {
          if (n !== request.current) return;
          setProposedError(getErrorMessage(err, 'Failed to load proposals'));
        });
    },
    [threadId]
  );

  useEffect(() => {
    setProposed([]);
    gone.current.clear();
    loadProposed();
  }, [loadProposed]);

  /** Resolves true once the server took the keep or remove. */
  const resolveProposed = useCallback(
    async (memory: MemoryRecord, action: ProposedAction): Promise<boolean> => {
      const forThread = threadId;
      // A read already on its way predates this click: drop its answer.
      request.current += 1;
      gone.current.add(memory.id);
      setProposed((prev) => prev.filter((m) => m.id !== memory.id));
      setProposedError(null);
      try {
        if (action === 'keep') await memoriesApi.approve(memory.id);
        else await memoriesApi.delete(memory.id);
        return true;
      } catch (err) {
        if (action === 'remove' && isAlreadyGone(err)) return true;
        gone.current.delete(memory.id);
        if (threadRef.current !== forThread) return false;
        setProposed((prev) => insertNewestFirst(prev, memory));
        setProposedError(getErrorMessage(err, `Could not ${action} that memory`));
        // The server knows best (a 409 means it was already kept elsewhere).
        loadProposed(true);
        return false;
      }
    },
    [threadId, loadProposed]
  );

  return { proposed, proposedError, loadProposed, resolveProposed };
}
