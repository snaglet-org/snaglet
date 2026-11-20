import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@desktop/components';
import { schedulesApi } from '@desktop/utils/api';
import { useWsChannel } from '@desktop/ws/useWs';
import type { ScheduleRecord, ScheduleRunRecord } from '@snaglet/shared/types';
import { formatDateTime, getErrorMessage } from '@snaglet/shared/utils';
import styles from './HookBuilderPanel.module.scss';

interface HookSchedulesPanelProps {
  hookName: string;
}

/** Whether a schedule fires this hook (declared in its hook.ts). */
export function isHookSchedule(schedule: ScheduleRecord, hookName: string): boolean {
  return (
    schedule.actionKind === 'hook' &&
    'hookName' in schedule.action &&
    schedule.action.hookName === hookName
  );
}

/** Read-only operational status for schedules declared in hook.ts. */
export function HookSchedulesPanel({ hookName }: HookSchedulesPanelProps) {
  // null until the first read lands.
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ScheduleRunRecord[]>>({});
  const { lastMessage } = useWsChannel('schedules');

  // Only the newest read lands, so a slow one can't put back an older state.
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const scheduleRows = await schedulesApi.list();
      if (request !== requestRef.current) return;
      setSchedules(scheduleRows.filter((schedule) => isHookSchedule(schedule, hookName)));
      setError(null);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(getErrorMessage(err, "Couldn't load schedules"));
    }
  }, [hookName]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (lastMessage?.type === 'schedule:changed') void load();
  }, [lastMessage, load]);

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't change the schedule"));
    } finally {
      setBusyId(null);
    }
  };

  const showRuns = async (id: string) => {
    try {
      const rows = await schedulesApi.runs(id);
      setRuns((current) => ({ ...current, [id]: rows }));
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't load the schedule's runs"));
    }
  };

  return (
    <div className={styles.schedulePanel}>
      <div className={styles.scheduleLead}>
        <span className={styles.fieldLabel}>Declared in hook.ts</span>
        <span className={styles.fieldHint}>
          Add or change the `schedule` array in `defineHook`. This view only shows runtime state.
        </span>
      </div>
      {error && (
        <pre className={styles.formError} role="alert">
          {error}
        </pre>
      )}
      <section className={styles.scheduleList}>
        {schedules === null ? (
          // A failed first read is the error above, not "no schedules".
          !error && <div className={styles.emptySchedule}>Loading schedules…</div>
        ) : schedules.length === 0 ? (
          <div className={styles.emptySchedule}>
            No registered schedules. Add `schedule: [...]` to this script and save it.
          </div>
        ) : (
          schedules.map((schedule) => (
            <article key={schedule.id} className={styles.scheduleCard}>
              <div className={styles.scheduleCardTop}>
                <div>
                  <strong>{schedule.name}</strong>
                  <div className={styles.fieldHint}>
                    {schedule.enabled
                      ? schedule.nextRunAt
                        ? `Next ${formatDateTime(schedule.nextRunAt)}`
                        : 'No future run'
                      : 'Paused'}
                    {schedule.lastStatus ? ` · Last ${schedule.lastStatus}` : ''}
                  </div>
                </div>
                <span className={schedule.enabled ? styles.liveDot : styles.pausedDot}>
                  {schedule.enabled ? 'Live' : 'Paused'}
                </span>
              </div>
              <div className={styles.scheduleActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void act(schedule.id, () =>
                      schedulesApi.setEnabled(schedule.id, !schedule.enabled)
                    )
                  }
                  disabled={busyId === schedule.id}
                >
                  {schedule.enabled ? 'Pause' : 'Resume'}
                </Button>
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={() => void act(schedule.id, () => schedulesApi.runNow(schedule.id))}
                  disabled={busyId === schedule.id}
                >
                  Run now
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void showRuns(schedule.id)}>
                  History
                </Button>
              </div>
              {runs[schedule.id] && (
                <div className={styles.runHistory}>
                  {runs[schedule.id].length === 0 ? (
                    <span className={styles.fieldHint}>No runs yet.</span>
                  ) : (
                    runs[schedule.id].map((run) => (
                      <div key={run.id} className={styles.runRow}>
                        <span
                          className={
                            run.status === 'succeeded' ? styles.resultPass : styles.resultFail
                          }
                        >
                          {run.status}
                        </span>
                        <span>{formatDateTime(run.startedAt)}</span>
                        {run.error && <span title={run.error}>{run.error}</span>}
                      </div>
                    ))
                  )}
                </div>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  );
}
