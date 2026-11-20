import type { AutomationPausedReason } from './automations';

export type ScheduleKind = 'once' | 'interval' | 'calendar' | 'rrule' | 'first_open';
/** A defineHook({ schedule }) run, or an automation's wake. */
export type ScheduleActionKind = 'hook' | 'automation';
export type ScheduleRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface OnceScheduleConfig {
  at: string;
}

export interface IntervalScheduleConfig {
  every: number;
  unit: 'minute' | 'hour' | 'day' | 'week';
  anchor?: string;
  /**
   * A daily window, HH:mm wall-clock in the schedule's zone (both or
   * neither): runs fall at `windowStart`, then every interval, up to and
   * including `windowEnd` (an end before the start crosses midnight); the
   * anchor is not used.
   */
  windowStart?: string;
  windowEnd?: string;
}

export interface CalendarScheduleConfig {
  /** Local wall-clock time, HH:mm. */
  time: string;
  /** ISO weekdays, Monday=1 through Sunday=7. Empty means every day. */
  weekdays?: number[];
}

/**
 * An RRULE series: `rrule` (a normalized body, no DTSTART/TZID) from
 * `startsOn` at wall-clock `time` in the schedule's zone. Next runs come from
 * the shared tableRecurrence engine.
 */
export interface RruleScheduleConfig {
  rrule: string;
  /** Local wall-clock time, HH:mm. */
  time: string;
  /** YYYY-MM-DD; the series starts at its first match on or after this day. */
  startsOn: string;
}

/**
 * Once a local day when Snaglet first opens: due from `after` (HH:mm in the
 * schedule's zone) each day, it runs at the first scheduler tick from then on
 * (Snaglet running, the machine awake), once that day. A day Snaglet was not open is
 * not caught up.
 */
export interface FirstOpenScheduleConfig {
  /** Local wall-clock time, HH:mm: the earliest it runs each day. */
  after: string;
}

export type ScheduleConfig =
  | OnceScheduleConfig
  | IntervalScheduleConfig
  | CalendarScheduleConfig
  | RruleScheduleConfig
  | FirstOpenScheduleConfig;

export interface HookScheduleAction {
  hookName: string;
  source?: 'hook-definition';
  event?: Record<string, unknown>;
  agentId?: string;
  threadId?: string;
}

/** Fires an automation; the prompt, thread and agent are read from its row at fire time. */
export interface AutomationScheduleAction {
  automationId: string;
  /**
   * While its automation is deleted: why it was paused, so a restore puts it
   * back paused (a deleted row cannot hold `paused_reason` itself).
   */
  pausedReason?: AutomationPausedReason;
}

export type ScheduleAction = HookScheduleAction | AutomationScheduleAction;

export interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  schedule: ScheduleConfig;
  timezone: string;
  actionKind: ScheduleActionKind;
  action: ScheduleAction;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduleRunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRunRecord {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  status: ScheduleRunStatus;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SaveScheduleInput {
  name: string;
  scheduleKind: ScheduleKind;
  schedule: ScheduleConfig;
  timezone: string;
  actionKind: ScheduleActionKind;
  action: ScheduleAction;
}
