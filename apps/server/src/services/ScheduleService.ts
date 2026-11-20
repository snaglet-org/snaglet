import { getDb } from '@snaglet/db';
import { createHash } from 'crypto';
import { Automations } from '@snaglet/db/tables/automations';
import type { NodeRunner } from '@snaglet/db/tables/nodes';
import type {
  AutomationPausedReason,
  AutomationScheduleAction,
  CalendarScheduleConfig,
  FirstOpenScheduleConfig,
  HookScheduleAction,
  IntervalScheduleConfig,
  RruleScheduleConfig,
  SaveScheduleInput,
  ScheduleAction,
  ScheduleRecord,
  ScheduleRunRecord,
} from '@snaglet/shared/types';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import {
  AppError,
  MIN_INTERVAL_MS,
  firstOpenSlot,
  firstOpenTick,
  generateId,
  getErrorMessage,
  intervalWindowOf,
  isWithinIntervalWindow,
  localDayBounds,
  nextFirstOpenRun,
  nextRepeatRun,
  nextWindowedIntervalRun,
} from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { getHookRegistry } from '@server/services/customHooks/HookRegistryService';
import { systemAwake } from '@server/services/systemActivity/fullWake';
import {
  NETWORK_GUARD_WINDOW_MS,
  NetworkNotReadyError,
  networkGuard,
  probeHostForAgent,
  type NetworkCheck,
} from '@server/services/systemActivity/networkGuard';
import { systemWakeMonitor } from '@server/services/systemActivity/systemWake';
import { wsService } from '@server/services/WebSocketService';

const MAX_TIMER_DELAY_MS = 60_000;
// When a due first-open wake that may not run yet looks again: in a dark wake
// (lid closed, Power Nap), while the network guard's wait after a start or
// wake is still probing, once the network did not answer, and while a Run now
// of it is still going.
const FIRST_OPEN_DARK_WAKE_RETRY_MS = 60_000;
const FIRST_OPEN_NETWORK_WAITING_RETRY_MS = 10_000;
const FIRST_OPEN_NETWORK_DOWN_RETRY_MS = 2 * 60_000;
const FIRST_OPEN_BUSY_RETRY_MS = 60_000;

/** Why an automation's wake is skipped while its previous one (a Run now, say) is still going. */
export const PREVIOUS_RUN_GOING = 'Previous run is still going';

/** Refusal for generic schedule writes to a row an automation owns. */
export const AUTOMATION_SCHEDULE_REFUSAL =
  'This schedule belongs to an automation; edit the automation.';

function ownedRefusal(): AppError {
  return new AppError(AUTOMATION_SCHEDULE_REFUSAL, ErrorCode.CONFLICT, HTTP_STATUS.CONFLICT);
}

/**
 * Thrown by an action that decided not to run this occurrence (an automation
 * that is paused at fire time, or whose previous wake is still going). The
 * run is logged `skipped` with this message instead of `failed`.
 */
export class ScheduleRunSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleRunSkipped';
  }
}

/** Input for {@link ScheduleServiceClass.saveOwned}: an automation's own schedule. */
export interface OwnedScheduleInput {
  id: string;
  name: string;
  enabled: boolean;
  scheduleKind: 'once' | 'interval' | 'rrule' | 'first_open';
  schedule: ScheduleRecord['schedule'];
  timezone: string;
  automationId: string;
  nextRunAt: Date | null;
}

/**
 * The tick's advance of a claimed schedule ($2: still enabled, $3: its next
 * run). It reads `enabled` from the row, not the tick's copy: a pause, a
 * delete (an automation parks its schedule) or a disable that commits after
 * the tick read the row keeps the schedule off, with no next run, instead of
 * being switched back on.
 */
const ADVANCE_SET = `enabled = (enabled AND $2::boolean),
  next_run_at = CASE WHEN enabled AND $2::boolean THEN $3::timestamptz END`;

/** The automation hooks the scheduler calls (AutomationService; loaded lazily, no import cycle). */
async function automations() {
  const { automationService } = await import('@server/services/automations/AutomationService');
  return automationService;
}

interface ScheduleRawRow {
  id: string;
  name: string;
  enabled: boolean;
  schedule_kind: ScheduleRecord['scheduleKind'];
  schedule_json: ScheduleRecord['schedule'];
  timezone: string;
  action_kind: ScheduleRecord['actionKind'];
  action_json: ScheduleAction;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: ScheduleRecord['lastStatus'];
  created_at: string;
  updated_at: string;
}

