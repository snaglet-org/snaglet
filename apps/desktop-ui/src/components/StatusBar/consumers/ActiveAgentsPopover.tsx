import { useEffect, useState, type FC } from 'react';
import type { ActiveWorkItem } from '@snaglet/shared/types/workspace-events';
import type { ThreadTreeNode } from '@desktop/utils/api';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { cn } from '@desktop/utils/classNames';
import styles from './ActiveAgentsPopover.module.scss';

/**
 * Elapsed-time label for an active work row: "42s", "3m 12s", "1h 04m".
 * Clock skew between server `startedAt` and the local clock can produce a
 * small negative delta — clamp to zero rather than showing "-2s".
 */
export function formatElapsed(startedAtIso: string, nowMs: number): string {
  const started = Date.parse(startedAtIso);
  const totalSeconds = Number.isNaN(started)
    ? 0
    : Math.max(0, Math.floor((nowMs - started) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** What a row calls the actor and the place it's working. */
function rowLabels(item: ActiveWorkItem): { name: string; where: string } {
  if (item.kind === 'hook-run') {
    return {
      name: item.agentName ?? item.hookName ?? 'Script',
      where: `script: ${item.hookName ?? 'unknown'}`,
    };
  }
  return {
    name: item.agentName ?? 'Agent',
    where: `in ${item.threadTitle?.trim() || 'Untitled thread'}`,
  };
}

/** Minimal thread node — just enough for openInPane to route (see openSearchHit). */
function makeThreadNode(threadId: string, title: string | null): ThreadTreeNode {
  return {
    kind: 'thread',
    id: threadId,
    projectId: null,
    title,
    sortOrder: 0,
    lastMessageAt: null,
    createdAt: '',
    updatedAt: null,
  };
}

/**
 * Scrollable list of everything agents are working on right now, newest
 * first — one row per live run / executing hook. Elapsed times tick locally
 * (no polling); rows for thread runs navigate the active pane to the thread.
 * Rendered inside the status bar's toggle popover.
 */
export const ActiveAgentsPopover: FC<{
  work: ActiveWorkItem[];
  onClose: () => void;
}> = ({ work, onClose }) => {
  const nav = useDashboardNavigation();
  const [now, setNow] = useState(() => Date.now());

  // Local 1s tick while the popover is open — elapsed labels stay live
  // without any network traffic.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (work.length === 0) {
    return <div className={styles.empty}>No agents working.</div>;
  }

  return (
    <ul className={styles.list} aria-label="Agents currently working">
      {work.map((item) => {
        const { name, where } = rowLabels(item);
        const canOpen = item.kind === 'thread-run' && !!item.threadId && !!nav;
        const body = (
          <>
            <span className={styles.rowMain}>
              <span className={styles.name}>{name}</span>
              <span className={styles.where}>{where}</span>
            </span>
            <span className={styles.elapsed}>{formatElapsed(item.startedAt, now)}</span>
          </>
        );
        return (
          <li key={item.id} className={styles.item}>
            {canOpen ? (
              <button
                type="button"
                className={cn(styles.row, styles.rowClickable)}
                onClick={() => {
                  nav?.openInPane(makeThreadNode(item.threadId!, item.threadTitle ?? null));
                  onClose();
                }}
                title="Open thread"
              >
                {body}
              </button>
            ) : (
              <div className={styles.row}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
