/**
 * Automations wire contract: scheduled agent wakes.
 * One row per wake an agent or a person scheduled; each
 * non-canceled row owns one `schedules` row that fires it, and a deleted
 * one keeps it (disabled) with its runs.
 *
 * Routes (all under /api/automations, JSON, the usual { ok, data } envelope;
 * writes need the panel token, so only people reach them):
 *
 *   GET    /                      ?status=active|paused|finished|canceled|all → AutomationsResponse
 *   GET    /:id                   → AutomationResponse
 *   POST   /                      CreateAutomationRequest → AutomationResponse (201)
 *   PATCH  /:id                   UpdateAutomationRequest → AutomationResponse
 *   POST   /:id/pause             → AutomationPauseResponse
 *   POST   /:id/pause/undo        UndoAutomationPauseRequest → AutomationResponse
 *                                 (409 once it changed, ran or expired, or at the active limit;
 *                                 403 for another member)
 *   POST   /:id/resume            → AutomationResumeResponse
 *   POST   /:id/resume/undo       UndoAutomationResumeRequest → AutomationResponse
 *                                 (409 once it changed, ran or expired; 403 for another member)
 *   POST   /:id/run               → AutomationRunNowResponse (wakes the agent now)
 *   DELETE /:id                   → AutomationResponse (status canceled; undo = resume)
 *   POST   /:id/restore           → AutomationResponse (a deleted one back as it was;
 *                                 any other unchanged)
 *   DELETE /:id/purge             → AutomationResponse, as it was (a deleted one for good,
 *                                 its kept schedule and runs too; 409 for any other)
 *   GET    /:id/runs              ?limit=1–100 (50)&before=<nextCursor> → AutomationRunsResponse
 *   GET    /runs/recent           ?limit=1–100 (20) → AutomationRecentRunsResponse
 *
 * Agents use the `automation` tool instead (same service, agent rules).
 *
 * A deleted (canceled) automation is an archived one: GET /api/archive lists
 * it (`type: 'automation'`, kept until deleted, `archived_at` = its
 * `updatedAt`), and the Archive drawer restores and deletes it through the
 * two routes above. Dragging a row of the Automations view onto the sidebar's
 * trash deletes it (DELETE /:id).
 *
 * Realtime: `automations:changed` ({@link AutomationsChangedEvent}) on the
 * workspace channel after every write and run, including when a wake starts
 * and when it settles (so `running` can be re-read); the calendar also gets
 * `calendar:changed` with kind 'automation'.
 */
import type { ScheduleRunStatus } from './schedules';
import type { UnattendedPolicy } from './tool-confirmation';

export type AutomationStatus = 'active' | 'paused' | 'finished' | 'cancelled';
export type AutomationWhenKind = 'once' | 'repeat' | 'interval' | 'first_open';
/** Why a paused automation is paused. */
export type AutomationPausedReason = 'user' | 'agent' | 'failures';

export const AUTOMATION_STATUSES: readonly AutomationStatus[] = [
  'active',
  'paused',
  'finished',
  'cancelled',
];
export const AUTOMATION_NAME_MAX_LENGTH = 80;
export const AUTOMATION_PROMPT_MAX_LENGTH = 4000;
/** A first-open automation's earliest time when `after` is left out (HH:mm in its zone). */
export const AUTOMATION_FIRST_OPEN_DEFAULT_AFTER = '05:00';
/** The Database catalog id of the builtin Automations table. */
export const AUTOMATIONS_TABLE_ID = 'table-builtin-automations';

/**
 * When to wake, as an agent or person writes it: exactly one of `in`, `at`,
 * `repeat` (which takes its time in `at`), `every` (which may also take `at`)
 * or `first_open` (which may take `after`). `tz` (IANA) defaults to the
 * user's zone.
 *
 * - `{in: "30m" | "2h" | "1d"}`: once, that long from now.
 * - `{at: "2026-10-14T09:00"}`: once, at that local time.
 * - `{repeat: "FREQ=WEEKLY;BYDAY=MO", at: "09:00", starts?: "2026-10-14"}`.
 * - `{every: "15m" | "2h"}`: an interval; on the calendar as a line down each day.
 * - `{every: "15m", at: "2026-10-14T09:07"}`: an interval anchored at `at`
 *   (runs at :07, :22, :37, :52); a future anchor is the first run.
 * - `{every: "5m", window_start: "05:05", window_end: "06:00"}`: an interval
 *   that runs only inside that daily window, wall-clock in `tz`: at
 *   window_start, then every `every`, up to and including window_end. A window
 *   may cross midnight ("22:00" to "02:00"). Not with `at`.
 * - `{first_open: true, after?: "05:00"}`: once a local day, the first time
 *   Snaglet is running and the machine is awake at or after `after` (default
 *   05:00) in `tz`; a day Snaglet is not open is skipped, never caught up.
 */
