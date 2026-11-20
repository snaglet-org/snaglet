import { useEffect, useState, type FC } from 'react';
import type { HookRunRecord } from '@snaglet/shared/types';
import { relativeFromNow } from '@snaglet/shared/utils';
import styles from './HookRunsPopover.module.scss';

function durationLabel(run: HookRunRecord): string {
  if (run.status === 'running') return 'running';
  if (run.durationMs === null) return '—';
  if (run.durationMs < 1000) return `${run.durationMs}ms`;
  return `${(run.durationMs / 1000).toFixed(run.durationMs < 10_000 ? 1 : 0)}s`;
}

export const HookRunsPopover: FC<{ runs: HookRunRecord[] }> = ({ runs }) => {
  const [, setClock] = useState(0);

  useEffect(() => {
    if (!runs.some((run) => run.status === 'running')) return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [runs]);

  if (runs.length === 0) {
    return <div className={styles.empty}>No scripts have run yet.</div>;
  }

  return (
    <div className={styles.surface}>
      <div className={styles.heading}>
        <span>Recent script runs</span>
        <span>{runs.length}</span>
      </div>
      <ol className={styles.list} aria-label="Recent script runs">
        {runs.map((run) => (
          <li key={run.id} className={styles.item} data-status={run.status}>
            <span className={styles.rail} aria-hidden="true" />
            <span className={styles.main}>
              <span className={styles.runTop}>
                <strong>{run.hookName}</strong>
                <span className={styles.status}>{run.status.replace('_', ' ')}</span>
              </span>
              <span className={styles.meta}>
                <span>{run.eventName}</span>
                <span>{run.source}</span>
                <span>{relativeFromNow(run.startedAt)}</span>
                <span>{durationLabel(run)}</span>
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
};
