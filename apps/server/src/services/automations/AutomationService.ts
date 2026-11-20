/**
 * AutomationService — scheduled agent wakes; the only writer of
 * `public.automations` and their owned `schedules` rows (changed together in
 * one transaction; `reconcile()` repairs drift at boot). ScheduleService owns
 * timing and claiming, then calls {@link AutomationServiceClass.fire}.
 * Guardrails: agents act only in their own thread, on automations they
 * created, never from an automated run; interval floors (agents 15 min, or 5
 * with a daily window of at most 2 h; people 1 min); active, create and Run-now
 * caps; auto-pause after repeated failures. Limits: settings `automations.*`.
 */
import { randomUUID } from 'node:crypto';
import { getDb, transaction, type DbQueryable } from '@snaglet/db/db';
import { Agents } from '@snaglet/db/tables/agents';
import {
  Automations,
  automationWhen,
  type AutomationListRow,
  type AutomationRow,
} from '@snaglet/db/tables/automations';
import { Calendars, mapCalendarForeignKeyError } from '@snaglet/db/tables/calendars';
import { Messages } from '@snaglet/db/tables/messages';
import { Reminders } from '@snaglet/db/tables/reminders';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import {
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  ErrorCode,
  HTTP_STATUS,
  type AutomationActiveLimitDetails,
  type AutomationPausedReason,
  type AutomationPauseResponse,
  type AutomationRecord,
  type AutomationResumeResponse,
  type AutomationRunNowResponse,
  type AutomationRecentRunsResponse,
  type AutomationRunsResponse,
  type AutomationStatus,
  type AutomationWhen,
  type IntervalScheduleConfig,
  type UnattendedPolicy,
  type WakeOrigin,
  UNATTENDED_POLICIES,
  isUnattendedPolicy,
} from '@snaglet/shared/types';
import {
  AUTOMATION_HUMAN_MIN_EVERY_MS,
  AppError,
  automationFloorError,
  describeAutomationWhen,
  formatAutomationInstant,
  generateId,
  getErrorMessage,
  isoNow,
  nextAutomationRun,
  normalizeAutomationWhen,
  userTimeZone,
} from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  ensureDefaultCalendar,
  PendingCalendarChanges,
} from '@server/domains/calendar/calendarService';
import { resolveCurrentActorMemberId } from '@server/realtime/actorMember';
import { getCurrentActor } from '@server/realtime/actorContext';
import { currentUnattendedCap, runCappedUnattended } from '@server/realtime/runContext';
import { emitAutomationsChanged } from '@server/realtime/surfaces/automations';
import { emitCalendarChanged } from '@server/realtime/surfaces/calendar';
import { emitRemindersChanged } from '@server/realtime/surfaces/reminders';
import { hooks } from '@server/services/HookService';
import {
  PREVIOUS_RUN_GOING,
  ScheduleRunSkipped,
  scheduleService,
  type OwnedScheduleInput,
} from '@server/services/ScheduleService';
import { settingsService } from '@server/services/settings';
import { automationSettings } from '@server/services/settings/categories/automations';
import { wsService } from '@server/services/WebSocketService';
import {
  noticeAutoPaused,
  noticeChanged,
  noticeMissed,
  noticeScheduled,
} from './automationNotices';

/** Who is asking. Agents get the agent rules; people (UI, panel, CLI) set any thread and agent. */
export type AutomationActor =
  | {
      kind: 'agent';
      agentId: string;
      /** The thread the calling run is in. */
      threadId: string | null;
      /** The calling run, for the per-run creation cap. */
      runId: string | null;
      /** Set when an automation started the calling run: no writes then. */
      wakeOrigin?: WakeOrigin;
    }
  | {
      kind: 'person';
      /**
       * An external MCP client's member: a person to the
       * thread and agent rules, but held to the agent limits on Run now
       * and on the Every floor, as an unattended caller.
       */
      external?: boolean;
    };

/** Whether `actor` is held to the agent limits (Run now per hour, the Every floor). */
function usesAgentLimits(actor: AutomationActor): boolean {
  return actor.kind === 'agent' || actor.external === true;
}

/** Only a person in the app (not an agent, not an external client) can undo a resume or a pause. */
function undoesStatusChanges(actor: AutomationActor): boolean {
  return actor.kind === 'person' && actor.external !== true;
}

/**
 * The unattended policy a write asks for, or undefined when it names none.
 * Only a person in the app may set it: it decides whether a run nobody
 * watches may skip the "ask first" prompt, so neither the agent the
 * automation wakes nor an external client may loosen it.
 */
function requestedUnattendedPolicy(
  raw: unknown,
  actor: AutomationActor
): UnattendedPolicy | undefined {
  if (raw === undefined) return undefined;
  if (actor.kind !== 'person' || actor.external === true) {
    throw forbidden('Only a person in Snaglet can change what an unattended run does.');
  }
  if (!isUnattendedPolicy(raw)) {
    throw bad(`unattendedPolicy must be one of: ${UNATTENDED_POLICIES.join(', ')}.`);
  }
  return raw;
}

interface CreateAutomationInput {
  name: unknown;
  prompt: unknown;
  when: unknown;
  /** Omitted = the Default calendar, null = none. */
  calendarId?: unknown;
  threadId: unknown;
  agentId: unknown;
  /** Omitted = `skip`. People in the app only. */
  unattendedPolicy?: unknown;
}

interface UpdateAutomationInput {
  name?: unknown;
  prompt?: unknown;
  when?: unknown;
  /** Omitted = keep the calendar, null = none. */
  calendarId?: unknown;
  /** Omitted = keep it. People in the app only. */
  unattendedPolicy?: unknown;
}

interface AutomationLimits {
  maxActivePerAgent: number;
  maxCreatedPerRun: number;
  agentMinEveryMs: number;
  missedGraceMs: number;
  failuresBeforePause: number;
  /** An agent's Run nows per automation in an hour (people: no limit). */
  agentRunsPerHour: number;
}

interface FireContext {
  scheduleRunId: string;
  scheduledFor: Date;
  /** Run now (a person's click): fires a paused automation too. */
  manual: boolean;
}

type WakeOutcome = { kind: 'success' } | { kind: 'failure'; error: string } | { kind: 'neutral' };

/** The pause a resume cleared: what its undo puts back. */
interface ClearedPause {
  kind: 'resume';
  pausedReason: AutomationPausedReason | null;
  consecutiveFailures: number;
  /** The resumed row's updated_at, to the microsecond. */
  changedUpdatedAt: string;
}

/** The failure streak a pause kept: what its undo resumes with. */
interface KeptStreak {
  kind: 'pause';
  consecutiveFailures: number;
  /** The paused row's updated_at, to the microsecond. */
  changedUpdatedAt: string;
}

/** A status change an undo can take back. */
type StatusChange = ClearedPause | KeptStreak;

/** A resume's or a pause's undo, held in memory until used or expired. */
type StatusUndo = StatusChange & {
  automationId: string;
  /** Who made the change: only they can undo it (no member, no token). */
  memberId: string;
  expiresAt: number;
};

/** Whether `undo` is a held undo of `kind` (a resume's token never undoes a pause, and back). */
function isUndoOf<K extends StatusUndo['kind']>(
  undo: StatusUndo,
  kind: K
): undo is Extract<StatusUndo, { kind: K }> {
  return undo.kind === kind;
}

/** How long a resume or a pause stays undoable. */
const UNDO_TTL_MS = 30 * 60_000;
/** At most this many undoable changes are held (both kinds); the oldest goes first. */
const UNDO_MAX = 200;
const UNDO_REFUSALS = {
  resume: {
    expired: "Can't undo the resume: the undo expired.",
    changed: "Can't undo the resume: the automation changed since it was resumed.",
    notPerson: 'Only a person in the app can undo a resume.',
    notYours: 'Only the person who resumed it can undo the resume.',
  },
  pause: {
    expired: "Can't undo the pause: the undo expired.",
    changed: "Can't undo the pause: the automation changed since it was paused.",
    notPerson: 'Only a person in the app can undo a pause.',
    notYours: 'Only the person who paused it can undo the pause.',
  },
} as const satisfies Record<StatusUndo['kind'], Record<string, string>>;

