/**
 * Trim message history: the control strip in thread Settings → Maintenance.
 * It holds the scrubber and the figures; the thread pane beside it shows the
 * cut by dimming the messages the plan removes. `ChatView` owns the trim
 * state, and every figure comes from the server's preview, so the panel, the
 * pane and the confirmation dialog show the same calculation. Deleting always
 * goes through the confirmation dialog.
 */

import { useEffect, useState, type FC } from 'react';
import { Button, Checkbox } from '@desktop/components';
import { formatBytes } from '@snaglet/shared/utils';
import type { ThreadTrimApplyResult } from '@snaglet/shared/types';
import type { UseThreadTrimResult } from './useThreadTrim';
import { TrimRangeSlider } from './TrimRangeSlider';
import { TrimConfirmModal } from './TrimConfirmModal';
import styles from './TrimPanel.module.scss';

interface TrimPanelProps {
  /** Trim state, owned by ChatView so the thread pane can dim against it. */
  trim: UseThreadTrimResult;
  /** Fired after a successful trim so the transcript can refetch. */
  onTrimmed?: (result: ThreadTrimApplyResult) => void;
  /** Leave the Trim view without trimming — back to Maintenance. */
  onCancel?: () => void;
}

export const TrimPanel: FC<TrimPanelProps> = ({ trim, onTrimmed, onCancel }) => {
  const [confirming, setConfirming] = useState(false);

  const preview = trim.preview;
  const busy = trim.stats?.threadBusy ?? false;
  const canTrim = Boolean(preview) && !preview?.noop && !busy && !trim.applying;

  // "Remove summaries" is offered only when the thread has summaries to
  // remove (an agent-to-agent DM never compacts, so it has none). The count
  // is the server's whole-thread total, the newest preview's when there is one.
  const summaryCount = preview?.totals.summaries ?? trim.stats?.totals.summaries ?? 0;
  const offerRemoveSummaries = summaryCount > 0;
  const { removeSummaries, setRemoveSummaries } = trim;
  // A choice left checked after the last summary went (a trim that removed
  // them) must not keep asking the server to remove summaries that are gone.
  useEffect(() => {
    if (!offerRemoveSummaries && removeSummaries && (trim.stats || preview)) {
      setRemoveSummaries(false);
    }
  }, [offerRemoveSummaries, removeSummaries, setRemoveSummaries, trim.stats, preview]);

  // A side is jumpable when the resolved plan cuts it. Read off the same
  // `sides` value the dimming and the confirmation read, so the buttons never
  // offer a jump to a cut that isn't there.
  const cutsPrefix = preview?.sides === 'prefix' || preview?.sides === 'both';
  const cutsTail = preview?.sides === 'tail' || preview?.sides === 'both';

  const handleConfirm = async (): Promise<void> => {
    const result = await trim.apply();
    if (result) {
      setConfirming(false);
      onTrimmed?.(result);
    }
    // On failure the modal stays open showing `trim.applyError`.
  };

  const cancelButton = onCancel ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={onCancel}
      title="Back to Maintenance without trimming"
    >
      Cancel
    </Button>
  ) : null;

  if (trim.statsError) {
    return (
      <div className={styles.panel}>
        <p className={styles.error}>{trim.statsError}</p>
        <div className={styles.actions}>
          {cancelButton}
          <Button variant="ghost" size="sm" onClick={trim.refresh}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (trim.messageCount === 0) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.heading}>Trim message history</h3>
        <p className={styles.muted}>This thread has no messages to trim.</p>
        {cancelButton && <div className={styles.actions}>{cancelButton}</div>}
      </div>
    );
  }

  const removed = preview?.removed;
  const summaryImpact = preview?.summaryImpact;

  return (
    <div className={styles.panel} data-tid="trimPanel">
      <header className={styles.head}>
        <h3 className={styles.heading}>Trim message history</h3>
        <p className={styles.hint}>
          Drag the handles to choose the first and last message to keep. Dimmed messages in the
          thread will be deleted.
        </p>
      </header>

      {busy && (
        <p className={styles.busy} role="status">
          An agent is running in this thread. Trimming is blocked until it finishes.
        </p>
      )}

      <TrimRangeSlider
        messageCount={trim.messageCount}
        firstIndex={trim.firstIndex}
        lastIndex={trim.lastIndex}
        onChangeFirst={trim.setFirstIndex}
        onChangeLast={trim.setLastIndex}
        disabled={busy}
      />

      {/*
        Jump to the cut. Same seek path the scrubber uses, so a jump and a drag
        land the boundary in the same place: mid-pane, both sides visible.
      */}
      <div className={styles.jumps}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!cutsPrefix}
          onClick={() => trim.requestSeek('first')}
          title={
            cutsPrefix
              ? 'Scroll the thread to where the older history is cut'
              : 'Nothing is being removed before the kept range'
          }
          data-tid="trimJumpPrefix"
        >
          Jump to prefix
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!cutsTail}
          onClick={() => trim.requestSeek('last')}
          title={
            cutsTail
              ? 'Scroll the thread to where the newer history is cut'
              : 'Nothing is being removed after the kept range'
          }
          data-tid="trimJumpTail"
        >
          Jump to tail
        </Button>
      </div>

      <footer className={styles.foot}>
        {offerRemoveSummaries && (
          <Checkbox
            checked={trim.removeSummaries}
            onChange={trim.setRemoveSummaries}
            disabled={busy}
          >
            Remove summaries
            {summaryImpact && summaryImpact.removed > 0 && (
              <span className={styles.checkboxDetail}>
                {' '}
                — {summaryImpact.removed}, {formatBytes(summaryImpact.removedBytes)}
              </span>
            )}
          </Checkbox>
        )}

        {/*
          The last settled figures stay put while a new preview is in flight,
          marked stale rather than blanked, so they don't flicker on every drag.
        */}
        <div
          className={[styles.tally, trim.previewLoading ? styles.tallyStale : '']
            .filter(Boolean)
            .join(' ')}
          aria-live="polite"
          aria-busy={trim.previewLoading}
          data-tid="trimImpact"
          data-stale={trim.previewLoading ? 'true' : undefined}
        >
          {trim.previewError ? (
            <span className={styles.error}>{trim.previewError}</span>
          ) : removed ? (
            <span data-tid="trimRemoved">
              Removing <strong>{removed.messages.toLocaleString()}</strong> of{' '}
              {trim.messageCount.toLocaleString()}
              {' · '}
              <span title={`${removed.bytes.total.toLocaleString()} bytes`}>
                {formatBytes(removed.bytes.total)}
              </span>
              {removed.runs > 0 && (
                <span className={styles.sub}>
                  {' '}
                  ({removed.runs.toLocaleString()} runs, {removed.activity.toLocaleString()}{' '}
                  activity)
                </span>
              )}
            </span>
          ) : (
            <span className={styles.muted}>Reading thread…</span>
          )}
        </div>

        {/*
          Not a warning: nothing is lost here. A summary whose covered span is
          being deleted keeps its text and only has its coverage counter reset,
          so the condensed memory of the trimmed history survives the trim.
        */}
        {!trim.removeSummaries && (summaryImpact?.repairedCoverage ?? 0) > 0 && (
          <p className={styles.note}>
            {summaryImpact?.repairedCoverage} summar
            {summaryImpact?.repairedCoverage === 1 ? 'y' : 'ies'} kept — their coverage is reset
            because the messages they summarize are going. The summary text stays.
          </p>
        )}
        {preview?.expandedForRunAtomicity && (
          <p className={styles.warn}>Boundaries widened to keep agent runs whole.</p>
        )}

        <div className={styles.actions}>
          {cancelButton}
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={!canTrim}
            title={
              busy
                ? 'Blocked while an agent is running'
                : preview?.noop
                  ? 'Move a handle to select history to remove'
                  : 'Review and confirm the trim'
            }
          >
            Trim…
          </Button>
        </div>
      </footer>

      {confirming && preview && (
        <TrimConfirmModal
          preview={preview}
          submitting={trim.applying}
          error={trim.applyError}
          onCancel={() => {
            trim.clearApplyError();
            setConfirming(false);
          }}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
};
