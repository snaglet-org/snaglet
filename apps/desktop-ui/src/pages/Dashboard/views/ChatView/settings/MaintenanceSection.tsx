import type { FC } from 'react';
import { Button, Section, Stack } from '@desktop/components';
import { InfoHint } from './InfoHint';
import styles from './ChatSettings.module.scss';

const TRIM_EXPLANATION =
  'Choose the first and last message to keep; the thread dims everything outside that range. Nothing is deleted until you review and confirm the trim.';

interface MaintenanceSectionProps {
  /** Current size, e.g. "1,820 messages · 12.6 MB"; null while it loads. */
  trimSummary: string | null;
  /** Per-table storage breakdown appended to the help tooltip. */
  trimDetail?: string | null;
  /** Why the current size could not be read. */
  trimError?: string | null;
  trimResult?: string | null;
  onOpenTrim: () => void;
  onClear: () => void;
}

export const MaintenanceSection: FC<MaintenanceSectionProps> = ({
  trimSummary,
  trimDetail = null,
  trimError = null,
  trimResult = null,
  onOpenTrim,
  onClear,
}) => (
  <Stack gap={4} className={styles.pane}>
    <Section
      label={
        <span className={styles.labelWithHint}>
          Trim message history
          <InfoHint
            topic="trimming message history"
            text={trimDetail ? `${TRIM_EXPLANATION} ${trimDetail}` : TRIM_EXPLANATION}
          />
        </span>
      }
    >
      <p className={styles.maintenanceSummary} aria-live="polite">
        {trimSummary ?? (trimError ? 'Current size unavailable.' : 'Reading current thread size…')}
      </p>
      <Button variant="ghost" size="sm" onClick={onOpenTrim}>
        Trim now
      </Button>
      {trimResult && (
        <p className={styles.maintenanceResult} role="status">
          {trimResult}
        </p>
      )}
    </Section>

    <div className={styles.dangerZone}>
      <Section label="Clear thread">
        <p className={styles.maintenanceSummary}>
          Permanently delete this thread&rsquo;s messages and embeddings. A confirmation names the
          thread before anything is removed.
        </p>
        <Button variant="danger" size="sm" onClick={onClear}>
          Clear thread…
        </Button>
      </Section>
    </div>
  </Stack>
);
