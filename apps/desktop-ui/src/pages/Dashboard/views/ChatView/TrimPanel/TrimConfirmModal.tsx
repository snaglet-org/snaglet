/**
 * Final gate before a trim runs.
 *
 * Everything shown here is the server's own preview payload: the exact retained
 * interval, the exact row counts per table, and the byte figures. Human-readable
 * units are shown alongside — never instead of — the exact numbers, so the
 * confirmation cannot hide what a rounded "10 KB" is really deleting.
 */

import { type FC } from 'react';
import { Button, Modal } from '@desktop/components';
import { formatBytes } from '@snaglet/shared/utils';
import type { ThreadTrimPreview } from '@snaglet/shared/types';
import styles from './TrimConfirmModal.module.scss';

interface TrimConfirmModalProps {
  preview: ThreadTrimPreview;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Which history is going, in words.
 *
 * Read straight off `preview.sides`, which the server derived from the interval
 * it will really cut — the same value that goes into the audit log. The dialog
 * therefore cannot describe a different cut from the one that runs.
 */
function sidesLabel(sides: ThreadTrimPreview['sides']): string {
  switch (sides) {
    case 'both':
      return 'older and newer history, on both sides of the kept range,';
    case 'prefix':
      return 'older history, before the first kept message,';
    case 'tail':
      return 'newer history, after the last kept message,';
    default:
      return 'nothing';
  }
}

const when = (iso: string): string => new Date(iso).toLocaleString();

export const TrimConfirmModal: FC<TrimConfirmModalProps> = ({
  preview,
  submitting,
  error,
  onCancel,
  onConfirm,
}) => {
  const { removed, remaining, summaryImpact } = preview;

  return (
    <Modal onClose={submitting ? () => undefined : onCancel}>
      <Modal.Header>Trim message history?</Modal.Header>
      <Modal.Body>
        <p className={styles.lead}>
          This permanently deletes {sidesLabel(preview.sides)} together with the runs, tool calls
          and agent activity that belong to it. It cannot be undone.
        </p>

        <dl className={styles.facts}>
          <dt>Retaining</dt>
          <dd>
            message {preview.firstRetained.index + 1} – {preview.lastRetained.index + 1} of{' '}
            {preview.totals.messages.toLocaleString()}
            <div className={styles.sub}>
              from <strong>{preview.firstRetained.authorLabel ?? 'unknown'}</strong> at{' '}
              {when(preview.firstRetained.createdAt)}
              <br />
              through <strong>{preview.lastRetained.authorLabel ?? 'unknown'}</strong> at{' '}
              {when(preview.lastRetained.createdAt)}
            </div>
          </dd>

          <dt className={styles.danger}>Removing</dt>
          <dd className={styles.danger}>
            {removed.messages.toLocaleString()} messages · {removed.runs.toLocaleString()} runs ·{' '}
            {removed.activity.toLocaleString()} activity rows · {removed.summaries.toLocaleString()}{' '}
            summaries
            <div className={styles.sub}>
              {formatBytes(removed.bytes.total)} ({removed.bytes.total.toLocaleString()} bytes
              exactly)
            </div>
          </dd>

          <dt>Remaining</dt>
          <dd>
            {remaining.messages.toLocaleString()} messages · {remaining.runs.toLocaleString()} runs
            · {remaining.activity.toLocaleString()} activity rows ·{' '}
            {remaining.summaries.toLocaleString()} summaries
            <div className={styles.sub}>
              {formatBytes(remaining.bytes.total)} ({remaining.bytes.total.toLocaleString()} bytes
              exactly)
            </div>
          </dd>

          <dt>Summaries</dt>
          <dd>
            {preview.removeSummaries
              ? `Removing all ${summaryImpact.removed.toLocaleString()} summaries as requested.`
              : summaryImpact.repairedCoverage > 0
                ? `Keeping all ${summaryImpact.preserved.toLocaleString()}. ${summaryImpact.repairedCoverage.toLocaleString()} summarize history this trim deletes — their text stays, their coverage counter resets to zero.`
                : `Keeping all ${summaryImpact.preserved.toLocaleString()} — none of them cover deleted history.`}
          </dd>
        </dl>

        {preview.expandedForRunAtomicity && (
          <p className={styles.note}>
            The boundaries were widened so no agent run is cut in half — a run&rsquo;s messages and
            its tool calls have to be removed or kept together.
          </p>
        )}

        {error && <div className={styles.error}>{error}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} loading={submitting} disabled={submitting}>
          Trim
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