interface ScheduleRunRawRow {
  id: string;
  schedule_id: string;
  scheduled_for: string;
  status: ScheduleRunRecord['status'];
  output: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function mapSchedule(row: ScheduleRawRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    scheduleKind: row.schedule_kind,
    schedule: row.schedule_json,
    timezone: row.timezone,
    actionKind: row.action_kind,
    action: row.action_json,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: ScheduleRunRawRow): ScheduleRunRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    output: row.output,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function intervalMs(config: IntervalScheduleConfig): number {
  if (!Number.isInteger(config.every) || config.every < 1) {
    throw new Error('Interval must be a positive whole number');
  }
  const multiplier = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
  }[config.unit];
  if (!multiplier) throw new Error('Interval unit must be minute, hour, day, or week');
  const value = config.every * multiplier;
  if (value < MIN_INTERVAL_MS)
    throw new Error('Schedules cannot run more often than once a minute');
  return value;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timezone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** Convert a wall-clock time in an IANA zone to an instant (DST aware). */
function zonedDate(parts: Omit<DateParts, 'second'>, timezone: string): Date {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  let guess = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const actual = zonedParts(new Date(guess), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    guess += desired - actualAsUtc;
  }
  return new Date(guess);
}

function isoWeekday(year: number, month: number, day: number): number {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function nextCalendarRun(config: CalendarScheduleConfig, timezone: string, after: Date): Date {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.time)) {
    throw new Error('Calendar time must use HH:mm');
  }
  // Throws RangeError for an unknown timezone, producing a useful validation error.
  const local = zonedParts(after, timezone);
  const [hour, minute] = config.time.split(':').map(Number);
  const allowed = new Set(config.weekdays?.length ? config.weekdays : [1, 2, 3, 4, 5, 6, 7]);
  for (let offset = 0; offset <= 14; offset += 1) {
    const cursor = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    if (!allowed.has(isoWeekday(year, month, day))) continue;
    const candidate = zonedDate({ year, month, day, hour, minute }, timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error('Could not calculate the next calendar occurrence');
}

export function calculateNextRun(
  input: Pick<SaveScheduleInput, 'scheduleKind' | 'schedule' | 'timezone'>,
  after: Date = new Date()
): Date | null {
  if (input.scheduleKind === 'rrule') {
    // The shared tableRecurrence engine, in wall-clock time; null once
    // COUNT / UNTIL is used up.
    const config = input.schedule as RruleScheduleConfig;
    return nextRepeatRun(
      { rrule: config.rrule, timeOfDay: config.time, startsOn: config.startsOn },
      input.timezone,
      after
    );
  }
  if (input.scheduleKind === 'first_open') {
    // Due from its next `after`; the tick decides whether it runs then.
    const config = input.schedule as FirstOpenScheduleConfig;
    return nextFirstOpenRun(config.after, input.timezone, after);
  }
  if (input.scheduleKind === 'once') {
    const at = new Date((input.schedule as { at?: string }).at ?? '');
    if (Number.isNaN(at.getTime())) throw new Error('Once schedules require a valid date and time');
    return at;
  }
  if (input.scheduleKind === 'interval') {
    const config = input.schedule as IntervalScheduleConfig;
    const interval = intervalMs(config);
    // A daily window: runs from its start each day, not from the anchor.
    const window = intervalWindowOf(config);
    if (window) return nextWindowedIntervalRun(interval, window, input.timezone, after);
    const anchor = config.anchor ? new Date(config.anchor) : after;
    if (Number.isNaN(anchor.getTime())) throw new Error('Interval anchor is invalid');
    if (anchor.getTime() > after.getTime()) return anchor;
    const elapsed = after.getTime() - anchor.getTime();
    return new Date(anchor.getTime() + (Math.floor(elapsed / interval) + 1) * interval);
  }
  return nextCalendarRun(input.schedule as CalendarScheduleConfig, input.timezone, after);
}

/**
 * Whether `schedule` is an interval with a daily window that is closed
 * at `at`. A wake comes due inside its window; this says when one that fires
 * late (Snaglet was off or busy) would land outside it.
 */
export function intervalWindowClosed(
  schedule: Pick<ScheduleRecord, 'scheduleKind' | 'schedule' | 'timezone'>,
  at: Date
): boolean {
  if (schedule.scheduleKind !== 'interval') return false;
  const window = intervalWindowOf(schedule.schedule as IntervalScheduleConfig);
  return window !== null && !isWithinIntervalWindow(at, window, schedule.timezone);
}

/** Missed-run reason for a late wake whose window closed before it could fire. */
export const WINDOW_CLOSED_SKIP = 'Missed: its window had closed';

function emitScheduleChanged(id: string): void {
  wsService.broadcastToChannel('schedules', {
    type: 'schedule:changed',
    payload: { id },
  });
}

function normalizeHookSchedule(
  hookName: string,
  declaration: unknown,
  index: number
): SaveScheduleInput & { id: string } {
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new Error(`schedule[${index}] must be an object`);
  }
  const value = declaration as Record<string, unknown>;
  let scheduleKind: SaveScheduleInput['scheduleKind'];
  let schedule: SaveScheduleInput['schedule'];
  let timezone = 'UTC';
  if (typeof value.at === 'string') {
    scheduleKind = 'once';
    schedule = { at: value.at };
  } else if (typeof value.every === 'number' && typeof value.unit === 'string') {
    scheduleKind = 'interval';
    schedule = {
      every: value.every,
      unit: value.unit as IntervalScheduleConfig['unit'],
      ...(typeof value.anchor === 'string' ? { anchor: value.anchor } : {}),
    };
  } else if (typeof value.time === 'string' && typeof value.timezone === 'string') {
    scheduleKind = 'calendar';
    timezone = value.timezone;
    schedule = {
      time: value.time,
      ...(Array.isArray(value.weekdays) ? { weekdays: value.weekdays as number[] } : {}),
    };
  } else {
    throw new Error(`schedule[${index}] must declare at, every + unit, or time + timezone`);
  }
  const canonical = JSON.stringify({ scheduleKind, schedule, timezone });
  const digest = createHash('sha256')
    .update(`${hookName}\0${canonical}`)
    .digest('hex')
    .slice(0, 24);
  return {
    id: `schedule-hook-${digest}`,
    name: `${hookName} · ${index + 1}`,
    scheduleKind,
    schedule,
    timezone,
    actionKind: 'hook',
    action: { hookName, source: 'hook-definition' } as HookScheduleAction,
  };
}

class ScheduleServiceClass {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private running = false;
  private offWake: (() => void) | null = null;

