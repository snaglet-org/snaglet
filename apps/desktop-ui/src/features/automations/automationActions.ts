/**
 * Automation row actions shared by the Automations grid, the pane and the
 * calendar popover: Pause / Resume, Run now, Archive, Restore and moving to
 * another calendar (or none), each through
 * /api/automations (AutomationService), never the generic table writer. No
 * confirmations: every change offers Undo instead. Archive cancels the
 * automation (the Archive drawer lists it); its undo, like Restore, is the restore route (a deleted one
 * back as it was; any other unchanged). Resume's undo puts the pause back as it
 * was (reason and failure streak) through the token the resume returned;
 * once that is refused (it changed, ran or expired) it is a plain pause.
 * Pause's undo, the same way, resumes with the failure streak the pause
 * kept, else it is a plain resume (a fresh streak). A resume refused at the
 * agent's active limit says so.
 */
import type { AutomationActiveLimitDetails, AutomationRecord } from '@snaglet/shared/types';
import { getErrorMessage, isRecord } from '@snaglet/shared/utils';
import { automationsApi } from '@desktop/utils/api/automations';
import { FetchError } from '@desktop/utils/api/core';
import { showToast } from '@desktop/utils/toast';
import { ensureDefaultCalendar } from '@desktop/features/calendar/calendarListActions';
import { loadAutomations } from './automationsStore';

/** Shows "message · Undo"; the caller decides where the step lives (a plain toast, or the calendar's stack). */
export type OfferUndo = (message: string, undo: () => Promise<void>) => void;

const toastUndo: OfferUndo = (message, undo) =>
  showToast(message, {
    action: {
      label: 'Undo',
      run: () => {
        void undo().catch((err: unknown) => showToast(getErrorMessage(err, "Couldn't undo")));
      },
    },
  });

/** {@link toastUndo}, then re-read the shared list so every view shows the undone state. */
export const toastUndoAndReload: OfferUndo = (message, undo) =>
  toastUndo(message, async () => {
    await undo();
    await loadAutomations();
  });

/** A refusal the token path gives up on for the plain step (it changed, ran or expired). */
function isUndoRefused(err: unknown): boolean {
  return err instanceof FetchError && err.status === 409;
}

/** The numbers of a 409 at the agent's active limit (create, resume, undo of a pause), else null. */
function activeLimit(err: unknown): AutomationActiveLimitDetails | null {
  if (!(err instanceof FetchError) || err.status !== 409 || !isRecord(err.details)) return null;
  const { reason, active, max } = err.details;
  return reason === 'active_limit' && typeof active === 'number' && typeof max === 'number'
    ? { reason, active, max }
    : null;
}

/** `err`, or the active limit's reason in words when that is what refused the resume. */
function resumeRefusal(err: unknown): unknown {
  const limit = activeLimit(err);
  return limit
    ? new Error(`Can't resume: ${limit.active} of ${limit.max} automations are active`)
    : err;
}

export async function pauseAutomation(
  a: AutomationRecord,
  offer: OfferUndo = toastUndo
): Promise<AutomationRecord> {
  const { automation, undoToken } = await automationsApi.pause(a.id);
  offer(`Paused ${a.name}`, async () => {
    if (undoToken) {
      try {
        await automationsApi.undoPause(a.id, undoToken);
        return;
      } catch (err) {
        // At the limit a plain resume is refused the same way.
        if (!isUndoRefused(err) || activeLimit(err)) throw resumeRefusal(err);
      }
    }
    await automationsApi.resume(a.id).catch((err: unknown) => {
      throw resumeRefusal(err);
    });
    if (automation.consecutiveFailures > 0) {
      showToast(`Resumed ${a.name} (failure streak not restored)`);
    }
  });
  return automation;
}

export async function resumeAutomation(
  a: AutomationRecord,
  offer: OfferUndo = toastUndo
): Promise<AutomationRecord> {
  const { automation, undoToken } = await automationsApi.resume(a.id);
  offer(`Resumed ${a.name}`, async () => {
    if (undoToken) {
      try {
        await automationsApi.undoResume(a.id, undoToken);
        return;
      } catch (err) {
        if (!isUndoRefused(err)) throw err;
      }
    }
    await automationsApi.pause(a.id);
    showToast(`Paused ${a.name} (failure streak not restored)`);
  });
  return automation;
}

