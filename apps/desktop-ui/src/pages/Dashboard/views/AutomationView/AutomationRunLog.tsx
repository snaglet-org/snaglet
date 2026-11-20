import { useCallback, useEffect, useRef, useState, type FC, type UIEvent } from 'react';
import type {
  AutomationRecord,
  AutomationRunRecord,
  AutomationRunsResponse,
  ScheduleRunStatus,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, CopyToClipboardButton } from '@desktop/components';
import { formatAutomationTime } from '@desktop/features/automations/automationActions';
import { automationsApi } from '@desktop/utils/api/automations';
import styles from './AutomationRunLog.module.scss';

const RUN_LOG_PAGE_SIZE = 50;
/** Load the next page once the list is scrolled this close to its end. */
const NEAR_END_PX = 48;

const STATUS_LABEL: Record<ScheduleRunStatus, string> = {
  succeeded: 'Ran',
  failed: 'Failed',
  skipped: 'Skipped',
  running: 'Running',
};

type RunPage = AutomationRunsResponse;

/**
 * What changes on the record when a run is added or settles: the shared
 * list is re-read on `automations:changed`, so a new key means a new read.
 */
function runLogKey(a: AutomationRecord): string {
  return [
    a.status,
    a.running,
    a.runningSince,
    a.consecutiveFailures,
    a.updatedAt,
    a.lastRun?.status,
    a.lastRun?.scheduledFor,
    a.lastRun?.finishedAt,
    a.lastRun?.error,
  ].join('|');
}

/**
 * A fresh first page over what is loaded: its rows replace theirs, and older
 * pages already loaded stay (with their cursor) so the scroll position holds.
 */
function mergeFirstPage(fresh: RunPage, current: RunPage | null): RunPage {
  if (!current || !fresh.nextCursor) return fresh;
  const last = fresh.runs[fresh.runs.length - 1];
  const at = last ? current.runs.findIndex((run) => run.id === last.id) : -1;
  if (at === -1) return fresh;
  return { runs: [...fresh.runs, ...current.runs.slice(at + 1)], nextCursor: current.nextCursor };
}

/**
 * The automation's run log: every wake, newest first, in its own scroll box
 * that loads older pages near its end. Re-reads when the automation changes
 * (a wake starting or settling), so a new run shows without a reload; a
 * deleted automation keeps its log.
 */
export const AutomationRunLog: FC<{ automation: AutomationRecord }> = ({ automation }) => {
  const id = automation.id;
  const changeKey = runLogKey(automation);
  const [page, setPage] = useState<RunPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0);
  const pageRef = useRef(page);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    let stale = false;
    Promise.resolve()
      .then(() => automationsApi.runs(id, { limit: RUN_LOG_PAGE_SIZE }))
      .then(
        (fresh) => {
          if (stale) return;
          setPage((current) => mergeFirstPage(fresh, current));
          setError(null);
        },
        (err: unknown) => {
          if (!stale) setError(getErrorMessage(err, "Couldn't load runs"));
        }
      );
    return () => {
      stale = true;
    };
  }, [id, changeKey, reload]);

  const loadMore = useCallback(async () => {
    const cursor = pageRef.current?.nextCursor;
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const older = await automationsApi.runs(id, { limit: RUN_LOG_PAGE_SIZE, before: cursor });
      setPage((current) => {
        if (!current || current.nextCursor !== cursor) return current;
        const seen = new Set(current.runs.map((run) => run.id));
        return {
          runs: [...current.runs, ...older.runs.filter((run) => !seen.has(run.id))],
          nextCursor: older.nextCursor,
        };
      });
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't load older runs"));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [id]);

  // After a failed read, older pages load only from the button (no retry per scroll event).
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget;
    if (!error && box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_END_PX) {
      void loadMore();
    }
  };

  if (!page) {
    return error ? (
      <div className={styles.message}>
        <span>{error}</span>
        <Button size="xs" variant="ghost" onClick={() => setReload((n) => n + 1)}>
          Try again
        </Button>
      </div>
    ) : (
      <p className={styles.message}>Loading…</p>
    );
  }
  if (page.runs.length === 0) return <p className={styles.message}>No runs yet</p>;

  return (
    <div
      className={styles.scroll}
      onScroll={onScroll}
      tabIndex={0}
      role="region"
      aria-label="Run log"
    >
      <ol className={styles.list}>
        {page.runs.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </ol>
      {(page.nextCursor || error) && (
        <div className={styles.more}>
          {error && <span className={styles.moreError}>{error}</span>}
          {page.nextCursor && (
            <Button
              size="xs"
              variant="ghost"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load older runs'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

const RunRow: FC<{ run: AutomationRunRecord }> = ({ run }) => (
  <li className={styles.run} data-status={run.status}>
    <div className={styles.line}>
      <time className={styles.when} dateTime={run.scheduledFor}>
        {formatAutomationTime(run.scheduledFor)}
      </time>
      <span className={styles.status}>{STATUS_LABEL[run.status]}</span>
      {run.manual && <span className={styles.tag}>Run now</span>}
    </div>
    {run.error &&
      (run.status === 'failed' ? (
        <div className={styles.failure}>
          <p className={styles.error}>{run.error}</p>
          <CopyToClipboardButton
            className={styles.copy}
            value={run.error}
            idleTitle="Copy error"
            aria-label="Copy error"
          />
        </div>
      ) : (
        <p className={styles.reason}>{run.error}</p>
      ))}
  </li>
);