export interface AutomationWhenInput {
  in?: string;
  at?: string;
  repeat?: string;
  starts?: string;
  every?: string;
  /** every: the daily window's start, HH:mm in `tz` (with `window_end`). */
  window_start?: string;
  /** every: the daily window's end, HH:mm in `tz`, inclusive (with `window_start`). */
  window_end?: string;
  /** Once a day, when Snaglet first opens (`true`; nothing else). */
  first_open?: boolean;
  /** first_open: the earliest time it may run each day, HH:mm in `tz` (default 05:00). */
  after?: string;
  tz?: string;
}

/**
 * Normalized timing, as stored. `once.at` is an ISO instant. `interval.anchor`
 * (ISO instant) is set only by a fresh `{every, at}`; the stored anchor lives
 * on the owned schedule. `interval.windowStart` / `windowEnd` (HH:mm in `tz`,
 * both or neither) keep an interval to that daily window; its runs then start
 * at `windowStart` each day and the anchor plays no part. `first_open.after`
 * (HH:mm in `tz`) is the earliest a first-open wake may run each day.
 */
export type AutomationWhen =
  | { kind: 'once'; at: string; tz: string }
  | { kind: 'repeat'; rrule: string; timeOfDay: string; startsOn: string; tz: string }
  | {
      kind: 'interval';
      everyMs: number;
      tz: string;
      anchor?: string;
      windowStart?: string;
      windowEnd?: string;
    }
  | { kind: 'first_open'; after: string; tz: string };

export interface AutomationLastRun {
  status: ScheduleRunStatus;
  scheduledFor: string;
  finishedAt: string | null;
  error: string | null;
}

export interface AutomationRecord {
  id: string;
  name: string;
  prompt: string;
  status: AutomationStatus;
  when: AutomationWhen;
  /** The timing in words (`describeAutomationWhen`), e.g. "every weekday at 9:00 AM". */
  whenText: string;
  /** The calendar it shows on; null = none. */
  calendarId: string | null;
  threadId: string;
  agentId: string;
  scheduleId: string | null;
  /** The agent that created it; null when a person did. */
  createdByAgentId: string | null;
  createdByMemberId: string | null;
  consecutiveFailures: number;
  pausedReason: AutomationPausedReason | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The next wake; null when paused, finished or canceled. A first-open one
   * has no fixed time: this is the earliest it may run (its next `after`),
   * and it runs when Snaglet is first open and awake from then on.
   */
  nextRunAt: string | null;
  lastRun: AutomationLastRun | null;
  agentName: string | null;
  threadTitle: string | null;
  calendarTitle: string | null;
  /** A wake is going right now (posted, and the agent's run has not settled). */
  running: boolean;
  /** When the current wake started; null when none is running. */
  runningSince: string | null;
  /**
   * What its runs do with a tool call that would ask a person to confirm
   * (nobody is there): skip it, or run it when the agent's tool access
   * already allows it. Only people set it; see {@link UnattendedPolicy}.
   */
  unattendedPolicy: UnattendedPolicy;
}

export interface AutomationsResponse {
  automations: AutomationRecord[];
}

export interface AutomationResponse {
  automation: AutomationRecord;
}

/**
 * POST /api/automations: a person schedules `agentId` to wake in `threadId`
 * (the agent must be in that thread).
 */
export interface CreateAutomationRequest {
  name: string;
  prompt: string;
  when: AutomationWhenInput;
  threadId: string;
  agentId: string;
  /** Omitted = the Default calendar, null = no calendar. */
  calendarId?: string | null;
  /** Omitted = `skip`. */
  unattendedPolicy?: UnattendedPolicy;
}

