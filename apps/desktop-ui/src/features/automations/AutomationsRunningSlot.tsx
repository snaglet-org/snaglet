import { useEffect, useMemo, useState, type FC } from 'react';
import type { AutomationRecord } from '@snaglet/shared/types';
import { SwirlIcon } from '@desktop/components/Icons';
import { formatElapsed } from '@desktop/components/StatusBar/consumers/ActiveAgentsPopover';
import { useStatusBarSlot } from '@desktop/components/StatusBar/StatusBarContext';
import type { StatusBarSlot } from '@desktop/components/StatusBar';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { useRunningAutomations } from './automationsStore';
import { SwirlSpin } from './RunningSwirl';
import styles from './AutomationsRunningSlot.module.scss';

const runningLabel = (count: number) => `${count} automation${count === 1 ? '' : 's'} running`;

/**
 * Status-bar note while automations' wakes are going: "1 automation
 * running" with the spinning swirl, right after the hooks slot. Shown only
 * while one runs (the bar is long enough); the popover lists them, and a row
 * opens that automation in the Automations pane.
 */
export const AutomationsRunningSlot: FC = () => {
  const running = useRunningAutomations();
  const count = running.length;

  const slot = useMemo<StatusBarSlot | null>(
    () =>
      count === 0
        ? null
        : {
            id: 'automations-running',
            zone: 'left',
            order: 2.5,
            item: {
              type: 'toggle',
              label: runningLabel(count),
              tone: 'primary',
              title: `${runningLabel(count)} — click for details`,
              icon: (
                <SwirlSpin spinning>
                  <SwirlIcon size={12} />
                </SwirlSpin>
              ),
              render: ({ close }) => (
                <RunningAutomationsPopover running={running} onClose={close} />
              ),
            },
          },
    [count, running]
  );

  useStatusBarSlot(slot);
  return null;
};

const RunningAutomationsPopover: FC<{
  running: AutomationRecord[];
  onClose: () => void;
}> = ({ running, onClose }) => {
  const nav = useDashboardNavigation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (running.length === 0) return <div className={styles.empty}>Nothing running.</div>;

  return (
    <ul className={styles.list} aria-label="Automations running">
      {running.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            className={styles.row}
            title={`Open ${a.name}`}
            onClick={() => {
              nav?.openAutomation?.(a.id, a.name);
              onClose();
            }}
          >
            <span className={styles.main}>
              <span className={styles.name}>{a.name}</span>
              <span className={styles.where}>
                {`${a.agentName ?? 'An agent'} in ${a.threadTitle?.trim() || 'an untitled thread'}`}
              </span>
            </span>
            {a.runningSince && (
              <span className={styles.elapsed}>{formatElapsed(a.runningSince, now)}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
};