  async list(): Promise<ScheduleRecord[]> {
    const { rows } = await getDb().query<ScheduleRawRow>(
      `SELECT * FROM schedules ORDER BY created_at DESC`
    );
    return rows.map(mapSchedule);
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    const { rows } = await getDb().query<ScheduleRawRow>(`SELECT * FROM schedules WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? mapSchedule(rows[0]) : null;
  }

  /**
   * Reconcile defineHook({ schedule }) declarations into durable rows. Stable
   * content-derived ids preserve run history and a paused/finished state when
   * unrelated hook code changes; changing a declaration creates a new row.
   */
  async reconcileHookSchedules(hookName: string, declarations: unknown[]): Promise<void> {
    const desired = declarations.map((declaration, index) =>
      normalizeHookSchedule(hookName, declaration, index)
    );
    desired.forEach((input) => this.validate(input));
    const db = getDb();
    const desiredIds = desired.map((input) => input.id);
    await db.query(
      `DELETE FROM schedules
        WHERE action_kind='hook'
          AND action_json->>'source'='hook-definition'
          AND action_json->>'hookName'=$1
          AND NOT (id = ANY($2::text[]))`,
      [hookName, desiredIds]
    );
    for (const input of desired) {
      const next = calculateNextRun(input);
      await db.query(
        `INSERT INTO schedules
           (id, name, enabled, schedule_kind, schedule_json, timezone,
            action_kind, action_json, next_run_at)
         VALUES ($1,$2,true,$3,$4,$5,'hook',$6,$7)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`,
        [
          input.id,
          input.name,
          input.scheduleKind,
          JSON.stringify(input.schedule),
          input.timezone,
          JSON.stringify(input.action),
          next?.toISOString() ?? null,
        ]
      );
      emitScheduleChanged(input.id);
    }
    this.arm();
  }

  async removeHookSchedules(
    hookName: string,
    options: { runner?: NodeRunner; notify?: boolean } = {}
  ): Promise<string[]> {
    const result = await (options.runner ?? getDb()).query<{ id: string }>(
      `DELETE FROM schedules
        WHERE action_kind='hook'
          AND action_json->>'source'='hook-definition'
          AND action_json->>'hookName'=$1
        RETURNING id`,
      [hookName]
    );
    const ids = result.rows.map((row) => row.id);
    if (options.notify !== false) this.notifySchedulesRemoved(ids);
    return ids;
  }

  /** Publish schedule invalidations only after the owning transaction commits. */
  notifySchedulesRemoved(ids: Iterable<string>): void {
    for (const id of ids) emitScheduleChanged(id);
    this.arm();
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduleRecord> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Schedule not found: ${id}`);
    if (existing.actionKind === 'automation') throw ownedRefusal();
    const next = enabled ? calculateNextRun(existing) : null;
    const { rows } = await getDb().query<ScheduleRawRow>(
      `UPDATE schedules SET enabled=$2, next_run_at=$3, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, enabled, next?.toISOString() ?? null]
    );
    emitScheduleChanged(id);
    this.arm();
    return mapSchedule(rows[0]);
  }

  async listRuns(id: string, limit = 25): Promise<ScheduleRunRecord[]> {
    const { rows } = await getDb().query<ScheduleRunRawRow>(
      `SELECT * FROM schedule_runs WHERE schedule_id=$1
        ORDER BY started_at DESC LIMIT $2`,
      [id, Math.min(Math.max(limit, 1), 100)]
    );
    return rows.map(mapRun);
  }

  async runNow(id: string): Promise<ScheduleRunRecord> {
    const schedule = await this.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    if (schedule.actionKind === 'automation') throw ownedRefusal();
    return this.executeClaimed(schedule, new Date(), false);
  }

  // Automation-owned schedules
  // AutomationService is the only caller: it writes the automation row and
  // its schedule in one transaction, then calls notifySchedulesChanged once
  // that transaction commits. The generic routes above refuse these rows.

  /** Insert or replace an automation's own schedule inside `runner`'s transaction. */
  async saveOwned(runner: NodeRunner, input: OwnedScheduleInput): Promise<void> {
    await runner.query(
      `INSERT INTO schedules
         (id, name, enabled, schedule_kind, schedule_json, timezone,
          action_kind, action_json, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,'automation',$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, enabled=EXCLUDED.enabled, schedule_kind=EXCLUDED.schedule_kind,
         schedule_json=EXCLUDED.schedule_json, timezone=EXCLUDED.timezone,
         action_kind='automation', action_json=EXCLUDED.action_json,
         next_run_at=EXCLUDED.next_run_at, updated_at=now()`,
      [
        input.id,
        input.name.trim() || 'Automation',
        input.enabled,
        input.scheduleKind,
        JSON.stringify(input.schedule),
        input.timezone,
        JSON.stringify({ automationId: input.automationId } satisfies AutomationScheduleAction),
        input.enabled ? (input.nextRunAt?.toISOString() ?? null) : null,
      ]
    );
  }

  /**
   * Keep a deleted automation's schedule, and so its runs, without it firing:
   * disabled, no next run, and the paused reason a restore needs (the
   * automation row cannot hold one while deleted). Inside `runner`'s transaction.
   */
  async parkOwned(
    runner: NodeRunner,
    id: string,
    pausedReason: AutomationPausedReason | null
  ): Promise<void> {
    await runner.query(
      `UPDATE schedules
          SET enabled=false, next_run_at=NULL, updated_at=now(),
              action_json = jsonb_strip_nulls(jsonb_build_object(
                'automationId', action_json->>'automationId', 'pausedReason', $2::text))
        WHERE id=$1 AND action_kind='automation'`,
      [id, pausedReason]
    );
  }

  /**
   * The schedule an automation keeps (by its action, so also a deleted
   * automation's parked one), newest first; null when it has none.
   */
  async findOwned(
    runner: NodeRunner,
    automationId: string
  ): Promise<{ id: string; pausedReason: AutomationPausedReason | null } | null> {
    const { rows } = await runner.query<{
      id: string;
      paused_reason: AutomationPausedReason | null;
    }>(
      `SELECT id, action_json->>'pausedReason' AS paused_reason FROM schedules
        WHERE action_kind='automation' AND action_json->>'automationId'=$1
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [automationId]
    );
    return rows[0] ? { id: rows[0].id, pausedReason: rows[0].paused_reason } : null;
  }

  /** Publish schedule changes after the owning transaction commits, and re-arm. */
  notifySchedulesChanged(ids: Iterable<string>): void {
    for (const id of ids) emitScheduleChanged(id);
    this.arm();
  }

  /** "Run now" for an automation: one occurrence at now, through the same claim and checks. */
  async runOwnedNow(id: string): Promise<ScheduleRunRecord> {
    const schedule = await this.get(id);
    if (!schedule || schedule.actionKind !== 'automation') {
      throw new Error(`Schedule not found: ${id}`);
    }
    return this.executeClaimed(schedule, new Date(), false);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // The start and each system wake are activations: a wake ticks at once
    // (first-open wakes run then), and automation runs soon after either wait
    // for the network (networkGuard).
    systemWakeMonitor.start();
    this.offWake = systemWakeMonitor.onWake(() => this.arm(0));
    void getDb()
      .query(
        `UPDATE schedule_runs SET status='failed', error='Snaglet stopped during this run', finished_at=now()
          WHERE status='running'`
      )
      .catch((err) =>
        logger.warn(`[schedules] interrupted-run cleanup failed: ${getErrorMessage(err)}`)
      )
      // Each automation owns exactly one schedule; repair drift before the
      // first tick (a missing schedule, a stale enabled flag, an orphan).
      .then(async () => (await automations()).reconcile())
      .catch((err) =>
        logger.warn(`[schedules] automation reconcile failed: ${getErrorMessage(err)}`)
      )
      .finally(() => this.arm(0));
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.offWake?.();
    this.offWake = null;
    systemWakeMonitor.stop();
  }

  /** Check a defineHook({ schedule }) declaration before it is stored. */
  private validate(input: SaveScheduleInput): void {
    if (!input.name?.trim()) throw new Error('Schedule name is required');
    if (!input.timezone?.trim()) throw new Error('Timezone is required');
    calculateNextRun(input);
    if (typeof (input.action as HookScheduleAction).hookName !== 'string') {
      throw new Error('Hook schedules require hookName');
    }
  }

  private arm(delay?: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay ?? 250);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.ticking) return this.arm(MAX_TIMER_DELAY_MS);
    this.ticking = true;
    // This timer and the wake heartbeat both stood still while the machine
    // slept; whichever runs first after a wake notices it.
    systemWakeMonitor.check();
    try {
      const { rows } = await getDb().query<ScheduleRawRow>(
        `SELECT * FROM schedules
          WHERE enabled=true AND next_run_at IS NOT NULL AND next_run_at <= now()
            AND (
              action_kind <> 'hook' OR EXISTS (
                SELECT 1 FROM hook_registrations hr
                WHERE hr.name = schedules.action_json->>'hookName'
                  AND hr.enabled = true AND hr.build_status = 'ready'
              )
            )
          ORDER BY next_run_at ASC LIMIT 20`
      );
      for (const row of rows) {
        const schedule = mapSchedule(row);
        if (schedule.scheduleKind === 'first_open') {
          const at = await this.firstOpenDue(schedule);
          if (at) await this.executeClaimed(schedule, at, true);
          continue;
        }
        const scheduledFor = new Date(schedule.nextRunAt!);
        await this.executeClaimed(schedule, scheduledFor, true);
      }
    } catch (err) {
      logger.error(`[schedules] tick failed: ${getErrorMessage(err)}`);
    } finally {
      this.ticking = false;
      // Always re-arm: a failed next-run lookup must not stop every schedule
      // until restart. Fall back to the max poll delay and try again then.
      let next = Date.now() + MAX_TIMER_DELAY_MS;
      try {
        const { rows } = await getDb().query<{ next_run_at: string | null }>(
          `SELECT MIN(next_run_at) AS next_run_at FROM schedules
            WHERE enabled=true AND next_run_at IS NOT NULL
              AND (
                action_kind <> 'hook' OR EXISTS (
                  SELECT 1 FROM hook_registrations hr
                  WHERE hr.name = schedules.action_json->>'hookName'
                    AND hr.enabled = true AND hr.build_status = 'ready'
                )
              )`
        );
        if (rows[0]?.next_run_at) next = new Date(rows[0].next_run_at).getTime();
      } catch (err) {
        logger.error(`[schedules] next-run lookup failed: ${getErrorMessage(err)}`);
      }
      this.arm(Math.max(250, Math.min(MAX_TIMER_DELAY_MS, next - Date.now())));
    }
  }

