import { useEffect, useId, useRef, useState, type FC } from 'react';
import { memoriesApi, threadsApi } from '@desktop/utils/api';
import { Button, Modal } from '@desktop/components';
import { CheckIcon, TrashIcon } from '@desktop/components/Icons';
import type { MemoryRecord, ThreadSummaryRecord } from '@desktop/utils/api';
import { formatDateTime, formatModelUsed, getErrorMessage } from '@snaglet/shared/utils';
import { memoryKeyWithBreaks } from '@desktop/utils/memoryKeyBreaks';
import { insertNewestFirst, isAlreadyGone, type ProposedAction } from './useProposedMemories';
import styles from './ChatSettings.module.scss';

type AgentContextTab = 'memories' | 'summaries';

/** `focusAfterDelete` target meaning the list itself (no card is left to focus). */
const LIST_FOCUS = Symbol('list');

/**
 * Which runtime wrote a summary, shown at the end of it.
 *
 * Read from the summary row's structured `modelUsed` field at render time —
 * deliberately NOT from the summary prose. That prose is model-authored, gets
 * embedded for retrieval, and is quoted verbatim into exports, so a machine
 * stamp baked into it would pollute all three.
 *
 * Renders nothing at all for rows persisted before provenance was tracked.
 */
const SummaryProvenance: FC<{ modelUsed: string | null }> = ({ modelUsed }) => {
  const label = formatModelUsed(modelUsed);
  if (!label) return null;
  return <div className={styles.agentsMemoryMeta}>via {label}</div>;
};

interface AgentThreadMemoriesPanelProps {
  agentId: string;
  threadId: string;
  agentName: string | null;
  /**
   * Which list to render. Controlled by the AgentsSection toolbar nav; the
   * panel has no tab strip of its own.
   */
  tab: AgentContextTab;
  focusMemoryId?: string | null;
  focusSummaryId?: string | null;
  /**
   * Thread-wide proposals awaiting approval, listed in their own group above
   * the saved memories; owned by AgentsSection (useProposedMemories).
   */
  proposed?: MemoryRecord[];
  proposedError?: string | null;
  /** Keep or remove a proposal; resolves true once the server took it. */
  onResolveProposed?: (memory: MemoryRecord, action: ProposedAction) => Promise<boolean> | void;
}