export const AUTOMATED_RUN_REFUSAL =
  "Automations can't be created or changed from a run an automation started.";

/** A test wake cannot start another one. */
export const AUTOMATED_RUN_NOW_REFUSAL =
  "Automations can't be run from a run an automation started.";

/** The window of the agents' Run now limit. */
const AGENT_RUN_WINDOW_MS = 3_600_000;

const bad = (message: string) =>
  new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
const notFound = (message: string) =>
  new AppError(message, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError(message, ErrorCode.CONFLICT, HTTP_STATUS.CONFLICT, true, details);
const forbidden = (message: string) =>
  new AppError(message, ErrorCode.FORBIDDEN, HTTP_STATUS.FORBIDDEN);

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw bad(`${field} must be 1–${max} characters.`);
  }
  if (value.includes('\0')) throw bad(`${field} cannot contain null characters.`);
  return value.trim();
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw bad(`${field} is required.`);
  return value.trim();
}

/** A failed run row that a person stopped (Stop) is neither a success nor a failure. */
function stoppedByPerson(error: string | null): boolean {
  if (!error?.startsWith('Aborted by ')) return false;
  const by = error.slice('Aborted by '.length).trim();
  return !['timeout', 'watchdog', 'system'].includes(by);
}

const RUN_CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A run log page cursor: the last row's start (full precision) and id, opaque to clients. */
function encodeRunCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

function decodeRunCursor(cursor: string): { at: string; id: string } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = text.indexOf('|');
  const at = text.slice(0, bar);
  const id = text.slice(bar + 1);
  if (bar < 0 || !RUN_CURSOR_AT_RE.test(at) || !id) {
    throw bad('before must be the nextCursor of a previous page.');
  }
  return { at, id };
}

/** `IntervalScheduleConfig` for an interval, in the largest whole unit, with its window if any. */
function intervalConfig(
  when: Extract<AutomationWhen, { kind: 'interval' }>,
  anchor: Date
): IntervalScheduleConfig {
  const units = [
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ] as const;
  const [unit, ms] = units.find(([, size]) => when.everyMs % size === 0) ?? ['minute', 60_000];
  return {
    every: Math.max(1, Math.round(when.everyMs / ms)),
    unit,
    anchor: anchor.toISOString(),
    ...(when.windowStart && when.windowEnd
      ? { windowStart: when.windowStart, windowEnd: when.windowEnd }
      : {}),
  };
}

/** Where an interval's runs line up: its `{every, at}` anchor, else now. */
function intervalAnchor(when: AutomationWhen): Date {
  return when.kind === 'interval' && when.anchor ? new Date(when.anchor) : new Date();
}

class AutomationServiceClass {
  /** Automations whose last wake is still being dispatched (overlap guard). */
  private readonly liveWakes = new Map<string, { since: number }>();
  /**
   * When agents' Run nows started in the last hour, per automation (the
   * per-hour limit). In memory: a restart starts a fresh hour.
   */
  private readonly agentRunNows = new Map<string, number[]>();
  /**
   * Undoable resumes and pauses by token (single use, {@link UNDO_TTL_MS},
   * at most {@link UNDO_MAX}). In memory: a restart drops them, and the
   * app's Undo falls back to a plain pause or resume.
   */
  private readonly statusUndos = new Map<string, StatusUndo>();

  async limits(): Promise<AutomationLimits> {
    const [maxActive, maxPerRun, minMinutes, graceMinutes, failures, runsPerHour] =
      await Promise.all([
        settingsService.read(automationSettings.maxActivePerAgent),
        settingsService.read(automationSettings.maxCreatedPerRun),
        settingsService.read(automationSettings.agentMinIntervalMinutes),
        settingsService.read(automationSettings.missedRunGraceMinutes),
        settingsService.read(automationSettings.failuresBeforePause),
        settingsService.read(automationSettings.agentRunsPerHour),
      ]);
    return {
      maxActivePerAgent: maxActive,
      maxCreatedPerRun: maxPerRun,
      agentMinEveryMs: minMinutes * 60_000,
      missedGraceMs: graceMinutes * 60_000,
      failuresBeforePause: failures,
      agentRunsPerHour: runsPerHour,
    };
  }

  async missedGraceMs(): Promise<number> {
    return (await this.limits()).missedGraceMs;
  }

  /** True while the automation's previous wake is still being dispatched. */
  isWakeLive(automationId: string): boolean {
    return this.liveWakes.has(automationId);
  }

  // Reads

