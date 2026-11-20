import type { FC, ReactNode } from 'react';
import { Button } from '@desktop/components';
import { PropertiesDisclosure } from '@desktop/pages/Dashboard/views/shared/PropertiesDisclosure';
import { formatDateTime } from '@snaglet/shared/utils';
import type { TestConsoleEntry } from './testConsoleEntries';
import styles from './BuilderTestConsole.module.scss';

interface BuilderTestConsoleProps {
  /** Collapsible header label. */
  title?: string;
  /** Permanent caution copy — the real-execution / sandbox-limits note. */
  notice: ReactNode;
  /** Variant-supplied input controls + run buttons. */
  controls: ReactNode;
  /** Newest-first run history (see useTestConsoleEntries). */
  entries: TestConsoleEntry[];
  onClear: () => void;
  expanded: boolean;
  /** Controlled toggle so hosts can lazy-load metadata on first open. */
  onToggle: () => void;
}

const ConsoleEntry: FC<{ entry: TestConsoleEntry }> = ({ entry }) => {
  const meta: string[] = [formatDateTime(entry.at)];
  if (typeof entry.durationMs === 'number') meta.push(`${entry.durationMs}ms`);
  if (entry.exitCode !== undefined && entry.exitCode !== null) meta.push(`exit ${entry.exitCode}`);
  if (entry.timedOut) meta.push('timed out');
  return (
    <article className={styles.entry}>
      <div className={styles.entryHead}>
        <span className={entry.status === 'ok' ? styles.badgeOk : styles.badgeFail}>
          {entry.status}
        </span>
        <span className={styles.entryLabel}>{entry.label}</span>
        <span className={styles.entryMeta}>{meta.join(' · ')}</span>
      </div>
      {entry.note && (
        <p className={styles.entryNote} role="note">
          {entry.note}
        </p>
      )}
      {entry.payload !== undefined && (
        <details className={styles.payload}>
          <summary className={styles.payloadSummary}>{entry.payloadLabel ?? 'Payload'}</summary>
          <pre className={styles.payloadJson}>{JSON.stringify(entry.payload, null, 2)}</pre>
        </details>
      )}
      {entry.stdout?.trim() ? <pre className={styles.stdout}>{entry.stdout.trim()}</pre> : null}
      {entry.stderr?.trim() ? <pre className={styles.stderr}>{entry.stderr.trim()}</pre> : null}
    </article>
  );
};

/**
 * BuilderTestConsole — the shared collapsible "test it here" surface for the
 * hook and tool builders. Purely presentational: variants own their inputs
 * (`controls`), how a run is executed, and the entry list (via
 * `useTestConsoleEntries`); PropertiesDisclosure owns the shared collapse
 * chrome while this component owns the permanent caution notice and stacked
 * newest-first run log with visually distinct stdout/stderr, exit/duration
 * metadata, and ok/fail badges.
 */
export const BuilderTestConsole: FC<BuilderTestConsoleProps> = ({
  title = 'Test console',
  notice,
  controls,
  entries,
  onClear,
  expanded,
  onToggle,
}) => (
  <PropertiesDisclosure
    ariaLabel={title}
    expanded={expanded}
    onToggle={onToggle}
    label={title}
    inset={false}
    bodyClassName={styles.body}
    header={
      <>
        {entries.length > 0 && <span className={styles.count}>{entries.length}</span>}
        {expanded && entries.length > 0 && (
          <Button variant="ghost" size="sm" className={styles.headerAction} onClick={onClear}>
            Clear
          </Button>
        )}
      </>
    }
  >
    <p className={styles.notice}>{notice}</p>
    {controls}
    <div className={styles.log} role="log" aria-label={`${title} results`}>
      {entries.length === 0 ? (
        <p className={styles.empty}>No test runs yet.</p>
      ) : (
        entries.map((entry) => <ConsoleEntry key={entry.id} entry={entry} />)
      )}
    </div>
  </PropertiesDisclosure>
);