  private async executeClaimed(
    schedule: ScheduleRecord,
    scheduledFor: Date,
    advance: boolean
  ): Promise<ScheduleRunRecord> {
    const db = getDb();
    const runId = generateId('schedule_run');
    const automationId =
      schedule.actionKind === 'automation'
        ? (schedule.action as AutomationScheduleAction).automationId
        : null;
    // Missed-run rule, automations only: a wake more than the grace
    // late (Snaglet was off) is skipped and the schedule moves past now. A
    // first-open wake is claimed for today's `after` and may run any time
    // that day, so it is never missed.
    if (advance && automationId && schedule.scheduleKind !== 'first_open') {
      const missed = await this.skipIfMissed(schedule, scheduledFor, runId, automationId);
      if (missed) return missed;
    }
    const { rows: activeRows } = await db.query<ScheduleRunRawRow>(
      `SELECT * FROM schedule_runs WHERE schedule_id=$1 AND status='running' LIMIT 1`,
      [schedule.id]
    );
    if (activeRows[0] && advance && schedule.scheduleKind === 'first_open') {
      // A Run now pressed before `after` is still going: look again shortly,
      // writing nothing, so it does not use up the day.
      await this.moveNextRun(schedule, new Date(Date.now() + FIRST_OPEN_BUSY_RETRY_MS));
      emitScheduleChanged(schedule.id);
      return mapRun(activeRows[0]);
    }
    if (activeRows[0]) {
      const message = automationId ? PREVIOUS_RUN_GOING : 'Previous occurrence is still running';
      const { rows } = await db.query<ScheduleRunRawRow>(
        `INSERT INTO schedule_runs
           (id, schedule_id, scheduled_for, status, error, finished_at, manual)
         VALUES ($1,$2,$3,'skipped',$4,now(),$5)
         ON CONFLICT (schedule_id, scheduled_for) DO UPDATE
           SET status='skipped', error=EXCLUDED.error, finished_at=now()
         RETURNING *`,
        [runId, schedule.id, scheduledFor.toISOString(), message, !advance]
      );
      if (advance) {
        const next =
          schedule.scheduleKind === 'once'
            ? null
            : calculateNextRun(schedule, new Date(Math.max(Date.now(), scheduledFor.getTime())));
        await db.query(
          `UPDATE schedules SET ${ADVANCE_SET}, last_run_at=now(),
             last_status='skipped', updated_at=now() WHERE id=$1`,
          [
            schedule.id,
            schedule.scheduleKind === 'once' ? false : schedule.enabled,
            next?.toISOString() ?? null,
          ]
        );
        if (automationId && next === null) await (await automations()).markFinished(automationId);
      }
      emitScheduleChanged(schedule.id);
      return mapRun(rows[0]);
    }
    // `manual`: a person's or an agent's Run now, recorded at the claim.
    const { rows: claimed } = await db.query<ScheduleRunRawRow>(
      `INSERT INTO schedule_runs (id, schedule_id, scheduled_for, status, manual)
       VALUES ($1,$2,$3,'running',$4)
       ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
       RETURNING *`,
      [runId, schedule.id, scheduledFor.toISOString(), !advance]
    );
    if (!claimed[0]) {
      const existing = await this.listRuns(schedule.id, 100);
      const match = existing.find(
        (run) => new Date(run.scheduledFor).getTime() === scheduledFor.getTime()
      );
      if (!match) throw new Error('Schedule occurrence was already claimed');
      return match;
    }

    let next: Date | null = null;
    if (advance) {
      next =
        schedule.scheduleKind === 'once'
          ? null
          : calculateNextRun(schedule, new Date(Math.max(Date.now(), scheduledFor.getTime())));
      await db.query(`UPDATE schedules SET ${ADVANCE_SET}, updated_at=now() WHERE id=$1`, [
        schedule.id,
        schedule.scheduleKind === 'once' ? false : schedule.enabled,
        next?.toISOString() ?? null,
      ]);
    }

    let output = '';
    let error: string | null = null;
    let skipped = false;
    try {
      output = await this.executeAction(schedule, runId, scheduledFor, advance);
    } catch (err) {
      // A network that never came back is not the automation's failure: the
      // run is skipped, and never counts toward a failure streak or a day.
      skipped = err instanceof ScheduleRunSkipped || err instanceof NetworkNotReadyError;
      error = getErrorMessage(err);
    }
    if (
      skipped &&
      error === PREVIOUS_RUN_GOING &&
      advance &&
      schedule.scheduleKind === 'first_open'
    ) {
      // The wake of a Run now is still going: give the day's claim back and
      // look again shortly.
      const { rows: released } = await db.query<ScheduleRunRawRow>(
        `DELETE FROM schedule_runs WHERE id=$1 RETURNING *`,
        [runId]
      );
      await this.moveNextRun(schedule, new Date(Date.now() + FIRST_OPEN_BUSY_RETRY_MS));
      emitScheduleChanged(schedule.id);
      return mapRun(released[0] ?? claimed[0]);
    }
    const status = skipped ? 'skipped' : error ? 'failed' : 'succeeded';
    // `status='running'`: an automation's wake can fail (and mark this run
    // failed) before this line; that later verdict wins.
    const { rows: finished } = await db.query<ScheduleRunRawRow>(
      `UPDATE schedule_runs SET status=$2, output=$3, error=$4, finished_at=now()
        WHERE id=$1 AND status='running' RETURNING *`,
      [runId, status, output.slice(0, 100_000), error]
    );
    const run =
      finished[0] ??
      (await db.query<ScheduleRunRawRow>(`SELECT * FROM schedule_runs WHERE id=$1`, [runId]))
        .rows[0]!;
    await db.query(
      `UPDATE schedules SET last_run_at=now(), last_status=$2, updated_at=now() WHERE id=$1`,
      [schedule.id, run.status]
    );
    if (advance && automationId && next === null) {
      await (await automations()).markFinished(automationId);
    }
    emitScheduleChanged(schedule.id);
    return mapRun(run);
  }

