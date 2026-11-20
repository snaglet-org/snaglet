import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import {
  memoriesApi,
  runsApi,
  type MemoryRecord,
  type RunListItem,
  type ThreadSummaryRecord,
  type ThreadTreeNode,
} from '../../utils/api';
import { threadsApi } from '../../utils/api/threads';
import { getInitial } from '@snaglet/shared/utils';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { NODE_CHIP_MIME, setActiveDragChip, type NodeChipData } from '@desktop/utils/nodeChip';
import { shortRunId } from '@desktop/utils/nodeChip/runChip';
import { LeafToggle } from '@desktop/components/Icons';
import { firstLine, rowIndent } from './treeUtils';
import type { ThreadAgentEntry } from './types';
import styles from './WorkspaceTree.module.scss';

interface ThreadAgentRowProps {
  thread: ThreadTreeNode;
  entry: ThreadAgentEntry;
  depth: number;
}

/**
 * One row per agent in a thread's "Agents" group. The chevron opens
 * Memories, Thread summaries and Runs, each loaded on first expand; a memory
 * or summary row deep-links to the thread's Agents settings. Run rows are
 * drag-only `run` chips (a run is not a workspace node). Clicking the label
 * opens the agent's detail. Each row caches its own data.
 */
export function ThreadAgentRow({ thread, entry, depth }: ThreadAgentRowProps) {
  const nav = useDashboardNavigation();
  const agent = entry.agent;
  const agentId = entry.participant.agentId;
  const displayName = agent?.name?.trim() || `${agentId.slice(0, 8)}…`;
  const role = agent?.role?.trim() || null;
  const initial = getInitial(displayName);

  const [open, setOpen] = useState(false);
  const [memoriesOpen, setMemoriesOpen] = useState(true);
  const [summariesOpen, setSummariesOpen] = useState(true);
  // Runs start closed and fetch only on first expand. Unlike memories and
  // summaries (small, bounded per agent), a busy agent's run history is
  // unbounded execution log — not worth a request until asked for.
  const [runsOpen, setRunsOpen] = useState(false);
  const [memories, setMemories] = useState<MemoryRecord[] | null>(null);
  const [summaries, setSummaries] = useState<ThreadSummaryRecord[] | null>(null);
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const fetchedRef = useRef(false);
  const runsFetchedRef = useRef(false);

  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    let canceled = false;
    Promise.all([
      memoriesApi
        .list(agentId, { threadId: thread.id, limit: 200 })
        .catch(() => [] as MemoryRecord[]),
      threadsApi.listAgentSummaries(thread.id, agentId).catch(() => [] as ThreadSummaryRecord[]),
    ]).then(([mems, sums]) => {
      if (canceled) return;
      setMemories(mems);
      setSummaries(sums);
    });
    return () => {
      canceled = true;
    };
  }, [open, thread.id, agentId]);

  // Runs load lazily on their own first expand — not with the agent row.
  // Server-side `agentId` scoping gives this row its own newest-N instead of
  // fetching the thread's runs and filtering client-side.
  useEffect(() => {
    if (!runsOpen || runsFetchedRef.current) return;
    runsFetchedRef.current = true;
    let canceled = false;
    runsApi
      .listByThread(thread.id, { limit: 200, agentId })
      .catch(() => [] as RunListItem[])
      .then((runRows) => {
        if (!canceled) setRuns(runRows);
      });
    return () => {
      canceled = true;
    };
  }, [runsOpen, thread.id, agentId]);

  return (
    <div
      className={styles.rowGroup}
      role="treeitem"
      aria-expanded={open}
      data-agent-row-id={agentId}
      aria-level={depth + 1}
    >
      <div
        className={`${styles.row} ${styles.rowTask}`}
        style={{ paddingLeft: rowIndent(depth) }}
        onClick={(e) => {
          e.stopPropagation();
          nav?.openThreadAgent(thread, agentId);
        }}
        title={role ? `${displayName} · ${role}` : displayName}
      >
        <span
          className={styles.chevron}
          aria-hidden
          onClick={(e) => {
            // Chevron must not bubble — without stopPropagation the row's
            // outer onClick fires and the dashboard opens the agent
            // detail, which is the opposite of "just expand the leaf".
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          <LeafToggle open={open} className={styles.leafToggle} />
        </span>
        <span className={styles.icon} aria-hidden>
          {initial}
        </span>
        <span className={styles.label}>{displayName}</span>
        {role && <span className={styles.projectBadge}>{role}</span>}
      </div>

      {open && (
        <div role="group">
          {/* Memories category */}
          <div
            className={styles.taskGroupHeader}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            role="button"
            aria-expanded={memoriesOpen}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              setMemoriesOpen((v) => !v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setMemoriesOpen((v) => !v);
              }
            }}
          >
            <span className={styles.chevron} aria-hidden>
              <LeafToggle open={memoriesOpen} className={styles.leafToggle} />
            </span>
            <span className={styles.taskGroupLabel}>Memories</span>
            {memories !== null && <span className={styles.taskGroupCount}>{memories.length}</span>}
          </div>
          {memoriesOpen && memories === null && (
            <div className={styles.taskHint} style={{ paddingLeft: 8 + (depth + 2) * 14 }}>
              Loading…
            </div>
          )}
          {memoriesOpen && memories !== null && memories.length === 0 && (
            <div className={styles.taskHint} style={{ paddingLeft: 8 + (depth + 2) * 14 }}>
              No memories
            </div>
          )}
          {memoriesOpen &&
            memories?.map((m) => {
              const label = m.key?.trim() || firstLine(m.content) || 'Untitled memory';
              return (
                <div
                  key={m.id}
                  className={`${styles.row} ${styles.rowTask}`}
                  style={{ paddingLeft: 8 + (depth + 2) * 14 }}
                  draggable
                  onDragStart={(e) =>
                    setNodeChipDrag(
                      e,
                      { id: m.id, kind: 'memory', title: label },
                      `memory · ${label}`
                    )
                  }
                  onDragEnd={() => setActiveDragChip(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    nav?.openThreadAgent(thread, agentId, {
                      focus: { kind: 'memory', id: m.id },
                    });
                  }}
                  title={m.content}
                >
                  <span className={styles.chevron} aria-hidden />
                  <span className={styles.icon} aria-hidden>
                    ◆
                  </span>
                  <span className={styles.label}>{label}</span>
                </div>
              );
            })}

          {/* Thread summaries category */}
          <div
            className={styles.taskGroupHeader}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            role="button"
            aria-expanded={summariesOpen}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              setSummariesOpen((v) => !v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSummariesOpen((v) => !v);
              }
            }}
          >
            <span className={styles.chevron} aria-hidden>
              <LeafToggle open={summariesOpen} className={styles.leafToggle} />
            </span>
            <span className={styles.taskGroupLabel}>Thread summaries</span>
            {summaries !== null && (
              <span className={styles.taskGroupCount}>{summaries.length}</span>
            )}
          </div>
          {summariesOpen && summaries === null && (
            <div className={styles.taskHint} style={{ paddingLeft: 8 + (depth + 2) * 14 }}>
              Loading…
            </div>
          )}
          {summariesOpen && summaries !== null && summaries.length === 0 && (
            <div className={styles.taskHint} style={{ paddingLeft: 8 + (depth + 2) * 14 }}>
              No summaries
            </div>
          )}
          {summariesOpen &&
            summaries?.map((s) => {
              const label = `v${s.version}${s.isCurrent ? ' · current' : ''}`;
              const dragTitle = `${displayName} summary ${label}`;
              return (
                <div
                  key={s.id}
                  className={`${styles.row} ${styles.rowTask}`}
                  style={{ paddingLeft: 8 + (depth + 2) * 14 }}
                  draggable
                  onDragStart={(e) =>
                    setNodeChipDrag(
                      e,
                      { id: s.id, kind: 'thread_summary', title: dragTitle },
                      `summary · ${label}`
                    )
                  }
                  onDragEnd={() => setActiveDragChip(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    nav?.openThreadAgent(thread, agentId, {
                      focus: { kind: 'summary', id: s.id },
                    });
                  }}
                  title={s.summaryText}
                >
                  <span className={styles.chevron} aria-hidden />
                  <span className={styles.icon} aria-hidden>
                    ✶
                  </span>
                  <span className={styles.label}>{label}</span>
                </div>
              );
            })}

          {/* Runs category — drag-only chips (agent name + run id) */}
          <div
            className={styles.taskGroupHeader}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            role="button"
            aria-expanded={runsOpen}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              setRunsOpen((v) => !v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setRunsOpen((v) => !v);
              }
            }}
          >
            <span className={styles.chevron} aria-hidden>
              <LeafToggle open={runsOpen} className={styles.leafToggle} />
            </span>
            <span className={styles.taskGroupLabel}>Runs</span>
            {runs !== null && <span className={styles.taskGroupCount}>{runs.length}</span>}
          </div>
          {runsOpen && runs === null && (
            <div className={styles.taskHint} style={{ paddingLeft: 8 + (depth + 2) * 14 }}>
              Loading…
            </div>
          )}
          {runsOpen && runs !== null && runs.length === 0 && (
            <div className={styles.taskHint} style={{ paddingLeft: 8 + (depth + 2) * 14 }}>
              No runs
            </div>
          )}
          {runsOpen &&
            runs?.map((run) => {
              // Row label is the short id: the agent name is already the
              // parent row, so repeating it per row would be pure noise. The
              // chip title still carries the full "name · id" for drop targets.
              const shortId = shortRunId(run.id);
              const chipTitle = `${displayName} · ${shortId}`;
              return (
                <div
                  key={run.id}
                  className={`${styles.row} ${styles.rowTask}`}
                  style={{ paddingLeft: 8 + (depth + 2) * 14 }}
                  draggable
                  data-run-id={run.id}
                  onDragStart={(e) =>
                    setNodeChipDrag(
                      e,
                      { id: run.id, kind: 'run', title: chipTitle },
                      `run · ${shortId}`
                    )
                  }
                  onDragEnd={() => setActiveDragChip(null)}
                  title={`${displayName} · ${run.status} · ${run.id}`}
                >
                  <span className={styles.chevron} aria-hidden />
                  <span className={styles.icon} aria-hidden>
                    ▶
                  </span>
                  <span className={styles.label}>{shortId}</span>
                  {run.status !== 'completed' && (
                    <span className={styles.projectBadge}>{run.status}</span>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

/**
 * Stash a NODE_CHIP_MIME payload on the drag event so chip-accepting
 * editors (DocEditor, ChatComposer, system-prompt fields) splice the
 * row in as a `[Title](memory-…)` / `[Title](thread_summary-…)` chip.
 * Mirrors FeedView's `setChipDragPayload` — kept local to this file to
 * avoid promoting a one-off helper to a shared util before it has more
 * than two callers.
 */
function setNodeChipDrag(
  e: ReactDragEvent<HTMLElement>,
  chip: { id: string; kind: NodeChipData['kind']; title: string },
  dragLabel: string
): void {
  e.stopPropagation();
  try {
    e.dataTransfer.setData(NODE_CHIP_MIME, JSON.stringify(chip));
  } catch {
    /* Safari + protected MIME — silent degrade to text-only drag. */
  }
  setActiveDragChip(chip); // Tauri/WKWebView in-memory fallback
  // Note: do not overwrite text/plain with kind:id. writeChipDragData already
  // sets it with the __snaglet_chip__: prefix for WKWebView. Write a separate key
  // if you need a raw kind:id for external apps.
  // `all` so the receiver's chosen dropEffect is whatever it wants:
  // DocEditor / SystemPromptEditor use 'copy', the chat Composer uses
  // 'link'. With a narrower effectAllowed (e.g. 'copy') the browser
  // refuses any drop whose dropEffect is outside that set — which was
  // silently breaking the chat composer specifically.
  e.dataTransfer.effectAllowed = 'all';
  if (typeof document !== 'undefined') {
    const ghost = document.createElement('div');
    ghost.textContent = dragLabel;
    ghost.style.position = 'fixed';
    ghost.style.top = '-9999px';
    ghost.style.left = '-9999px';
    ghost.style.padding = '4px 8px';
    ghost.style.background = 'var(--color-foreground, #fff)';
    ghost.style.border = '1px solid var(--color-primary)';
    ghost.style.font = '12px var(--font-mono, monospace)';
    document.body.appendChild(ghost);
    try {
      e.dataTransfer.setDragImage(ghost, 8, 8);
    } catch {
      /* setDragImage unavailable — fine, default ghost shows. */
    }
    window.setTimeout(() => ghost.remove(), 0);
  }
}
