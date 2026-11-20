/**
 * The popover for an automation on the calendar, opened from a
 * once or repeat wake or from an Every automation's line or dot (a run's
 * dot shows that run's time): name,
 * agent, thread link, timing in words ("every 15 minutes"), next run with its
 * countdown and last result, with Pause (a paused automation is not on the
 * calendar, so this closes; Undo on the calendar's stack), Run now and Edit.
 * Nothing moves from here; editing the timing goes through the Edit form.
 * Its Notify section sets reminders before (or at) each wake.
 */
import { useEffect, useState } from 'react';
import type {
  AutomationRecord,
  CalendarAutomationOccurrence,
  CalendarIntervalSpan,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { automationsApi } from '@desktop/utils/api/automations';
import { showToast } from '@desktop/utils/toast';
import {
  automationStatusText,
  formatAutomationNextRun,
  formatAutomationTime,
  lastResultText,
  pauseAutomation,
  resumeAutomation,
  runAutomationNow,
  type OfferUndo,
} from '@desktop/features/automations/automationActions';
import { NextRunCountdown } from '@desktop/pages/Dashboard/views/AutomationView/NextRunCountdown';
import { ReminderSettingsControl } from '@desktop/features/reminders/ReminderSettingsControl';
import { AnchoredSurface } from './AnchoredSurface';
import styles from './CalendarPopovers.module.scss';

export interface AutomationOccurrencePopoverProps {
  anchor: HTMLElement;
  /** Where focus goes on close, when not the anchor (an Every line opened at a slot). */
  returnFocusTo?: HTMLElement | null;
  /** A once or repeat wake, or one day of an Every automation's line. */
  occurrence: CalendarAutomationOccurrence | CalendarIntervalSpan;
  /** The run an Every automation's dot stands for (an ISO instant). */
  runAt?: string;
  /** Where Pause / Resume record their Undo (the calendar's stack). */
  offerUndo: OfferUndo;
  onEdit: (automation: AutomationRecord) => void;
  /** Opens the thread; the title names its pane (else the header shows the raw id). */
  onOpenThread: (threadId: string, title: string | null) => void;
  /** After a change, so the calendar refetches its window. */
  onChanged: () => void;
  onClose: () => void;
}

function wakeText(o: CalendarAutomationOccurrence | CalendarIntervalSpan): string | null {
  if ('kind' in o) return null; // an Every line is no single wake
  if (o.status === 'done') return 'This wake ran.';
  if (o.note === 'failed') return 'This wake failed.';
  if (o.status === 'skipped') return 'This wake was skipped.';
  return null;
}

export function AutomationOccurrencePopover({
  anchor,
  returnFocusTo,
  occurrence: o,
  runAt,
  offerUndo,
  onEdit,
  onOpenThread,
  onChanged,
  onClose,
}: AutomationOccurrencePopoverProps) {
  const [automation, setAutomation] = useState<AutomationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    automationsApi
      .get(o.automationId)
      .then(({ automation: a }) => live && setAutomation(a))
      .catch(
        (err: unknown) => live && setError(getErrorMessage(err, "Couldn't load the automation"))
      );
    return () => {
      live = false;
    };
  }, [o.automationId]);

  const act = async (
    work: (a: AutomationRecord) => Promise<AutomationRecord>,
    failure: string,
    { close = false }: { close?: boolean } = {}
  ) => {
    if (!automation) return;
    setBusy(true);
    try {
      const next = await work(automation);
      onChanged();
      // A paused automation leaves the calendar, so its popover goes too.
      if (close) onClose();
      else setAutomation(next);
    } catch (err) {
      showToast(getErrorMessage(err, failure));
    } finally {
      setBusy(false);
    }
  };

  const a = automation;
  const wake = wakeText(o);
  const title = 'kind' in o ? o.name : o.title;
  return (
    <AnchoredSurface
      anchor={anchor}
      returnFocusTo={returnFocusTo}
      label={`${title} automation`}
      width={300}
      onDismiss={onClose}
    >
      <div className={styles.row}>
        <span className={styles.swatch} aria-hidden />
        <strong className={styles.grow} data-autofocus tabIndex={-1}>
          {title}
        </strong>
      </div>
      <p className={styles.muted}>
        Wakes {o.agentName}
        {a ? ` · ${automationStatusText(a)}` : ''}
      </p>
      {runAt && <p className={styles.periodState}>This run: {formatAutomationTime(runAt)}</p>}
      {error && <p className={styles.error}>{error}</p>}
      {a && (
        <>
          <p className={styles.periodState}>{a.whenText}</p>
          <dl className={styles.facts}>
            <dt className={styles.label}>Next run</dt>
            <dd>
              {a.status === 'active' ? formatAutomationNextRun(a) : automationStatusText(a)}
              <NextRunCountdown automation={a} className={styles.countdown} />
            </dd>
            <dt className={styles.label}>Last result</dt>
            <dd title={a.lastRun?.error ?? undefined}>{lastResultText(a)}</dd>
          </dl>
          {wake && <p className={styles.muted}>{wake}</p>}
          <button
            type="button"
            className={styles.timeLine}
            onClick={() => {
              onClose();
              onOpenThread(a.threadId, a.threadTitle);
            }}
          >
            In {a.threadTitle ?? 'an untitled thread'} →
          </button>
          {/* A first-open one has no start time to remind before. */}
          {a.when.kind !== 'first_open' && (
            <ReminderSettingsControl item={{ kind: 'automation', automationId: a.id }} />
          )}
          <div className={styles.footer}>
            <div className={styles.row}>
              {a.status === 'active' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act((x) => pauseAutomation(x, offerUndo), "Couldn't pause", {
                      close: true,
                    })
                  }
                >
                  Pause
                </Button>
              )}
              {a.status === 'paused' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act((x) => resumeAutomation(x, offerUndo), "Couldn't resume")}
                >
                  Resume
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void act(runAutomationNow, "Couldn't run")}
              >
                Run now
              </Button>
            </div>
            <Button
              size="sm"
              variant="neutral"
              disabled={busy}
              onClick={() => {
                onClose();
                onEdit(a);
              }}
            >
              Edit
            </Button>
          </div>
        </>
      )}
    </AnchoredSurface>
  );
}