export const AgentThreadMemoriesPanel: FC<AgentThreadMemoriesPanelProps> = ({
  agentId,
  threadId,
  agentName,
  tab,
  focusMemoryId,
  focusSummaryId,
  proposed = [],
  proposedError = null,
  onResolveProposed,
}) => {
  const [memories, setMemories] = useState<MemoryRecord[] | null>(null);
  const [summaries, setSummaries] = useState<ThreadSummaryRecord[] | null>(null);
  const [loadingMem, setLoadingMem] = useState(false);
  const [loadingSumm, setLoadingSumm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<
    { kind: 'memory'; data: MemoryRecord } | { kind: 'summary'; data: ThreadSummaryRecord } | null
  >(null);
  const proposedHeadingId = useId();

  // Saved memories deleted here, in flight or done. A read the server answered
  // before the delete committed still lists them, so every read leaves them
  // out (a failed delete takes its card out of this set).
  const deleted = useRef(new Set<string>());
  // A delete that fails after the agent or thread changed must not touch the new list.
  const listKey = `${agentId}:${threadId}`;
  const listKeyRef = useRef(listKey);
  listKeyRef.current = listKey;
  // After a keyboard delete, focus moves to the neighboring card.
  const focusAfterDelete = useRef<string | typeof LIST_FOCUS | null>(null);

  // Memories fetch — lazy. Fires the first time the tab activates,
  // then caches in local state. Re-fetch whenever the agent changes.
  useEffect(() => {
    if (tab !== 'memories' || memories !== null) return;
    let canceled = false;
    setLoadingMem(true);
    setError(null);
    memoriesApi
      .list(agentId, { threadId })
      .then((data) => {
        if (!canceled) setMemories(data.filter((m) => !deleted.current.has(m.id)));
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load memories'));
      })
      .finally(() => {
        if (!canceled) setLoadingMem(false);
      });
    return () => {
      canceled = true;
    };
  }, [agentId, threadId, tab, memories]);

  // Reset cached data when the agent changes so the next activation
  // triggers a fresh fetch.
  useEffect(() => {
    setMemories(null);
    setSummaries(null);
    setError(null);
  }, [agentId, threadId]);

  // Summaries fetch — lazy. Fires the first time the summaries tab
  // activates. Same pattern as memories.
  useEffect(() => {
    if (tab !== 'summaries' || summaries !== null) return;
    let canceled = false;
    setLoadingSumm(true);
    setError(null);
    threadsApi
      .listAgentSummaries(threadId, agentId)
      .then((data) => {
        if (!canceled) setSummaries(data);
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load summaries'));
      })
      .finally(() => {
        if (!canceled) setLoadingSumm(false);
      });
    return () => {
      canceled = true;
    };
  }, [agentId, threadId, tab, summaries]);

  const label = agentName ?? 'selected agent';
  // Memories carry no model stamp — only a summary preview has provenance.
  const previewModel = preview?.kind === 'summary' ? formatModelUsed(preview.data.modelUsed) : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const activeFocusId = tab === 'memories' ? focusMemoryId : focusSummaryId;
  // Whether the list is loaded, not the list itself: deleting a card must not
  // scroll back to and re-flash the deep-linked one.
  const activeListLoaded = (tab === 'memories' ? memories : summaries) !== null;
  useEffect(() => {
    if (!activeFocusId || !activeListLoaded) return;
    const body = bodyRef.current;
    if (!body) return;
    const row = body.querySelector<HTMLElement>(`[data-item-id="${activeFocusId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add(styles.agentsMemoryRowFlash);
    const timeout = window.setTimeout(() => {
      row.classList.remove(styles.agentsMemoryRowFlash);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [activeFocusId, activeListLoaded]);

  useEffect(() => {
    const target = focusAfterDelete.current;
    if (!target) return;
    focusAfterDelete.current = null;
    const body = bodyRef.current;
    // The neighboring card, or the list itself when the last card went.
    const card =
      target === LIST_FOCUS ? null : body?.querySelector<HTMLElement>(`[data-item-id="${target}"]`);
    (card ?? body)?.focus();
  }, [memories]);

  /**
   * Delete a saved memory for good: the same hard delete as the agent page's
   * Memories tab (`DELETE /api/memories/:id`). No confirm; the card leaves at
   * once and comes back, with the error, if the call fails. A 404 means it was
   * already gone, which counts as done.
   */
  const deleteMemory = async (memory: MemoryRecord, viaKeyboard: boolean) => {
    const forList = listKeyRef.current;
    const list = memories ?? [];
    const at = list.findIndex((m) => m.id === memory.id);
    focusAfterDelete.current = viaKeyboard
      ? ((list[at + 1] ?? list[at - 1])?.id ?? LIST_FOCUS)
      : null;
    deleted.current.add(memory.id);
    setError(null);
    setMemories((prev) => (prev ? prev.filter((m) => m.id !== memory.id) : prev));
    try {
      await memoriesApi.delete(memory.id);
    } catch (err) {
      if (isAlreadyGone(err)) return;
      deleted.current.delete(memory.id);
      if (listKeyRef.current !== forList) return;
      setMemories((prev) => (prev ? insertNewestFirst(prev, memory) : prev));
      setError(getErrorMessage(err, 'Failed to delete memory'));
    }
  };

  /**
   * Keep moves the card into the saved list at once (a kept fact about you is
   * listed there, marked "About you"); remove just drops it. If the keep
   * fails, the card leaves the saved list again and the proposals hook puts it
   * back in the group.
   */
  const resolveProposed = async (memory: MemoryRecord, action: ProposedAction) => {
    if (!onResolveProposed) return;
    const forList = listKeyRef.current;
    if (action === 'keep') {
      const kept = { ...memory, updatedAt: new Date().toISOString() };
      setMemories((prev) => (prev ? insertNewestFirst(prev, kept) : prev));
    }
    const ok = await onResolveProposed(memory, action);
    if (!ok && action === 'keep' && listKeyRef.current === forList) {
      setMemories((prev) => (prev ? prev.filter((m) => m.id !== memory.id) : prev));
    }
  };

  return (
    <aside className={styles.agentsMemoriesPanel} aria-label={`Context from ${label}`}>
      {/* A failed load shows only the error, not an empty list's "No … yet". */}
      {error && (
        <div className={styles.agentsMemoriesError} role="alert">
          {error}
        </div>
      )}

      {tab === 'memories' && (
        <div
          className={styles.agentsMemoriesBody}
          role="tabpanel"
          ref={bodyRef}
          // Focus lands here after the last card is deleted from the keyboard.
          tabIndex={-1}
          aria-label="Memories"
        >
          {proposedError && (
            <div className={styles.agentsMemoriesError} role="alert">
              {proposedError}
            </div>
          )}

          {/* Proposals first, in a group of their own. No proposals: no group,
              no heading, no gap. Their controls always show: they wait on you. */}
          {proposed.length > 0 && (
            <section className={styles.agentsProposedGroup} aria-labelledby={proposedHeadingId}>
              <h3 id={proposedHeadingId} className={styles.agentsMemoryGroupHeading}>
                Proposed ({proposed.length})
              </h3>
              <div className={styles.agentsProposedHint}>
                Facts about you that an agent proposed. They are not remembered until you keep them.
              </div>
              {proposed.map((m) => (
                <article key={m.id} data-item-id={m.id} className={styles.agentsProposedRow}>
                  <div className={styles.agentsProposedText}>
                    {m.key && (
                      <div className={styles.agentsMemoryKey}>{memoryKeyWithBreaks(m.key)}</div>
                    )}
                    <div className={styles.agentsMemoryContent}>{m.content}</div>
                    <div className={styles.agentsMemoryMeta}>{formatDateTime(m.updatedAt)}</div>
                  </div>
                  <div className={styles.agentsProposedActions}>
                    <button
                      type="button"
                      className={styles.agentsProposedKeep}
                      aria-label={m.key ? `Keep memory ${m.key}` : 'Keep memory'}
                      title="Keep: remember this"
                      onClick={() => void resolveProposed(m, 'keep')}
                    >
                      <CheckIcon />
                    </button>
                    <button
                      type="button"
                      className={styles.agentsProposedRemove}
                      aria-label={
                        m.key ? `Remove proposed memory ${m.key}` : 'Remove proposed memory'
                      }
                      title="Remove: do not remember this"
                      onClick={() => void resolveProposed(m, 'remove')}
                    >
                      ✕
                    </button>
                  </div>
                </article>
              ))}
            </section>
          )}
          {proposed.length > 0 && <h3 className={styles.agentsMemoryGroupHeading}>Saved</h3>}

          {loadingMem ? (
            <div className={styles.agentsMemoriesHint}>Loading memories…</div>
          ) : !memories ? null : memories.length === 0 ? (
            <div className={styles.agentsMemoriesHint}>
              No memories yet for {agentName ?? 'this agent'} in this thread.
            </div>
          ) : (
            memories.map((m) => (
              // The delete button is a sibling of the card, never inside it
              // (the card is itself a button).
              <div key={m.id} className={styles.agentsMemoryItem}>
                <article
                  data-item-id={m.id}
                  className={styles.agentsMemoryRow}
                  role="button"
                  tabIndex={0}
                  aria-label={m.key ? `Open memory ${m.key}` : 'Open memory'}
                  onClick={() => setPreview({ kind: 'memory', data: m })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setPreview({ kind: 'memory', data: m });
                    }
                  }}
                >
                  {(m.key || m.memberId) && (
                    <div className={styles.agentsMemoryKeyRow}>
                      {m.key && (
                        <span className={styles.agentsMemoryKey}>{memoryKeyWithBreaks(m.key)}</span>
                      )}
                      {/* A fact about you that you kept, not the agent's own. */}
                      {m.memberId && <span className={styles.agentsMemoryAboutYou}>About you</span>}
                    </div>
                  )}
                  <div className={styles.agentsMemoryContent}>{m.content}</div>
                  <div className={styles.agentsMemoryMeta}>{formatDateTime(m.updatedAt)}</div>
                </article>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  className={styles.agentsMemoryDelete}
                  title="Delete memory"
                  aria-label={m.key ? `Delete memory ${m.key}` : 'Delete memory'}
                  // detail 0: activated from the keyboard, so focus follows.
                  onClick={(e) => void deleteMemory(m, e.detail === 0)}
                >
                  <TrashIcon />
                </Button>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'summaries' && (
        <div className={styles.agentsMemoriesBody} role="tabpanel" ref={bodyRef}>
          {loadingSumm ? (
            <div className={styles.agentsMemoriesHint}>Loading summaries…</div>
          ) : !summaries ? null : summaries.length === 0 ? (
            <div className={styles.agentsMemoriesHint}>
              No summaries yet for {agentName ?? 'this agent'} in this thread.
            </div>
          ) : (
            summaries.map((s) => (
              <article
                key={s.id}
                data-item-id={s.id}
                className={styles.agentsMemoryRow}
                role="button"
                tabIndex={0}
                aria-label={`Open summary v${s.version}`}
                onClick={() => setPreview({ kind: 'summary', data: s })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setPreview({ kind: 'summary', data: s });
                  }
                }}
              >
                <div className={styles.agentsMemoryKey}>
                  v{s.version}
                  {s.isCurrent ? ' · current' : ''}
                  {s.messagesInWindow > 0
                    ? ` · ${s.messagesInWindow} ${s.compaction ? 'turns' : 'msgs'}`
                    : ''}
                </div>
                <div className={styles.agentsMemoryContent}>{s.summaryText}</div>
                <SummaryProvenance modelUsed={s.modelUsed} />
                <div className={styles.agentsMemoryMeta}>{formatDateTime(s.updatedAt)}</div>
              </article>
            ))
          )}
        </div>
      )}

      {preview && (
        <Modal onClose={() => setPreview(null)}>
          <Modal.Header>
            <div className={styles.agentsMemoryPreviewTitle}>
              {preview.kind === 'memory'
                ? (preview.data.key ?? 'Memory')
                : `Summary v${preview.data.version}`}
            </div>
          </Modal.Header>
          <Modal.Body>
            <pre className={styles.agentsMemoryPreviewContent}>
              {preview.kind === 'memory' ? preview.data.content : preview.data.summaryText}
            </pre>
            <div className={styles.agentsMemoryPreviewMeta}>
              Updated {new Date(preview.data.updatedAt).toLocaleString()}
              {previewModel ? ` · via ${previewModel}` : ''}
            </div>
          </Modal.Body>
        </Modal>
      )}
    </aside>
  );
};