export async function deleteAutomation(
  a: AutomationRecord,
  offer: OfferUndo = toastUndo
): Promise<AutomationRecord> {
  const { automation } = await automationsApi.remove(a.id);
  offer(`Archived ${a.name}`, async () => {
    await automationsApi.restore(a.id);
  });
  return automation;
}

/**
 * Bring a deleted one back as it was. The restore route changes only a
 * deleted one, so a stale row (restored and paused elsewhere meanwhile) is
 * left as it is, where `resume` would activate it.
 */
export async function restoreAutomation(a: AutomationRecord): Promise<AutomationRecord> {
  const { automation } = await automationsApi.restore(a.id);
  showToast(`Restored ${automation.name}`);
  return automation;
}

/**
 * A calendar picker's choice as a calendar id: an id, null (No calendar), or
 * undefined for "Default calendar (new)", which makes the Default calendar
 * now unless one exists by then ({@link ensureDefaultCalendar}).
 */
export async function calendarIdForPick(pick: string | null | undefined): Promise<string | null> {
  return pick === undefined ? (await ensureDefaultCalendar()).id : pick;
}

/**
 * A move's refusal in words: the calendar or the automation went away
 * meanwhile (the server's reply names it by id).
 */
function plainMoveError(err: unknown, automationId: string, calendarId: string | null): unknown {
  if (!(err instanceof FetchError)) return err;
  if (err.status === 404 && calendarId !== null && err.message.includes(calendarId)) {
    return new Error('That calendar no longer exists');
  }
  if ((err.status === 404 && err.message.includes(automationId)) || err.status === 409) {
    return new Error('That automation was deleted');
  }
  return err;
}

async function updateCalendar(a: AutomationRecord, calendarId: string | null) {
  try {
    return (await automationsApi.update(a.id, { calendarId })).automation;
  } catch (err) {
    throw plainMoveError(err, a.id, calendarId);
  }
}

/**
 * Show an automation on another calendar, or (null) on none; undefined is
 * "Default calendar (new)" ({@link calendarIdForPick}). Undo puts it back where
 * it was, none included; a calendar the move made stays. A calendar or
 * automation deleted meanwhile is said in words.
 */
export async function moveAutomationToCalendar(
  a: AutomationRecord,
  pick: string | null | undefined,
  offer: OfferUndo = toastUndo
): Promise<AutomationRecord> {
  const calendarId = await calendarIdForPick(pick);
  const automation = await updateCalendar(a, calendarId);
  const message =
    calendarId === null
      ? `Removed ${a.name} from the calendar`
      : `Moved ${a.name} to ${automation.calendarTitle ?? 'another calendar'}`;
  const back = a.calendarId;
  offer(message, async () => {
    await updateCalendar(a, back);
  });
  return automation;
}

/** Wake the agent now; says how it went (a skip names why). */
export async function runAutomationNow(a: AutomationRecord): Promise<AutomationRecord> {
  const { automation, run } = await automationsApi.runNow(a.id);
  if (run.status === 'skipped') showToast(`Not run: ${run.error ?? 'skipped'}`);
  else if (run.status === 'failed') showToast(`Couldn't run ${a.name}: ${run.error ?? 'failed'}`);
  else showToast(`Woke ${a.agentName ?? 'the agent'}`);
  return automation;
}

/** "Wed, Oct 14, 9:00 AM" in the viewer's zone. */
export function formatAutomationTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * The next run in the viewer's zone. A first-open automation has no fixed
 * time, so it reads "When Snaglet first opens, from Tue, Nov 3, 5:00 AM" (the
 * earliest it may run).
 */
export function formatAutomationNextRun(a: AutomationRecord): string {
  if (a.when.kind === 'first_open' && a.nextRunAt) {
    return `When Snaglet first opens, from ${formatAutomationTime(a.nextRunAt)}`;
  }
  return formatAutomationTime(a.nextRunAt);
}

export function automationStatusText(a: AutomationRecord): string {
  switch (a.status) {
    case 'active':
      return 'Active';
    case 'paused':
      return a.pausedReason === 'failures' ? 'Paused after failures' : 'Paused';
    case 'finished':
      return 'Finished';
    case 'cancelled':
      return 'Archived';
  }
}

export function lastResultText(a: AutomationRecord): string {
  const run = a.lastRun;
  if (!run) return '—';
  if (run.status === 'succeeded') return 'Ran';
  if (run.status === 'running') return 'Running';
  if (run.status === 'failed') return `Failed${run.error ? `: ${run.error}` : ''}`;
  return `Skipped${run.error ? `: ${run.error}` : ''}`;
}