  toRecord(row: AutomationListRow): AutomationRecord {
    const stored = automationWhen(row);
    const when: AutomationWhen =
      stored.kind === 'interval' && row.anchor ? { ...stored, anchor: row.anchor } : stored;
    const live = this.liveWakes.get(row.id);
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      status: row.status,
      when,
      whenText: describeAutomationWhen(when, userTimeZone()),
      calendarId: row.calendarId,
      threadId: row.threadId,
      agentId: row.agentId,
      scheduleId: row.scheduleId,
      createdByAgentId: row.createdByAgentId,
      createdByMemberId: row.createdByMemberId,
      consecutiveFailures: row.consecutiveFailures,
      pausedReason: row.pausedReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      nextRunAt: row.status === 'active' ? row.nextRunAt : null,
      lastRun: row.lastRun,
      agentName: row.agentName,
      threadTitle: row.threadTitle,
      calendarTitle: row.calendarTitle,
      running: live !== undefined,
      runningSince: live ? new Date(live.since).toISOString() : null,
      unattendedPolicy: row.unattendedPolicy,
    };
  }

  async list(
    options: {
      status?: AutomationStatus | 'all';
      agentId?: string;
      createdByAgentId?: string;
    } = {}
  ): Promise<AutomationRecord[]> {
    const status = options.status ?? 'all';
    const rows = await Automations.list({
      ...(status === 'all' ? {} : { statuses: [status] }),
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.createdByAgentId ? { createdByAgentId: options.createdByAgentId } : {}),
    });
    return rows.map((row) => this.toRecord(row));
  }

  async get(automationId: string): Promise<AutomationRecord> {
    const [row] = await Automations.list({ ids: [automationId] });
    if (!row) throw notFound(`Automation ${automationId} not found.`);
    return this.toRecord(row);
  }

  /**
   * One page of the automation's run log, newest first; deleted automations
   * keep theirs. `before` is a previous page's `nextCursor`.
   */
  async runs(
    automationId: string,
    options: { limit: number; before: string | null }
  ): Promise<AutomationRunsResponse> {
    if (!(await Automations.findById(automationId))) {
      throw notFound(`Automation ${automationId} not found.`);
    }
    const before = options.before ? decodeRunCursor(options.before) : null;
    const rows = await Automations.listRuns(automationId, { limit: options.limit + 1, before });
    const page = rows.slice(0, options.limit);
    const last = page[page.length - 1];
    return {
      runs: page.map((row) => ({
        id: row.id,
        scheduledFor: row.scheduledFor,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        status: row.status,
        error: row.error,
        manual: row.manual,
      })),
      nextCursor:
        rows.length > options.limit && last ? encodeRunCursor(last.cursorAt, last.id) : null,
    };
  }

  /**
   * The newest schedule runs across every automation that is not deleted,
   * newest first by start: one read for the Automations view's run log.
   */
  async recentRuns(limit: number): Promise<AutomationRecentRunsResponse> {
    const iso = (column: string) =>
      `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const { rows } = await getDb().query<{
      id: string;
      automation_id: string;
      automation_name: string;
      scheduled_for: string;
      started_at: string;
      finished_at: string | null;
      status: AutomationRecentRunsResponse['runs'][number]['status'];
      error: string | null;
      manual: boolean;
    }>(
      `SELECT r.id, a.id AS automation_id, a.name AS automation_name,
              ${iso('r.scheduled_for')} AS scheduled_for, ${iso('r.started_at')} AS started_at,
              ${iso('r.finished_at')} AS finished_at, r.status, r.error, r.manual
         FROM public.schedule_runs r
         JOIN public.schedules s ON s.id = r.schedule_id AND s.action_kind = 'automation'
         JOIN public.automations a ON a.id = s.action_json->>'automationId'
        WHERE a.status <> 'cancelled'
        ORDER BY r.started_at DESC, r.id DESC
        LIMIT $1`,
      [limit]
    );
    return {
      runs: rows.map((row) => ({
        id: row.id,
        automationId: row.automation_id,
        automationName: row.automation_name,
        scheduledFor: row.scheduled_for,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        error: row.error,
        manual: row.manual,
      })),
    };
  }

  // Writes

  private refuseAutomated(actor: AutomationActor): void {
    if (actor.kind === 'agent' && actor.wakeOrigin) throw forbidden(AUTOMATED_RUN_REFUSAL);
  }

  private assertCanChange(row: AutomationRow, actor: AutomationActor): void {
    this.refuseAutomated(actor);
    if (actor.kind === 'agent' && row.createdByAgentId !== actor.agentId) {
      throw forbidden('You can only change automations you created.');
    }
  }

  /**
   * An agent or external client may not bring back an interval under its
   * floor: a removed daily window or a raised floor can leave a paused one too
   * short (a 5-minute wake without its window would run all day). People
   * may; their floor is the schedules' own.
   */
  private assertFloor(row: AutomationRow, actor: AutomationActor, limits: AutomationLimits): void {
    if (!usesAgentLimits(actor)) return;
    const error = automationFloorError(automationWhen(row), {
      minEveryMs: limits.agentMinEveryMs,
      agentMinEveryMs: limits.agentMinEveryMs,
    });
    if (error) throw bad(`${error} Change its timing (update when) to enable it.`);
  }

  private normalizeWhen(raw: unknown, actor: AutomationActor, limits: AutomationLimits) {
    const result = normalizeAutomationWhen(raw, {
      now: new Date(),
      defaultTz: userTimeZone(),
      minEveryMs: usesAgentLimits(actor) ? limits.agentMinEveryMs : AUTOMATION_HUMAN_MIN_EVERY_MS,
      agentMinEveryMs: limits.agentMinEveryMs,
    });
    if (!result.ok) throw bad(result.error);
    return result.value;
  }

  /**
   * The calendar an automation shows on, whatever its timing. `requested` is
   * a calendar's id, null for none, or undefined to keep `kept` (the
   * row's choice, none included, also across a timing change); with nothing
   * to keep (a create) or a kept calendar that no longer exists, the Default
   * one (a new Default calendar goes on `calendarChanges`, emitted after commit).
   */
  private async resolveCalendar(
    tx: DbQueryable,
    requested: unknown,
    kept: { calendarId: string | null } | null,
    calendarChanges: PendingCalendarChanges
  ): Promise<string | null> {
    if (requested === null) return null;
    if (typeof requested === 'string' && requested.trim()) {
      const calendar = await Calendars.findById(requested.trim(), tx);
      if (!calendar) {
        throw notFound(`Calendar ${requested.trim()} not found.`);
      }
      return calendar.id;
    }
    if (requested !== undefined) {
      throw bad('calendar_id must be a calendar id, or null for no calendar.');
    }
    if (kept) {
      if (kept.calendarId === null) return null;
      const calendar = await Calendars.findById(kept.calendarId, tx);
      if (calendar) return calendar.id;
    }
    return (await ensureDefaultCalendar(tx, calendarChanges)).id;
  }

  private async checkQuota(
    tx: DbQueryable,
    agentId: string,
    actor: AutomationActor,
    limits: AutomationLimits
  ): Promise<void> {
    if (!(await Automations.lockAgent(agentId, tx))) throw notFound(`Agent ${agentId} not found.`);
    const active = await Automations.countActiveForAgent(agentId, tx);
    if (active >= limits.maxActivePerAgent) {
      const details = {
        reason: 'active_limit',
        active,
        max: limits.maxActivePerAgent,
      } satisfies AutomationActiveLimitDetails;
      if (actor.kind === 'agent') {
        throw conflict(
          `You already have ${limits.maxActivePerAgent} active automations. Pause or cancel one first.`,
          details
        );
      }
      const agent = await Agents.findById(agentId);
      throw conflict(
        `${agent?.name ?? 'That agent'} already has ${limits.maxActivePerAgent} active automations. Pause or cancel one first.`,
        details
      );
    }
  }

  /** The owned schedule for a row (interval anchor: when its timing was set). */
  private ownedSchedule(row: AutomationRow, anchor: Date): OwnedScheduleInput {
    const when = automationWhen(row);
    const base = {
      id: row.scheduleId!,
      name: `Automation: ${row.name}`,
      enabled: row.status === 'active',
      timezone: row.tz,
      automationId: row.id,
    };
    if (when.kind === 'once') {
      return {
        ...base,
        scheduleKind: 'once',
        schedule: { at: when.at },
        nextRunAt: new Date(when.at),
      };
    }
    if (when.kind === 'repeat') {
      return {
        ...base,
        scheduleKind: 'rrule',
        schedule: { rrule: when.rrule, time: when.timeOfDay, startsOn: when.startsOn },
        nextRunAt: nextAutomationRun(when, new Date()),
      };
    }
    if (when.kind === 'first_open') {
      // Due from its next `after`; the scheduler runs it at the first tick
      // from then on (Snaglet open, the machine awake), once that day.
      return {
        ...base,
        scheduleKind: 'first_open',
        schedule: { after: when.after },
        nextRunAt: nextAutomationRun(when, new Date()),
      };
    }
    return {
      ...base,
      scheduleKind: 'interval',
      schedule: intervalConfig(when, anchor),
      nextRunAt: nextAutomationRun(when, new Date(), anchor),
    };
  }

  /** The anchor an existing interval schedule keeps when its timing is unchanged. */
  private async currentAnchor(tx: DbQueryable, scheduleId: string | null): Promise<Date> {
    if (!scheduleId) return new Date();
    const { rows } = await tx.query<{ anchor: string | null }>(
      `SELECT schedule_json->>'anchor' AS anchor FROM schedules WHERE id = $1`,
      [scheduleId]
    );
    const anchor = rows[0]?.anchor ? new Date(rows[0].anchor) : null;
    return anchor && !Number.isNaN(anchor.getTime()) ? anchor : new Date();
  }

  /**
   * Write the row's owned schedule. A row without one gets a new schedule
   * first and is linked to it after (the link is a foreign key).
   */
  private async syncSchedule(
    tx: DbQueryable,
    row: AutomationRow,
    anchor: Date
  ): Promise<AutomationRow> {
    if (row.scheduleId) {
      await scheduleService.saveOwned(tx, this.ownedSchedule(row, anchor));
      return row;
    }
    const scheduleId = generateId('schedule');
    await scheduleService.saveOwned(tx, this.ownedSchedule({ ...row, scheduleId }, anchor));
    return Automations.update(row.id, { scheduleId }, tx);
  }

  private changed(
    row: Pick<AutomationRow, 'id' | 'calendarId'>,
    calendarIds: Array<string | null> = []
  ) {
    emitAutomationsChanged({ automationId: row.id });
    const calendars = new Set([row.calendarId, ...calendarIds].filter(Boolean));
    if (calendars.size === 0) emitCalendarChanged({ kind: 'automation', automationId: row.id });
    for (const calendarId of calendars) {
      emitCalendarChanged({ kind: 'automation', automationId: row.id, calendarId: calendarId! });
    }
  }

  async create(input: CreateAutomationInput, actor: AutomationActor): Promise<AutomationRecord> {
    this.refuseAutomated(actor);
    const name = text(input.name, 'name', AUTOMATION_NAME_MAX_LENGTH);
    const prompt = text(input.prompt, 'prompt', AUTOMATION_PROMPT_MAX_LENGTH);
    const threadId = id(input.threadId, 'thread_id');
    const agentId = id(input.agentId, 'agent_id');
    const unattendedPolicy = requestedUnattendedPolicy(input.unattendedPolicy, actor);
    if (actor.kind === 'agent') {
      if (threadId !== actor.threadId) {
        throw forbidden('Agents can only schedule wakes in their own thread.');
      }
      if (agentId !== actor.agentId)
        throw forbidden('Agents can only schedule wakes for themselves.');
    }
    const limits = await this.limits();
    const when = this.normalizeWhen(input.when, actor, limits);
    if (!(await Threads.findById(threadId))) throw notFound(`Thread ${threadId} not found.`);
    const agent = await Agents.findById(agentId);
    if (!agent || agent.deletedAt) throw notFound(`Agent ${agentId} not found.`);
    if (!(await ThreadParticipants.isAgentParticipant(threadId, agentId))) {
      throw bad(`${agent.name} isn't in that thread.`);
    }
    const memberId = await resolveCurrentActorMemberId();

    const calendarChanges = new PendingCalendarChanges();
    const row = await transaction(async (tx) => {
      await this.checkQuota(tx, agentId, actor, limits);
      if (actor.kind === 'agent' && actor.runId) {
        const made = await Automations.countCreatedInRun(actor.runId, tx);
        if (made >= limits.maxCreatedPerRun) {
          throw conflict(`You can create at most ${limits.maxCreatedPerRun} automations per run.`);
        }
      }
      const calendarId = await this.resolveCalendar(tx, input.calendarId, null, calendarChanges);
      const created = await Automations.insert(
        {
          id: generateId('automation'),
          name,
          prompt,
          when,
          calendarId,
          threadId,
          agentId,
          scheduleId: null,
          createdByAgentId: actor.kind === 'agent' ? actor.agentId : null,
          createdByMemberId: memberId,
          createdRunId: actor.kind === 'agent' ? actor.runId : null,
          ...(unattendedPolicy !== undefined ? { unattendedPolicy } : {}),
        },
        tx
      );
      return this.syncSchedule(tx, created, intervalAnchor(when));
    }).catch(mapCalendarForeignKeyError);
    calendarChanges.emit();
    scheduleService.notifySchedulesChanged([row.scheduleId!]);
    this.changed(row);
    const record = await this.get(row.id);
    if (actor.kind === 'agent' && when.kind !== 'once') {
      await noticeScheduled(row, agent.name, record.whenText, record.threadTitle);
    }
    return record;
  }

  async update(
    automationId: string,
    input: UpdateAutomationInput,
    actor: AutomationActor
  ): Promise<AutomationRecord> {
    this.refuseAutomated(actor);
    const name =
      input.name === undefined ? undefined : text(input.name, 'name', AUTOMATION_NAME_MAX_LENGTH);
    const prompt =
      input.prompt === undefined
        ? undefined
        : text(input.prompt, 'prompt', AUTOMATION_PROMPT_MAX_LENGTH);
    const unattendedPolicy = requestedUnattendedPolicy(input.unattendedPolicy, actor);
    const limits = await this.limits();
    const when =
      input.when === undefined ? undefined : this.normalizeWhen(input.when, actor, limits);
    let before: AutomationRow | null = null;
    let clearedReminders = false;
    const calendarChanges = new PendingCalendarChanges();
    const row = await transaction(async (tx) => {
      const current = await Automations.lockById(automationId, tx);
      if (!current) throw notFound(`Automation ${automationId} not found.`);
      if (current.status === 'cancelled') throw conflict(`Automation ${automationId} is canceled.`);
      this.assertCanChange(current, actor);
      before = current;
      const calendarId =
        when !== undefined || input.calendarId !== undefined
          ? await this.resolveCalendar(
              tx,
              input.calendarId,
              { calendarId: current.calendarId },
              calendarChanges
            )
          : current.calendarId;
      // New timing gives a finished automation more runs.
      const reopen = when !== undefined && current.status === 'finished';
      if (reopen) await this.checkQuota(tx, current.agentId, actor, limits);
      // The stored anchor stays unless the timing is explicitly re-anchored: a
      // new `at`, another shape, or a different interval length.
      const keepsAnchor =
        when === undefined ||
        (when.kind === 'interval' &&
          !when.anchor &&
          current.whenKind === 'interval' &&
          current.everyMs === when.everyMs);
      const anchor = keepsAnchor
        ? await this.currentAnchor(tx, current.scheduleId)
        : intervalAnchor(when);
      const updated = await Automations.update(
        automationId,
        {
          ...(name !== undefined ? { name } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(when !== undefined ? { when } : {}),
          calendarId,
          // An agent's (or external client's) edit puts the policy back to
          // `skip`: a person approved what the automation was, and chooses
          // again for what it is now.
          ...(usesAgentLimits(actor)
            ? { unattendedPolicy: 'skip' as const }
            : unattendedPolicy !== undefined
              ? { unattendedPolicy }
              : {}),
          ...(reopen ? { status: 'active' as const, consecutiveFailures: 0 } : {}),
        },
        tx
      );
      // A first-open wake has no start time to remind before.
      if (when?.kind === 'first_open') {
        clearedReminders = await Reminders.remove({ kind: 'automation', automationId }, tx);
      }
      return this.syncSchedule(tx, updated, anchor);
    }).catch(mapCalendarForeignKeyError);
    calendarChanges.emit();
    // Clients drop the OS notifications they scheduled for its reminders.
    if (clearedReminders) emitRemindersChanged();
    scheduleService.notifySchedulesChanged([row.scheduleId!]);
    const previous = before as AutomationRow | null;
    this.changed(row, [previous?.calendarId ?? null]);
    const record = await this.get(row.id);
    if (actor.kind === 'agent' && record.when.kind !== 'once' && (when || prompt !== undefined)) {
      const agent = await Agents.findById(actor.agentId);
      await noticeChanged(row, agent?.name ?? 'An agent', record.whenText);
    }
    return record;
  }

  /** Paused, keeping the failure streak; a paused or finished one is left as it is. */
  async pause(automationId: string, actor: AutomationActor): Promise<AutomationRecord> {
    return (await this.pauseCore(automationId, actor)).automation;
  }

  /**
   * {@link pause} for a person in the app, with a token for
   * {@link undoPause} when it paused an active automation (null when it was
   * already paused or finished, for agents and external clients, and when
   * the caller resolves to no member). Tokens live in this process's
   * memory: a server restart loses them, and the app's Undo then falls back
   * to a plain resume (a fresh failure streak).
   */
  async pauseWithUndo(
    automationId: string,
    actor: AutomationActor
  ): Promise<AutomationPauseResponse> {
    const memberId = undoesStatusChanges(actor) ? await resolveCurrentActorMemberId() : null;
    if (!memberId) return { automation: await this.pause(automationId, actor), undoToken: null };
    const { automation, kept } = await this.pauseCore(automationId, actor);
    return { automation, undoToken: kept ? this.keepUndo(kept, automationId, memberId) : null };
  }

  /** Pause's transaction; `kept` is the streak it kept, when it paused. */
  private async pauseCore(
    automationId: string,
    actor: AutomationActor
  ): Promise<{ automation: AutomationRecord; kept: KeptStreak | null }> {
    const { row, kept } = await transaction(
      async (tx): Promise<{ row: AutomationRow | null; kept: KeptStreak | null }> => {
        const current = await Automations.lockById(automationId, tx);
        if (!current) throw notFound(`Automation ${automationId} not found.`);
        if (current.status === 'cancelled')
          throw conflict(`Automation ${automationId} is canceled.`);
        this.assertCanChange(current, actor);
        if (current.status !== 'active') return { row: null, kept: null };
        const paused = await Automations.update(
          automationId,
          { status: 'paused', pausedReason: actor.kind === 'agent' ? 'agent' : 'user' },
          tx
        );
        const synced = await this.syncSchedule(
          tx,
          paused,
          await this.currentAnchor(tx, paused.scheduleId)
        );
        return {
          row: synced,
          kept: {
            kind: 'pause',
            consecutiveFailures: synced.consecutiveFailures,
            changedUpdatedAt: await this.exactUpdatedAt(tx, automationId),
          },
        };
      }
    );
    if (row) {
      scheduleService.notifySchedulesChanged([row.scheduleId!]);
      this.changed(row);
    }
    return { automation: await this.get(automationId), kept };
  }

  /**
   * Back to active with a fresh failure streak. On a deleted automation it
   * is the undo of the delete: see {@link restore}.
   */
  async resume(automationId: string, actor: AutomationActor): Promise<AutomationRecord> {
    return (await this.resumeCore(automationId, actor)).automation;
  }

  /**
   * {@link resume} for a person in the app, with a token for
   * {@link undoResume} when it cleared a pause (null when the automation
   * was already active, finished or deleted, for agents and external
   * clients, and when the caller resolves to no member). Tokens live in
   * this process's memory: a server restart loses them, and the app's Undo
   * then falls back to a plain pause with a "failure streak not restored"
   * toast.
   */
  async resumeWithUndo(
    automationId: string,
    actor: AutomationActor
  ): Promise<AutomationResumeResponse> {
    const memberId = undoesStatusChanges(actor) ? await resolveCurrentActorMemberId() : null;
    if (!memberId) return { automation: await this.resume(automationId, actor), undoToken: null };
    const { automation, cleared } = await this.resumeCore(automationId, actor);
    return {
      automation,
      undoToken: cleared ? this.keepUndo(cleared, automationId, memberId) : null,
    };
  }

  /** Resume's transaction; `cleared` is the pause it cleared, if any. */
  private async resumeCore(
    automationId: string,
    actor: AutomationActor
  ): Promise<{ automation: AutomationRecord; cleared: ClearedPause | null }> {
    const limits = await this.limits();
    const calendarChanges = new PendingCalendarChanges();
    const { row, cleared } = await transaction(
      async (tx): Promise<{ row: AutomationRow | null; cleared: ClearedPause | null }> => {
        const current = await Automations.lockById(automationId, tx);
        if (!current) throw notFound(`Automation ${automationId} not found.`);
        this.assertCanChange(current, actor);
        if (current.status === 'active') return { row: null, cleared: null };
        if (current.status === 'cancelled') {
          return {
            row: await this.restore(tx, current, actor, limits, calendarChanges),
            cleared: null,
          };
        }
        const synced = await this.activate(tx, current, actor, limits, calendarChanges, 0);
        return {
          row: synced,
          cleared:
            current.status === 'paused'
              ? {
                  kind: 'resume',
                  pausedReason: current.pausedReason,
                  consecutiveFailures: current.consecutiveFailures,
                  changedUpdatedAt: await this.exactUpdatedAt(tx, automationId),
                }
              : null,
        };
      }
    );
    calendarChanges.emit();
    if (row) {
      scheduleService.notifySchedulesChanged([row.scheduleId!]);
      this.changed(row);
    }
    return { automation: await this.get(automationId), cleared };
  }

  /**
   * A paused or finished row back to active with a failure streak of
   * `streak` (a resume: 0, a fresh one; a pause's undo: the one it kept),
   * when it has runs left and its agent is within the active quota. A
   * paused interval keeps its anchor; a finished one starts from now.
   */
  private async activate(
    tx: DbQueryable,
    current: AutomationRow,
    actor: AutomationActor,
    limits: AutomationLimits,
    calendarChanges: PendingCalendarChanges,
    streak: number
  ): Promise<AutomationRow> {
    const when = automationWhen(current);
    const now = new Date();
    const anchor =
      current.status === 'paused' ? await this.currentAnchor(tx, current.scheduleId) : now;
    if (!nextAutomationRun(when, now, anchor)) {
      throw conflict('This automation has no more runs.');
    }
    this.assertFloor(current, actor, limits);
    await this.checkQuota(tx, current.agentId, actor, limits);
    // No calendar stays none; one removed meanwhile falls back to the Default one.
    const calendarId = await this.resolveCalendar(
      tx,
      undefined,
      { calendarId: current.calendarId },
      calendarChanges
    );
    const resumed = await Automations.update(
      current.id,
      {
        status: 'active',
        pausedReason: null,
        consecutiveFailures: streak,
        calendarId,
      },
      tx
    );
    return this.syncSchedule(tx, resumed, anchor);
  }

  /**
   * Undo a person's resume: paused again with the reason and failure streak
   * it cleared. Only the member who resumed, with the token
   * {@link resumeWithUndo} gave them, once, within 30 minutes, and only
   * while nothing has changed since: still active with no failures, no
   * write since the resume, and no run started since. Tokens live in
   * memory, so a server restart loses them; the app's Undo then falls back
   * to a plain pause with a "failure streak not restored" toast.
   */
  async undoResume(
    automationId: string,
    token: unknown,
    actor: AutomationActor
  ): Promise<AutomationRecord> {
    return this.takeUndo('resume', automationId, token, actor, (undo) =>
      transaction(async (tx) => {
        const current = await Automations.lockById(automationId, tx);
        if (!current) throw notFound(`Automation ${automationId} not found.`);
        if (
          current.status !== 'active' ||
          current.consecutiveFailures !== 0 ||
          !(await this.untouchedSince(tx, automationId, undo.changedUpdatedAt))
        ) {
          throw conflict(UNDO_REFUSALS.resume.changed);
        }
        const paused = await Automations.update(
          automationId,
          {
            status: 'paused',
            pausedReason: undo.pausedReason,
            consecutiveFailures: undo.consecutiveFailures,
          },
          tx
        );
        return this.syncSchedule(tx, paused, await this.currentAnchor(tx, paused.scheduleId));
      })
    );
  }

  /**
   * Undo a person's pause, keeping the failure streak (a plain {@link resume}
   * starts a fresh one). Only the member who paused, with the token
   * {@link pauseWithUndo} gave them, once, within 30 minutes, and only while
   * nothing has changed since. Like a resume it needs runs left and room under
   * the agent's active limit (409 otherwise). Tokens live in memory; after a
   * restart the app's Undo falls back to a plain resume.
   */
  async undoPause(
    automationId: string,
    token: unknown,
    actor: AutomationActor
  ): Promise<AutomationRecord> {
    return this.takeUndo('pause', automationId, token, actor, async (undo) => {
      const limits = await this.limits();
      const calendarChanges = new PendingCalendarChanges();
      const row = await transaction(async (tx) => {
        const current = await Automations.lockById(automationId, tx);
        if (!current) throw notFound(`Automation ${automationId} not found.`);
        if (
          current.status !== 'paused' ||
          current.pausedReason !== 'user' ||
          current.consecutiveFailures !== undo.consecutiveFailures ||
          !(await this.untouchedSince(tx, automationId, undo.changedUpdatedAt))
        ) {
          throw conflict(UNDO_REFUSALS.pause.changed);
        }
        return this.activate(tx, current, actor, limits, calendarChanges, undo.consecutiveFailures);
      });
      calendarChanges.emit();
      return row;
    });
  }

  /**
   * The part both undos share: only a person in the app, with a live token
   * of this `kind` for this automation (else the "expired" 409: another
   * automation's token or the other kind's is refused, not used up), and
   * only the member who made the change. `apply` re-checks the row and
   * writes it in its own transaction; the token is dropped once it has.
   */
  private async takeUndo<K extends StatusUndo['kind']>(
    kind: K,
    automationId: string,
    token: unknown,
    actor: AutomationActor,
    apply: (undo: Extract<StatusUndo, { kind: K }>) => Promise<AutomationRow>
  ): Promise<AutomationRecord> {
    const refusals = UNDO_REFUSALS[kind];
    if (!undoesStatusChanges(actor)) throw forbidden(refusals.notPerson);
    const key = id(token, 'token');
    const held = this.statusUndos.get(key);
    const undo = held && held.expiresAt > Date.now() ? held : undefined;
    if (held && !undo) this.statusUndos.delete(key);
    if (!undo || !isUndoOf(undo, kind) || undo.automationId !== automationId) {
      throw conflict(refusals.expired);
    }
    const memberId = await resolveCurrentActorMemberId();
    if (!memberId || !undo.memberId || memberId !== undo.memberId) {
      throw forbidden(refusals.notYours);
    }
    const row = await apply(undo);
    this.statusUndos.delete(key);
    scheduleService.notifySchedulesChanged([row.scheduleId!]);
    this.changed(row);
    return this.get(automationId);
  }

  /** Hold an undo under a new token (expired ones go first, then the oldest past the cap). */
  private keepUndo(change: StatusChange, automationId: string, memberId: string): string {
    const now = Date.now();
    for (const [key, held] of this.statusUndos) {
      if (held.expiresAt <= now) this.statusUndos.delete(key);
    }
    while (this.statusUndos.size >= UNDO_MAX) {
      const oldest = this.statusUndos.keys().next().value;
      if (oldest === undefined) break;
      this.statusUndos.delete(oldest);
    }
    const token = randomUUID();
    this.statusUndos.set(token, {
      ...change,
      automationId,
      memberId,
      expiresAt: now + UNDO_TTL_MS,
    });
    return token;
  }

  /**
   * Whether the row is as an undoable change left it: the same updated_at,
   * to the microsecond, and no schedule run started since (a run that
   * succeeds with no streak to reset writes nothing to the row).
   */
  private async untouchedSince(
    tx: DbQueryable,
    automationId: string,
    at: string
  ): Promise<boolean> {
    const { rows } = await tx.query<{ unchanged: boolean; ran: boolean }>(
      `SELECT a.updated_at = $2::timestamptz AS unchanged,
              EXISTS (SELECT 1 FROM schedule_runs r
                       WHERE r.schedule_id = a.schedule_id AND r.started_at > $2::timestamptz) AS ran
         FROM automations a WHERE a.id = $1`,
      [automationId, at]
    );
    return rows[0]?.unchanged === true && !rows[0].ran;
  }

  /** The row's updated_at to the microsecond (records carry it to the millisecond). */
  private async exactUpdatedAt(tx: DbQueryable, automationId: string): Promise<string> {
    const { rows } = await tx.query<{ at: string }>(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM automations WHERE id = $1`,
      [automationId]
    );
    return rows[0].at;
  }

  /**
   * Undo a delete: the automation comes back as it was, on the schedule it
   * kept (so its runs carry on). Paused stays paused (same reason); one with
   * no more runs comes back finished; otherwise active, within the quota. The
   * failure streak is left as it was. A row with no kept schedule gets a
   * new one (and has no earlier runs).
   */
  private async restore(
    tx: DbQueryable,
    current: AutomationRow,
    actor: AutomationActor,
    limits: AutomationLimits,
    calendarChanges: PendingCalendarChanges
  ): Promise<AutomationRow> {
    const kept = await scheduleService.findOwned(tx, current.id);
    const when = automationWhen(current);
    const now = new Date();
    const anchor = kept ? await this.currentAnchor(tx, kept.id) : now;
    const status: AutomationStatus = kept?.pausedReason
      ? 'paused'
      : nextAutomationRun(when, now, anchor)
        ? 'active'
        : 'finished';
    if (status === 'active') {
      this.assertFloor(current, actor, limits);
      await this.checkQuota(tx, current.agentId, actor, limits);
    }
    const calendarId = await this.resolveCalendar(
      tx,
      undefined,
      { calendarId: current.calendarId },
      calendarChanges
    );
    const restored = await Automations.update(
      current.id,
      {
        status,
        pausedReason: status === 'paused' ? (kept?.pausedReason ?? null) : null,
        calendarId,
        ...(kept ? { scheduleId: kept.id } : {}),
      },
      tx
    );
    return this.syncSchedule(tx, restored, anchor);
  }

  async cancel(automationId: string, actor: AutomationActor): Promise<AutomationRecord> {
    let scheduleId: string | null = null;
    const row = await transaction(async (tx) => {
      const current = await Automations.lockById(automationId, tx);
      if (!current) throw notFound(`Automation ${automationId} not found.`);
      if (current.status === 'cancelled') throw conflict(`Automation ${automationId} is canceled.`);
      this.assertCanChange(current, actor);
      scheduleId = current.scheduleId;
      // The schedule stays (disabled), so its runs stay and a restore reuses
      // it; the deleted row may hold neither the link nor a paused reason.
      if (current.scheduleId) {
        await scheduleService.parkOwned(
          tx,
          current.scheduleId,
          current.status === 'paused' ? current.pausedReason : null
        );
      }
      return Automations.update(
        automationId,
        { status: 'cancelled', pausedReason: null, scheduleId: null },
        tx
      );
    });
    if (scheduleId) scheduleService.notifySchedulesChanged([scheduleId]);
    this.changed(row);
    return this.get(automationId);
  }

  /**
   * The Archive drawer's Restore: a deleted automation comes back exactly as
   * it was ({@link restore}). Only a deleted one changes; any other is
   * returned as it is (it was restored meanwhile), so a stale drawer never
   * resumes a paused one the way `resume` would.
   */
  async restoreArchived(automationId: string, actor: AutomationActor): Promise<AutomationRecord> {
    const limits = await this.limits();
    const calendarChanges = new PendingCalendarChanges();
    const row = await transaction(async (tx) => {
      const current = await Automations.lockById(automationId, tx);
      if (!current) throw notFound(`Automation ${automationId} not found.`);
      this.assertCanChange(current, actor);
      if (current.status !== 'cancelled') return null;
      return this.restore(tx, current, actor, limits, calendarChanges);
    });
    calendarChanges.emit();
    if (row) {
      scheduleService.notifySchedulesChanged([row.scheduleId!]);
      this.changed(row);
    }
    return this.get(automationId);
  }

  /**
   * The Archive drawer's Delete: a deleted automation goes for good, with the
   * schedule it kept, its run log and its reminder settings
   * ({@link Automations.purge}); the wakes it posted stay in its thread. Only
   * a deleted one (409 otherwise: delete it first). Returns it as it was.
   */
  async purge(automationId: string, actor: AutomationActor): Promise<AutomationRecord> {
    const was = await this.get(automationId);
    const scheduleIds = await transaction(async (tx) => {
      const current = await Automations.lockById(automationId, tx);
      if (!current) throw notFound(`Automation ${automationId} not found.`);
      this.assertCanChange(current, actor);
      if (current.status !== 'cancelled') {
        throw conflict(
          `Automation ${automationId} isn't archived. Archive (delete) it before deleting it for good.`
        );
      }
      return Automations.purge(automationId, tx);
    });
    if (scheduleIds.length) scheduleService.notifySchedulesChanged(scheduleIds);
    // Not on any calendar while deleted, so only the automations surface hears it.
    emitAutomationsChanged({ automationId });
    return was;
  }

  /**
   * Delete every deleted (archived) automation for good: the Archive
   * drawer's Sweep. One restored or purged meanwhile is left out. Returns
   * how many went.
   */
  async purgeArchived(actor: AutomationActor): Promise<number> {
    let purged = 0;
    for (const row of await Automations.listCanceled()) {
      try {
        await this.purge(row.id, actor);
        purged += 1;
      } catch (error) {
        const status = error instanceof AppError ? error.statusCode : null;
        if (status !== HTTP_STATUS.NOT_FOUND && status !== HTTP_STATUS.CONFLICT) throw error;
      }
    }
    return purged;
  }

  /**
   * "Run now": one wake at once through the scheduler's claim and checks
   * (a paused or finished automation too; a deleted one is refused). People
   * in the app have no limit; an external MCP client gets the agent's
   * per-hour limit. An agent (the tool's `run`, to test an automation) runs
   * only automations it created, never from a run an automation started (a
   * test wake cannot start another), and at most `agentRunsPerHour` times
   * per automation in an hour; a skipped run (nothing posted) is not counted.
   */
  async runNow(
    automationId: string,
    actor: AutomationActor = { kind: 'person' }
  ): Promise<AutomationRunNowResponse> {
    if (actor.kind === 'agent' && actor.wakeOrigin) throw forbidden(AUTOMATED_RUN_NOW_REFUSAL);
    let row = await Automations.findById(automationId);
    if (!row) throw notFound(`Automation ${automationId} not found.`);
    if (row.status === 'cancelled') throw conflict(`Automation ${automationId} is canceled.`);
    if (actor.kind === 'agent' && row.createdByAgentId !== actor.agentId) {
      throw forbidden('You can only run automations you created.');
    }
    const release = usesAgentLimits(actor)
      ? this.takeAgentRun(row, (await this.limits()).agentRunsPerHour)
      : null;
    try {
      if (!row.scheduleId || !(await scheduleService.get(row.scheduleId))) {
        await this.reconcileOne(row);
        row = (await Automations.findById(automationId))!;
      }
      // An agent's or external client's Run now may not auto-approve: the
      // cap reaches fire(), which marks the wake (see WakeOrigin.agentStarted).
      const scheduleId = row.scheduleId!;
      const run = usesAgentLimits(actor)
        ? await runCappedUnattended(() => scheduleService.runOwnedNow(scheduleId))
        : await scheduleService.runOwnedNow(scheduleId);
      if (run.status === 'skipped') release?.();
      return {
        automation: await this.get(automationId),
        run: { status: run.status, error: run.error },
      };
    } catch (err) {
      release?.();
      throw err;
    }
  }

  /**
   * Count one agent Run now against the automation's hour, or refuse with
   * when the next one frees up. Check and count happen with no await between
   * them, so parallel calls cannot both slip under the limit. Returns the
   * undo for a run that posted nothing.
   */
  private takeAgentRun(row: AutomationRow, perHour: number): () => void {
    const now = Date.now();
    const recent = (this.agentRunNows.get(row.id) ?? []).filter(
      (at) => now - at < AGENT_RUN_WINDOW_MS
    );
    if (recent.length >= perHour) {
      this.agentRunNows.set(row.id, recent);
      const frees = formatAutomationInstant(new Date(recent[0]! + AGENT_RUN_WINDOW_MS), row.tz);
      const times = perHour === 1 ? 'once' : `${perHour} times`;
      throw conflict(
        `You can run an automation at most ${times} an hour. Try this one again after ${frees}.`
      );
    }
    recent.push(now);
    this.agentRunNows.set(row.id, recent);
    return () => {
      const list = this.agentRunNows.get(row.id);
      const at = list?.indexOf(now) ?? -1;
      if (list && at >= 0) list.splice(at, 1);
    };
  }

  // The scheduler's hooks

  /**
   * Fire one wake: read the row now, post the prompt as the local user, and
   * wake the agent (not awaited: the schedule run ends once the message is
   * posted; the wake's outcome feeds the failure streak when it settles).
   */
  async fire(automationId: string, ctx: FireContext): Promise<string> {
    const row = await Automations.findById(automationId);
    if (!row) throw new ScheduleRunSkipped('Automation not found');
    if (row.status === 'cancelled') throw new ScheduleRunSkipped('Automation is canceled');
    if (!ctx.manual && row.status !== 'active') {
      throw new ScheduleRunSkipped(
        row.status === 'paused' ? 'Automation is paused' : 'Automation is finished'
      );
    }
    if (this.liveWakes.has(automationId)) throw new ScheduleRunSkipped(PREVIOUS_RUN_GOING);

    // Claimed before posting, so two fires at once (the tick and Run now)
    // cannot both get through.
    this.liveWakes.set(automationId, { since: Date.now() });
    let posted: { messageId: string; content: string; senderId: string; agentName: string };
    // An agent's (or external client's) Run now reaches here capped, inside
    // its call (the scheduler's tick is neither). Its wake may not
    // auto-approve: marked on the wake and on the seed, so a wake delivered
    // later keeps the mark.
    const agentStarted = currentUnattendedCap() || getCurrentActor()?.actorKind === 'agent';
    try {
      posted = await this.postPrompt(row, ctx.scheduledFor, agentStarted);
    } catch (err) {
      this.liveWakes.delete(automationId);
      await this.recordOutcome(row, ctx.scheduleRunId, {
        kind: 'failure',
        error: getErrorMessage(err),
      });
      throw err;
    }
    const postedAt = Date.now();
    const { dispatchToThread } =
      await import('@server/services/SocketService/dispatch/dispatchToThread');
    const wakeOrigin: WakeOrigin = {
      kind: 'automation',
      automationId,
      ...(agentStarted ? { agentStarted: true as const } : {}),
    };
    void dispatchToThread({
      threadId: row.threadId,
      senderId: posted.senderId,
      messageId: posted.messageId,
      message: posted.content,
      source: 'tool',
      targetAgentId: row.agentId,
      wakeOrigin,
    })
      .then(
        (result) => this.judgeWake(row, posted.agentName, postedAt, result),
        (err: unknown): WakeOutcome => ({ kind: 'failure', error: getErrorMessage(err) })
      )
      .then((outcome) => this.recordOutcome(row, ctx.scheduleRunId, outcome))
      .catch((err: unknown) =>
        logger.warn(
          `[automations] wake bookkeeping failed for ${automationId}: ${getErrorMessage(err)}`
        )
      )
      .finally(() => {
        this.liveWakes.delete(automationId);
        this.changed(row);
      });
    this.changed(row);
    // The run's output; the run log reads `manual` from it.
    return JSON.stringify({ messageId: posted.messageId, ...(ctx.manual ? { manual: true } : {}) });
  }

  /** A once ran, or a repeat's COUNT/UNTIL is used up: no more runs. */
  async markFinished(automationId: string): Promise<void> {
    const row = await transaction(async (tx) => {
      const current = await Automations.lockById(automationId, tx);
      if (!current || current.status !== 'active') return null;
      const finished = await Automations.update(automationId, { status: 'finished' }, tx);
      if (finished.scheduleId) {
        await tx.query(
          `UPDATE schedules SET enabled=false, next_run_at=NULL, updated_at=now() WHERE id=$1`,
          [finished.scheduleId]
        );
      }
      return finished;
    });
    if (row) this.changed(row);
  }

  /** The scheduler skipped a wake missed while Snaglet was off. A missed once finishes and notifies. */
  async onMissed(
    automationId: string,
    missed: { scheduledFor: Date; finished: boolean; once: boolean }
  ): Promise<void> {
    if (missed.finished) await this.markFinished(automationId);
    const row = await Automations.findById(automationId);
    if (!row) return;
    this.changed(row);
    if (missed.once) await noticeMissed(row, missed.scheduledFor, row.tz);
  }

  /**
   * Boot repair: every non-canceled automation owns exactly one schedule
   * whose enabled flag matches its status; a deleted one's kept schedule is
   * disabled (it keeps the runs and serves a restore); any other automation
   * schedule (no automation, or a second one for a live automation) is
   * deleted. A correct schedule is left untouched (its next run may be due,
   * and the missed-run rule decides what happens to it).
   */
  async reconcile(): Promise<{ repaired: number; removed: number }> {
    let repaired = 0;
    for (const row of await Automations.listNonCanceled()) {
      if (await this.reconcileOne(row)) repaired += 1;
    }
    const db = getDb();
    const { rows: parked } = await db.query<{ id: string }>(
      `UPDATE schedules s SET enabled = false, next_run_at = NULL, updated_at = now()
        WHERE s.action_kind = 'automation'
          AND (s.enabled OR s.next_run_at IS NOT NULL)
          AND EXISTS (SELECT 1 FROM automations a
                       WHERE a.id = s.action_json->>'automationId' AND a.status = 'cancelled')
        RETURNING s.id`
    );
    repaired += parked.length;
    const { rows } = await db.query<{ id: string }>(
      `DELETE FROM schedules s
        WHERE s.action_kind = 'automation'
          AND NOT EXISTS (SELECT 1 FROM automations a
                           WHERE a.id = s.action_json->>'automationId'
                             AND (a.status = 'cancelled' OR a.schedule_id = s.id))
        RETURNING s.id`
    );
    const touched = [...parked, ...rows].map((r) => r.id);
    if (touched.length) scheduleService.notifySchedulesChanged(touched);
    if (repaired || rows.length) {
      logger.info(
        `[automations] reconcile: ${repaired} schedule(s) repaired, ${rows.length} orphan(s) removed`
      );
    }
    return { repaired, removed: rows.length };
  }

  /**
   * One non-canceled row: a missing link adopts the schedule it kept (its
   * runs stay with it) or gets a new one; a wrong flag or action is rewritten.
   */
  private async reconcileOne(row: AutomationRow): Promise<boolean> {
    const fixed = await transaction(async (tx) => {
      let current = await Automations.lockById(row.id, tx);
      if (!current || current.status === 'cancelled') return null;
      const kept = current.scheduleId ? null : await scheduleService.findOwned(tx, current.id);
      if (kept) current = await Automations.update(current.id, { scheduleId: kept.id }, tx);
      const { rows } = await tx.query<{
        enabled: boolean;
        action_kind: string;
        automation_id: string | null;
      }>(
        `SELECT enabled, action_kind, action_json->>'automationId' AS automation_id
           FROM schedules WHERE id = $1`,
        [current.scheduleId]
      );
      const schedule = current.scheduleId ? rows[0] : undefined;
      const wantEnabled = current.status === 'active';
      if (
        !kept &&
        schedule &&
        schedule.action_kind === 'automation' &&
        schedule.automation_id === current.id &&
        schedule.enabled === wantEnabled
      ) {
        return null;
      }
      return this.syncSchedule(tx, current, await this.currentAnchor(tx, current.scheduleId));
    });
    if (fixed) scheduleService.notifySchedulesChanged([fixed.scheduleId!]);
    return fixed !== null;
  }

  // Internals

  /** `[automation <name>] @Agent <prompt>`, posted as the local user with metadata.automation. */
  private async postPrompt(row: AutomationRow, scheduledFor: Date, agentStarted = false) {
    const thread = await Threads.findById(row.threadId);
    if (!thread) throw new Error(`Thread ${row.threadId} not found`);
    const agent = await Agents.findById(row.agentId);
    if (!agent) throw new Error(`Agent ${row.agentId} not found`);
    const user = await Users.getOrCreateLocalUser();
    const messageId = generateId('message');
    const content = `[automation ${row.name}] @${agent.name} ${row.prompt}`;
    const metadata = {
      automation: {
        id: row.id,
        name: row.name,
        scheduledFor: scheduledFor.toISOString(),
        ...(agentStarted ? { agentStarted: true } : {}),
      },
    };
    await Messages.create({
      id: messageId,
      threadId: row.threadId,
      role: 'user',
      userId: user.id,
      content,
      messageType: 'message',
      metadata,
    });
    hooks.emit('message:create', {
      id: messageId,
      threadId: row.threadId,
      role: 'user',
      text: content,
      chars: content.length,
    });
    wsService.broadcastToChannel(row.threadId, {
      type: 'socket:chat:message_created',
      payload: {
        id: messageId,
        threadId: row.threadId,
        role: 'user',
        content,
        user_id: user.id,
        agent_id: null,
        created_at: isoNow(),
        message_type: 'message',
        metadata,
      },
    });
    return { messageId, content, senderId: user.id, agentName: agent.name };
  }

  /** How the wake went, from the dispatch result and the agent's last run since posting. */
  private async judgeWake(
    row: AutomationRow,
    agentName: string,
    postedAt: number,
    result: Awaited<
      ReturnType<
        typeof import('@server/services/SocketService/dispatch/dispatchToThread').dispatchToThread
      >
    >
  ): Promise<WakeOutcome> {
    if (!result.ok) return { kind: 'failure', error: 'Too many agents would wake; nothing ran.' };
    if (result.reason === 'queued_for_post_run' || result.reason === 'held_for_summary_halt') {
      // The thread was busy (or halted): the wake is delivered later with its
      // marker, outside this bookkeeping.
      return { kind: 'neutral' };
    }
    if (result.reason === 'no_dispatch' || result.wakeCount === 0) {
      return { kind: 'failure', error: `${agentName} could not be woken in that thread.` };
    }
    const { rows } = await getDb().query<{ status: string; error: string | null }>(
      `SELECT status, error FROM runs
        WHERE thread_id = $1 AND agent_id = $2 AND started_at >= $3
        ORDER BY started_at DESC LIMIT 1`,
      [row.threadId, row.agentId, new Date(postedAt - 1000).toISOString()]
    );
    const run = rows[0];
    if (!run) return { kind: 'neutral' };
    if (run.status === 'completed') return { kind: 'success' };
    if (run.status === 'failed') {
      return stoppedByPerson(run.error)
        ? { kind: 'neutral' }
        : { kind: 'failure', error: run.error ?? 'The run failed.' };
    }
    return { kind: 'neutral' };
  }

  /**
   * Feed the failure streak. A failure marks the schedule run failed, and at
   * the limit pauses the automation (reason `failures`) and notifies; a
   * success resets the streak.
   */
  private async recordOutcome(
    row: AutomationRow,
    scheduleRunId: string,
    outcome: WakeOutcome
  ): Promise<void> {
    if (outcome.kind === 'neutral') return;
    const db = getDb();
    if (outcome.kind === 'success') {
      // A row deleted while its wake was going keeps its streak, as a failure
      // leaves it: a deleted row is never written (its updated_at is when it
      // was deleted, the Archive drawer's age).
      await db.query(
        `UPDATE automations SET consecutive_failures = 0, updated_at = now()
          WHERE id = $1 AND consecutive_failures <> 0 AND status <> 'cancelled'`,
        [row.id]
      );
      return;
    }
    const limits = await this.limits();
    const paused = await transaction(async (tx) => {
      await tx.query(
        `UPDATE schedule_runs SET status = 'failed', error = $2, finished_at = COALESCE(finished_at, now())
          WHERE id = $1`,
        [scheduleRunId, outcome.error.slice(0, 10_000)]
      );
      const current = await Automations.lockById(row.id, tx);
      if (!current || current.status === 'cancelled') return null;
      if (current.scheduleId) {
        await tx.query(
          `UPDATE schedules SET last_status = 'failed', updated_at = now() WHERE id = $1`,
          [current.scheduleId]
        );
      }
      const failures = current.consecutiveFailures + 1;
      const pause = failures >= limits.failuresBeforePause && current.status === 'active';
      const updated = await Automations.update(
        row.id,
        {
          consecutiveFailures: failures,
          ...(pause ? { status: 'paused' as const, pausedReason: 'failures' as const } : {}),
        },
        tx
      );
      if (!pause) return null;
      return this.syncSchedule(tx, updated, await this.currentAnchor(tx, updated.scheduleId));
    });
    if (paused) {
      scheduleService.notifySchedulesChanged([paused.scheduleId!]);
      await noticeAutoPaused(paused, paused.consecutiveFailures, outcome.error);
    }
    this.changed(row);
  }
}

export const automationService = new AutomationServiceClass();
