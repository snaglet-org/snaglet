/**
 * The agent page's Memories tab: every memory this agent holds, from all of
 * its threads, newest first, each labeled with the thread it was recorded
 * in. A row opens the full text. Pages of 50 load on demand; the thread
 * titles come from one read of the agent's threads (a memory made by hand
 * has no thread). The rows scroll in a box of their own, so the page's
 * header and tabs stay in place. A row's trash button deletes the memory for
 * good (no undo), so it asks first with an inline "Delete?" Yes / No.
 */
import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { Button, Modal } from '@desktop/components';
import { TrashIcon } from '@desktop/components/Icons';
import { memoriesApi, threadsApi, type MemoryRecord } from '@desktop/utils/api';
import { formatDateTime, getErrorMessage } from '@snaglet/shared/utils';
import { memoryKeyWithBreaks } from '@desktop/utils/memoryKeyBreaks';
import styles from './AgentMemoriesTab.module.scss';

const PAGE_SIZE = 50;

interface AgentMemoriesTabProps {
  agentId: string;
  agentName: string;
}

export const AgentMemoriesTab: FC<AgentMemoriesTabProps> = ({ agentId, agentName }) => {
  const [memories, setMemories] = useState<MemoryRecord[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MemoryRecord | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The row asking "Delete?" and the row whose delete is in flight.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // A delete that finishes after the agent changed must not touch the new list.
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  // The control swaps for the confirm and back; focus follows it so a keyboard
  // user is never dropped on <body>.
  const rootRef = useRef<HTMLDivElement>(null);
  const lastConfirmedRow = useRef<string | null>(null);
  useEffect(() => {
    if (confirmingId !== null || lastConfirmedRow.current === null) return;
    const id = lastConfirmedRow.current;
    lastConfirmedRow.current = null;
    rootRef.current?.querySelector<HTMLElement>(`[data-delete-for="${id}"]`)?.focus();
  }, [confirmingId]);

  // First page, the count and the thread titles, again when the agent changes.
  useEffect(() => {
    let canceled = false;
    setMemories(null);
    setTotal(null);
    setError(null);
    setConfirmingId(null);
    setPreview(null);
    memoriesApi
      .list(agentId, { limit: PAGE_SIZE, offset: 0 })
      .then((page) => {
        if (!canceled) setMemories(page);
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load memories'));
      });
    // The count and titles are extras: the list stands without them.
    memoriesApi
      .getStats(agentId)
      .then((stats) => {
        if (!canceled) setTotal(stats.total);
      })
      .catch((err: unknown) =>
        console.warn(`[memories] couldn't count ${agentId}'s memories: ${getErrorMessage(err)}`)
      );
    threadsApi
      .list(agentId)
      .then((threads) => {
        if (canceled) return;
        const next: Record<string, string> = {};
        for (const thread of threads) next[thread.id] = thread.title?.trim() || 'Untitled thread';
        setTitles(next);
      })
      .catch((err: unknown) =>
        console.warn(`[memories] couldn't list ${agentId}'s threads: ${getErrorMessage(err)}`)
      );
    return () => {
      canceled = true;
    };
  }, [agentId, attempt]);

  const loadMore = useCallback(async () => {
    if (!memories || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await memoriesApi.list(agentId, { limit: PAGE_SIZE, offset: memories.length });
      setMemories((current) => {
        const have = new Set((current ?? []).map((m) => m.id));
        return [...(current ?? []), ...page.filter((m) => !have.has(m.id))];
      });
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load more memories'));
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, memories, loadingMore]);

  const deleteMemory = async (memory: MemoryRecord) => {
    if (deletingId) return;
    const forAgent = agentId;
    setDeletingId(memory.id);
    setError(null);
    try {
      await memoriesApi.delete(memory.id);
      if (agentIdRef.current !== forAgent) return;
      const remaining = (memories ?? []).filter((m) => m.id !== memory.id);
      setMemories(remaining);
      setTotal((n) => (n === null ? null : Math.max(0, n - 1)));
      setConfirmingId(null);
      setPreview((open) => (open?.id === memory.id ? null : open));
      // Every loaded row is gone but more remain on the server: read again
      // rather than claim the agent has no memories.
      if (remaining.length === 0 && (total === null || total > 1)) setAttempt((n) => n + 1);
    } catch (err) {
      if (agentIdRef.current === forAgent)
        setError(getErrorMessage(err, 'Failed to delete memory'));
    } finally {
      setDeletingId((current) => (current === memory.id ? null : current));
    }
  };

  const hasMore =
    memories !== null &&
    (total !== null
      ? memories.length < total
      : memories.length > 0 && memories.length % PAGE_SIZE === 0);
  const threadLabel = (memory: MemoryRecord): string =>
    memory.sourceThreadId ? (titles[memory.sourceThreadId] ?? 'Another thread') : 'Added by hand';

  return (
    <div className={styles.root} ref={rootRef}>
      {error && (
        <div className={styles.error} role="alert">
          {error}{' '}
          <Button size="xs" variant="link" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      )}
      {memories === null ? (
        !error && <p className={styles.hint}>Loading memories…</p>
      ) : memories.length === 0 ? (
        <p className={styles.hint}>
          {agentName} has no memories yet. They appear here when {agentName} saves one in any
          thread.
        </p>
      ) : (
        <>
          <p className={styles.count} aria-live="polite">
            {total ?? memories.length} {(total ?? memories.length) === 1 ? 'memory' : 'memories'}{' '}
            from all threads
          </p>
          <div className={styles.box} data-testid="memories-scroll">
            <ul className={styles.list}>
              {memories.map((memory) => (
                <li key={memory.id} className={styles.item}>
                  <button
                    type="button"
                    className={styles.row}
                    data-item-id={memory.id}
                    aria-label={memory.key ? `Open memory ${memory.key}` : 'Open memory'}
                    onClick={() => setPreview(memory)}
                  >
                    {memory.key && (
                      <span className={styles.key}>{memoryKeyWithBreaks(memory.key)}</span>
                    )}
                    <span className={styles.content}>{memory.content}</span>
                    <span className={styles.meta}>
                      <span className={styles.thread}>{threadLabel(memory)}</span>
                      <span aria-hidden> · </span>
                      <time dateTime={memory.updatedAt}>{formatDateTime(memory.updatedAt)}</time>
                    </span>
                  </button>
                  {/* A sibling of the row button, never inside it. */}
                  <div className={styles.actions} data-confirming={confirmingId === memory.id}>
                    {confirmingId === memory.id ? (
                      <div role="group" aria-label="Confirm delete" className={styles.confirm}>
                        <span className={styles.confirmText}>Delete?</span>
                        <Button
                          size="xs"
                          variant="danger"
                          loading={deletingId === memory.id}
                          loadingText=""
                          aria-label={
                            memory.key
                              ? `Confirm delete memory ${memory.key}`
                              : 'Confirm delete memory'
                          }
                          onClick={() => void deleteMemory(memory)}
                        >
                          Yes
                        </Button>
                        <Button
                          size="xs"
                          variant="neutral"
                          autoFocus
                          disabled={deletingId === memory.id}
                          aria-label={
                            memory.key
                              ? `Cancel delete memory ${memory.key}`
                              : 'Cancel delete memory'
                          }
                          onClick={() => setConfirmingId(null)}
                        >
                          No
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        title="Delete memory"
                        aria-label={memory.key ? `Delete memory ${memory.key}` : 'Delete memory'}
                        disabled={deletingId !== null}
                        data-delete-for={memory.id}
                        onClick={() => {
                          lastConfirmedRow.current = memory.id;
                          setConfirmingId(memory.id);
                        }}
                      >
                        <TrashIcon />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {hasMore && (
              <div className={styles.more}>
                <Button
                  size="sm"
                  variant="neutral"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {preview && (
        <Modal onClose={() => setPreview(null)}>
          <Modal.Header>
            <div className={styles.previewTitle}>{preview.key || 'Memory'}</div>
          </Modal.Header>
          <Modal.Body>
            <pre className={styles.previewContent}>{preview.content}</pre>
            <div className={styles.previewMeta}>
              {threadLabel(preview)} · Updated {new Date(preview.updatedAt).toLocaleString()}
            </div>
          </Modal.Body>
        </Modal>
      )}
    </div>
  );
};