/** PATCH /api/automations/:id. Omitted fields stay as they are. */
export interface UpdateAutomationRequest {
  name?: string;
  prompt?: string;
  when?: AutomationWhenInput;
  /** null = no calendar. Omitted keeps the calendar (none included), whatever the timing. */
  calendarId?: string | null;
  unattendedPolicy?: UnattendedPolicy;
}

/**
 * POST /api/automations/:id/resume. `undoToken` is set only when the resume
 * cleared a pause (not for one already active, a finished one or a restored
 * delete): POST /:id/resume/undo with it puts the pause back with its reason
 * and failure streak. Single use, held in server memory for 30 minutes, and
 * only for the member who resumed.
 */
export interface AutomationResumeResponse {
  automation: AutomationRecord;
  undoToken: string | null;
}

/** POST /api/automations/:id/resume/undo. */
export interface UndoAutomationResumeRequest {
  token: string;
}

/**
 * POST /api/automations/:id/pause. `undoToken` is set only when the pause
 * paused an active automation (not for one already paused or finished):
 * POST /:id/pause/undo with it resumes it with the failure streak it had,
 * where a plain resume starts a fresh one. Single use, held in server memory
 * for 30 minutes, and only for the member who paused. A resume's token and
 * a pause's can't stand in for each other.
 */
export interface AutomationPauseResponse {
  automation: AutomationRecord;
  undoToken: string | null;
}

/** POST /api/automations/:id/pause/undo. */
export interface UndoAutomationPauseRequest {
  token: string;
}

/**
 * `error.details` of the 409 a create, resume (an undo of a pause too) or
 * reopening gets when the agent already has its most active automations
 * (setting `automations.max_active_per_agent`).
 */
export interface AutomationActiveLimitDetails {
  reason: 'active_limit';
  /** The agent's active automations now. */
  active: number;
  /** The most it may have. */
  max: number;
}

/** POST /api/automations/:id/run: the automation and the wake it just logged. */
export interface AutomationRunNowResponse {
  automation: AutomationRecord;
  run: { status: ScheduleRunStatus; error: string | null };
}

/** One wake in an automation's run log (a schedule run), as stored. */
export interface AutomationRunRecord {
  id: string;
  /** When the wake was due (a Run now: when it was pressed). */
  scheduledFor: string;
  startedAt: string;
  /** null while it is running. */
  finishedAt: string | null;
  status: ScheduleRunStatus;
  /** Why it failed, or why it was skipped. */
  error: string | null;
  /** A Run now started it (a person's or an agent's), recorded when the run was claimed. */
  manual: boolean;
}

/**
 * GET /api/automations/:id/runs: newest first (by start). `nextCursor` is
 * the `before` for the next, older page; null on the last page. Deleted
 * automations keep their runs. An automation with no schedule run at all
 * lists the wakes it posted in its thread instead (each reads as `succeeded`).
 */
export interface AutomationRunsResponse {
  runs: AutomationRunRecord[];
  nextCursor: string | null;
}

/** One run in the recent-runs log, with the automation it belongs to. */
export interface AutomationRecentRun extends AutomationRunRecord {
  automationId: string;
  automationName: string;
}

/**
 * GET /api/automations/runs/recent: the newest schedule runs of every
 * automation that is not deleted, newest first by start, in one read.
 * Wakes an automation posted without a schedule run (its schedule was lost)
 * are not listed here; its own run log shows them.
 */
export interface AutomationRecentRunsResponse {
  runs: AutomationRecentRun[];
}

export interface AutomationsChangedEvent {
  automationId?: string;
}

/**
 * What started a run, when something other than a message did. Carried from
 * the dispatch input onto every turn of that dispatch in the same thread and
 * into the tool context: an automated run may not create or change
 * automations. A tool call that would ask for a confirmation follows the
 * automation's `unattendedPolicy` (see UnattendedWake).
 */
export interface WakeOrigin {
  kind: 'automation';
  automationId: string;
  /**
   * An agent started this wake (its Run now). Such a run is capped at the
   * `skip` policy whatever the automation's own setting.
   */
  agentStarted?: true;
}
