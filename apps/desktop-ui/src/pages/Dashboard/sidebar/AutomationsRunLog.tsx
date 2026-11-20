import { useMemo, type FC } from 'react';
import type { AutomationRecord } from '@snaglet/shared/types';
import { TreeRow } from '@desktop/components/SidebarTree';
import { formatAutomationTime } from '@desktop/features/automations/automationActions';
import {
  RUN_LOG_LINES,
  automationRunsKey,
  useRecentAutomationRuns,
} from '@desktop/features/automations/recentRunsStore';
import {
  formatRunDuration,
  mergeRunLog,
  type AutomationRunOf,
  type RunLogEntry,
} from '@desktop/features/automations/runLog';
import { useHookRuns } from '@desktop/utils/hookRunState';
import styles from './AutomationsView.module.scss';

interface AutomationsRunLogProps {
  /** The listed automations (not the deleted ones). */
  automations: readonly AutomationRecord[];
  onOpenAutomation: (automation: AutomationRecord) => void;
  /** Opens the named script; false when it is not installed. */
  onOpenScript: (name: string) => boolean;
}

/**
 * The run log for everything in the Automations list: the automations' newest
 * runs (one cached read across all of them, see recentRunsStore) and the
 * scripts' (the live hook-run store), merged by start time, newest first.
 * Each line names what ran, then what started it, how it ended and how long
 * it took. A line opens its automation or script.
 */
export const AutomationsRunLog: FC<AutomationsRunLogProps> = ({
  automations,
  onOpenAutomation,
  onOpenScript,
}) => {
  const { runs, failed } = useRecentAutomationRuns(automationRunsKey(automations));
  const scriptRuns = useHookRuns();
  const entries = useMemo(() => {
    const byId = new Map(automations.map((a) => [a.id, a]));
    // Lines name the automation as it is now; one deleted since the read drops out.
    const automationRuns: AutomationRunOf[] = (runs ?? []).flatMap((run) => {
      const automation = byId.get(run.automationId);
      return automation ? [{ automation, run }] : [];
    });
    return mergeRunLog(automationRuns, scriptRuns, RUN_LOG_LINES);
  }, [automations, runs, scriptRuns]);

  const open = (entry: RunLogEntry) => {
    if (entry.kind === 'script') {
      onOpenScript(entry.ownerId);
      return;
    }
    const automation = automations.find((a) => a.id === entry.ownerId);
    if (automation) onOpenAutomation(automation);
  };

  return (
    <>
      {failed && (
        <div className={styles.error} role="alert">
          Automation runs did not load.
        </div>
      )}
      {entries.length === 0 && !failed && <div className={styles.note}>No runs yet.</div>}
      {entries.map((entry) => (
        <TreeRow
          key={entry.key}
          as="div"
          role="treeitem"
          tabIndex={0}
          depth={1}
          chevron="empty"
          className={styles.runRow}
          data-status={entry.status}
          data-testid={`run-row-${entry.key}`}
          onClick={() => open(entry)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              open(entry);
            }
          }}
          title={`${entry.name}: ${entry.result.toLowerCase()} (${entry.startedBy})`}
        >
          <span className={styles.text}>
            <span className={styles.name}>{entry.name}</span>
            <span className={styles.meta}>{runLine(entry)}</span>
          </span>
        </TreeRow>
      ))}
    </>
  );
};

/** "Row changed · Ran · 1.2 s · Thu, Nov 5, 9:00 AM". */
function runLine(entry: RunLogEntry): string {
  return [
    entry.startedBy,
    entry.result,
    entry.durationMs === null ? null : formatRunDuration(entry.durationMs),
    formatAutomationTime(entry.startedAt),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}