  /**
   * A due first-open schedule at this tick: today's `after` instant to
   * claim it for when it runs now, else null once its next run has moved.
   * It runs when it is at or after today's `after`, it has not run today, the
   * computer is fully awake (not a Power Nap dark wake: {@link systemAwake})
   * and the agent's provider answers ({@link NetworkGuard.check}, which never
   * blocks the tick). Before `after` it moves to today's; once it ran, to
   * tomorrow's; in a dark wake or while the network is not ready it looks again
   * shortly, writing no run, until local midnight ends the day. Its runs that
   * day are the ledger: any but a Run now (`manual`) or a skipped one, and any
   * run at today's `after` (the claim key, so two servers on one database
   * cannot both run it). A day it never ran is not caught up.
   */
  private async firstOpenDue(schedule: ScheduleRecord): Promise<Date | null> {
    const now = new Date();
    const config = schedule.schedule as FirstOpenScheduleConfig;
    const { start, end } = localDayBounds(now, schedule.timezone);
    const slot = firstOpenSlot(config.after, schedule.timezone, now);
    const db = getDb();
    const { rows } = await db.query<{ ran: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM schedule_runs
          WHERE schedule_id = $1 AND NOT manual
            AND scheduled_for >= $2 AND scheduled_for < $3
            AND (status <> 'skipped' OR scheduled_for = $4)
       ) AS ran`,
      [schedule.id, start.toISOString(), end.toISOString(), slot.toISOString()]
    );
    const verdict = firstOpenTick(config.after, schedule.timezone, now, rows[0]?.ran === true);
    if (!verdict.run) {
      await this.moveNextRun(schedule, verdict.nextRunAt);
      emitScheduleChanged(schedule.id);
      return null;
    }
    if (!(await systemAwake.isFullWake())) {
      await this.moveNextRun(schedule, new Date(now.getTime() + FIRST_OPEN_DARK_WAKE_RETRY_MS));
      return null;
    }
    const network = await this.firstOpenNetwork(schedule);
    if (network !== 'ready') {
      const retry =
        network === 'waiting'
          ? FIRST_OPEN_NETWORK_WAITING_RETRY_MS
          : FIRST_OPEN_NETWORK_DOWN_RETRY_MS;
      await this.moveNextRun(schedule, new Date(now.getTime() + retry));
      return null;
    }
    return verdict.slot;
  }

  /** The network guard's answer for a first-open wake's agent, without blocking. */
  private async firstOpenNetwork(schedule: ScheduleRecord): Promise<NetworkCheck> {
    const { automationId } = schedule.action as AutomationScheduleAction;
    const row = await Automations.findById(automationId);
    const host = row ? await probeHostForAgent(row.agentId) : null;
    return networkGuard.check(host, systemWakeMonitor.lastActivation());
  }

  /** Move a schedule's next run (it stays off when it was turned off meanwhile). */
  private async moveNextRun(schedule: ScheduleRecord, next: Date): Promise<void> {
    await getDb().query(`UPDATE schedules SET ${ADVANCE_SET}, updated_at=now() WHERE id=$1`, [
      schedule.id,
      schedule.enabled,
      next.toISOString(),
    ]);
  }

  /**
   * A scheduled automation wake due within {@link NETWORK_GUARD_WINDOW_MS} of
   * the server start or a system wake waits until its agent's provider host
   * answers (networkGuard); one that never does throws "Network not ready",
   * and the run is logged skipped with it. A person's Run now does not wait.
   */
  private async networkReady(automationId: string): Promise<void> {
    systemWakeMonitor.check();
    const activation = systemWakeMonitor.lastActivation();
    if (!activation || Date.now() - activation.at > NETWORK_GUARD_WINDOW_MS) return;
    const row = await Automations.findById(automationId);
    const host = row ? await probeHostForAgent(row.agentId) : null;
    await networkGuard.ready(host, activation);
  }

  /**
   * The missed-run rule: an automation wake older than the grace (60
   * minutes by default) is logged `skipped` ("Missed while Snaglet was off") and
   * the schedule moves to its next wake after now; a missed once finishes
   * its automation and notifies. A windowed interval runs only inside
   * its window, so a wake more than a timer period late whose window has
   * closed since is skipped the same way ({@link WINDOW_CLOSED_SKIP}). Null
   * when the wake may still run.
   */
  private async skipIfMissed(
    schedule: ScheduleRecord,
    scheduledFor: Date,
    runId: string,
    automationId: string
  ): Promise<ScheduleRunRecord | null> {
    const service = await automations();
    const now = new Date();
    const lateMs = now.getTime() - scheduledFor.getTime();
    const missed = lateMs > (await service.missedGraceMs());
    const windowClosed =
      !missed && lateMs > MAX_TIMER_DELAY_MS && intervalWindowClosed(schedule, now);
    if (!missed && !windowClosed) return null;
    const db = getDb();
    const { rows } = await db.query<ScheduleRunRawRow>(
      `INSERT INTO schedule_runs (id, schedule_id, scheduled_for, status, error, finished_at)
       VALUES ($1,$2,$3,'skipped',$4,now())
       ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
       RETURNING *`,
      [
        runId,
        schedule.id,
        scheduledFor.toISOString(),
        missed ? 'Missed while Snaglet was off' : WINDOW_CLOSED_SKIP,
      ]
    );
    const once = schedule.scheduleKind === 'once';
    const next = once ? null : calculateNextRun(schedule, new Date());
    await db.query(
      `UPDATE schedules SET ${ADVANCE_SET}, last_run_at=now(),
         last_status='skipped', updated_at=now() WHERE id=$1`,
      [schedule.id, once ? false : schedule.enabled, next?.toISOString() ?? null]
    );
    await service.onMissed(automationId, { scheduledFor, finished: next === null, once });
    emitScheduleChanged(schedule.id);
    const run =
      rows[0] ??
      (
        await db.query<ScheduleRunRawRow>(
          `SELECT * FROM schedule_runs WHERE schedule_id=$1 AND scheduled_for=$2`,
          [schedule.id, scheduledFor.toISOString()]
        )
      ).rows[0]!;
    return mapRun(run);
  }

  private async executeAction(
    schedule: ScheduleRecord,
    runId: string,
    scheduledFor: Date,
    advance: boolean
  ): Promise<string> {
    if (schedule.actionKind === 'automation') {
      // Reads the automation row at fire time; throws ScheduleRunSkipped when
      // it is paused or its previous wake is still going.
      const action = schedule.action as AutomationScheduleAction;
      // A first-open wake checked the network before it was claimed.
      if (advance && schedule.scheduleKind !== 'first_open') {
        await this.networkReady(action.automationId);
      }
      return (await automations()).fire(action.automationId, {
        scheduleRunId: runId,
        scheduledFor,
        manual: !advance,
      });
    }
    const action = schedule.action as HookScheduleAction;
    const result = await getHookRegistry().runAutomatic({
      hookName: action.hookName,
      eventName: 'schedule:fire',
      event: {
        ...(action.event ?? {}),
        scheduleId: schedule.id,
        runId,
        scheduledFor: scheduledFor.toISOString(),
        ...(action.agentId ? { agentId: action.agentId } : {}),
        ...(action.threadId ? { threadId: action.threadId } : {}),
      },
      context: { agentId: action.agentId, threadId: action.threadId },
    });
    if (!result.ok) throw new Error(result.stderr || `Hook exited ${result.exitCode}`);
    return result.stdout;
  }
}

export const scheduleService = new ScheduleServiceClass();
