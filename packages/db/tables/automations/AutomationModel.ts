/**
 * Automations: one row per scheduled agent wake. Plain SQL over a
 * runner so every write can share the caller's transaction; the server's
 * AutomationService is the only writer and keeps each non-canceled row's
 * owned `schedules` row in step in the same transaction.
 *
 * A canceled (deleted, archived) row is never written until it is restored
 * or purged, so its `updated_at` is when it was deleted: the Archive drawer
 * shows it as the archive time.
 */
import { getDb, type DbQueryable } from '@snaglet/db/db';
import type {
  AutomationPausedReason,
  AutomationStatus,
  AutomationWhen,
  AutomationWhenKind,
  ScheduleRunStatus,
  UnattendedPolicy,
} from '@snaglet/shared/types';

export interface AutomationRow {
  id: string;
  name: string;
  prompt: string;
  status: AutomationStatus;
  whenKind: AutomationWhenKind;
  /** once: ISO instant. */
  at: string | null;
  rrule: string | null;
  /** repeat: its time of day; first_open: the earliest time it runs. HH:mm in tz. */
  timeOfDay: string | null;
  startsOn: string | null;
  everyMs: number | null;
  /** interval: the daily window, HH:mm in tz; both or neither. */
  windowStart: string | null;
  windowEnd: string | null;
  tz: string;
  calendarId: string | null;
  threadId: string;
  agentId: string;
  scheduleId: string | null;
  createdByAgentId: string | null;
  createdByMemberId: string | null;
  consecutiveFailures: number;
  pausedReason: AutomationPausedReason | null;
  createdRunId: string | null;
  /** What its runs do with a tool call that would ask. */
  unattendedPolicy: UnattendedPolicy;
  createdAt: string;
  updatedAt: string;
}

/** A row plus the names and schedule state a list shows. */
export interface AutomationListRow extends AutomationRow {
  agentName: string | null;
  threadTitle: string | null;
  calendarTitle: string | null;
  nextRunAt: string | null;
  /** interval: the owned schedule's anchor (ISO instant), null when none. */
  anchor: string | null;
  lastRun: {
    status: ScheduleRunStatus;
    scheduledFor: string;
    finishedAt: string | null;
    error: string | null;
  } | null;
}

interface RawAutomation {
  id: string;
  name: string;
  prompt: string;
  status: AutomationStatus;
  when_kind: AutomationWhenKind;
  at: string | null;
  rrule: string | null;
  time_of_day: string | null;
  starts_on: string | null;
  every_ms: number | null;
  window_start: string | null;
  window_end: string | null;
  tz: string;
  calendar_id: string | null;
  thread_id: string;
  agent_id: string;
  schedule_id: string | null;
  created_by_agent_id: string | null;
  created_by_member_id: string | null;
  consecutive_failures: number;
  paused_reason: AutomationPausedReason | null;
  created_run_id: string | null;
  unattended_policy: UnattendedPolicy;
  created_at: string;
  updated_at: string;
}

interface RawListAutomation extends RawAutomation {
  agent_name: string | null;
  thread_title: string | null;
  calendar_title: string | null;
  next_run_at: string | null;
  anchor: string | null;
  last_status: ScheduleRunStatus | null;
  last_scheduled_for: string | null;
  last_finished_at: string | null;
  last_error: string | null;
}

const isoExpr = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const iso = (column: string, as = column.replace(/^\w+\./, '')) => `${isoExpr(column)} AS ${as}`;

const COLUMNS = `a.id, a.name, a.prompt, a.status, a.when_kind, ${iso('a.at')}, a.rrule,
  a.time_of_day, a.starts_on::text AS starts_on, a.every_ms::float8 AS every_ms,
  a.window_start, a.window_end, a.tz,
  a.calendar_id, a.thread_id, a.agent_id, a.schedule_id, a.created_by_agent_id,
  a.created_by_member_id, a.consecutive_failures, a.paused_reason, a.created_run_id,
  a.unattended_policy, ${iso('a.created_at')}, ${iso('a.updated_at')}`;

const ISO_INSTANT_RE = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`;

/** When a posted wake (its seed message) was due. */
const WAKE_SCHEDULED_FOR = `CASE WHEN m.metadata->'automation'->>'scheduledFor' ~ '${ISO_INSTANT_RE}'
    THEN (m.metadata->'automation'->>'scheduledFor')::timestamptz
    ELSE m.created_at END`;

/** Full precision, for a page cursor (the ISO columns stop at milliseconds). */
const cursorExpr = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The schedules whose runs are an automation's runs: the one it owns and, once
 * it is deleted, the one it keeps (unlinked, so found by its action).
 */
const runSchedulesOf = (automationId: string) =>
  `SELECT os.id FROM public.schedules os
    WHERE os.action_kind = 'automation' AND os.action_json->>'automationId' = ${automationId}`;

// The last run is the newest of the automation's schedule runs. With no
// schedule run at all (its schedule was lost, and a restore or the boot repair
// made a new one) it is the newest wake the automation posted: its seed
// message keeps `metadata.automation` ({id, scheduledFor}) in the thread. A
// posted wake reads as succeeded, as its schedule run did once the prompt was
// posted. The run log (`listRuns`) reads the same two sources the same way.
const LIST_FROM = `FROM public.automations a
  LEFT JOIN public.agents ag ON ag.id = a.agent_id
  LEFT JOIN public.threads t ON t.id = a.thread_id
  LEFT JOIN public.calendars c ON c.id = a.calendar_id
  LEFT JOIN public.schedules s ON s.id = a.schedule_id
  LEFT JOIN LATERAL (
    SELECT r.status, r.scheduled_for, r.finished_at, r.error
      FROM public.schedule_runs r
     WHERE r.schedule_id IN (${runSchedulesOf('a.id')})
     ORDER BY r.started_at DESC, r.id DESC
     LIMIT 1
  ) lr ON true
  LEFT JOIN LATERAL (
    SELECT 'succeeded'::text AS status,
           ${WAKE_SCHEDULED_FOR} AS scheduled_for,
           m.created_at AS finished_at
      FROM public.messages m
     WHERE lr.status IS NULL
       AND m.thread_id = a.thread_id
       AND m.metadata->'automation'->>'id' = a.id
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 1
  ) lw ON true`;

const LIST_COLUMNS = `${COLUMNS}, ag.name AS agent_name, t.title AS thread_title,
  c.title AS calendar_title,
  CASE WHEN s.enabled THEN ${isoExpr('s.next_run_at')} END AS next_run_at,
  CASE WHEN a.when_kind = 'interval' THEN s.schedule_json->>'anchor' END AS anchor,
  COALESCE(lr.status, lw.status) AS last_status,
  ${iso('COALESCE(lr.scheduled_for, lw.scheduled_for)', 'last_scheduled_for')},
  ${iso('COALESCE(lr.finished_at, lw.finished_at)', 'last_finished_at')},
  lr.error AS last_error`;

function toRow(raw: RawAutomation): AutomationRow {
  return {
    id: raw.id,
    name: raw.name,
    prompt: raw.prompt,
    status: raw.status,
    whenKind: raw.when_kind,
    at: raw.at,
    rrule: raw.rrule,
    timeOfDay: raw.time_of_day,
    startsOn: raw.starts_on,
    everyMs: raw.every_ms === null ? null : Number(raw.every_ms),
    windowStart: raw.window_start,
    windowEnd: raw.window_end,
    tz: raw.tz,
    calendarId: raw.calendar_id,
    threadId: raw.thread_id,
    agentId: raw.agent_id,
    scheduleId: raw.schedule_id,
    createdByAgentId: raw.created_by_agent_id,
    createdByMemberId: raw.created_by_member_id,
    consecutiveFailures: Number(raw.consecutive_failures),
    pausedReason: raw.paused_reason,
    createdRunId: raw.created_run_id,
    unattendedPolicy: raw.unattended_policy,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toListRow(raw: RawListAutomation): AutomationListRow {
  return {
    ...toRow(raw),
    agentName: raw.agent_name,
    threadTitle: raw.thread_title,
    calendarTitle: raw.calendar_title,
    nextRunAt: raw.next_run_at,
    anchor: raw.anchor,
    lastRun:
      raw.last_status && raw.last_scheduled_for
        ? {
            status: raw.last_status,
            scheduledFor: raw.last_scheduled_for,
            finishedAt: raw.last_finished_at,
            error: raw.last_error,
          }
        : null,
  };
}

/** The stored timing of a row. */
export function automationWhen(row: AutomationRow): AutomationWhen {
  if (row.whenKind === 'once') return { kind: 'once', at: row.at!, tz: row.tz };
  if (row.whenKind === 'first_open')
    return { kind: 'first_open', after: row.timeOfDay!, tz: row.tz };
  if (row.whenKind === 'repeat') {
    return {
      kind: 'repeat',
      rrule: row.rrule!,
      timeOfDay: row.timeOfDay!,
      startsOn: row.startsOn!,
      tz: row.tz,
    };
  }
  return {
    kind: 'interval',
    everyMs: row.everyMs!,
    tz: row.tz,
    ...(row.windowStart && row.windowEnd
      ? { windowStart: row.windowStart, windowEnd: row.windowEnd }
      : {}),
  };
}

/** The timing columns for a `when`, in {@link WHEN_COLUMN_NAMES} order. */
function whenColumns(when: AutomationWhen): unknown[] {
  const interval = when.kind === 'interval' ? when : null;
  return [
    when.kind,
    when.kind === 'once' ? when.at : null,
    when.kind === 'repeat' ? when.rrule : null,
    when.kind === 'repeat' ? when.timeOfDay : when.kind === 'first_open' ? when.after : null,
    when.kind === 'repeat' ? when.startsOn : null,
    interval ? interval.everyMs : null,
    interval?.windowStart && interval.windowEnd ? interval.windowStart : null,
    interval?.windowStart && interval.windowEnd ? interval.windowEnd : null,
    when.tz,
  ];
}

const WHEN_COLUMN_NAMES = [
  'when_kind',
  'at',
  'rrule',
  'time_of_day',
  'starts_on',
  'every_ms',
  'window_start',
  'window_end',
  'tz',
] as const;

/** One run in an automation's log, plus its page cursor position. */
export interface AutomationRunRow {
  id: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  status: ScheduleRunStatus;
  error: string | null;
  manual: boolean;
  /** The start time at full precision; with `id`, the row's place in the log. */
  cursorAt: string;
}

interface RawRun {
  id: string;
  scheduled_for: string;
  started_at: string;
  finished_at: string | null;
  status: ScheduleRunStatus;
  error: string | null;
  manual: boolean;
  cursor_at: string;
}

function toRunRow(raw: RawRun): AutomationRunRow {
  return {
    id: raw.id,
    scheduledFor: raw.scheduled_for,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    status: raw.status,
    error: raw.error,
    manual: raw.manual === true,
    cursorAt: raw.cursor_at,
  };
}

export interface ListAutomationRunsOptions {
  limit: number;
  /** Only rows older than this place in the log (a previous page's last row). */
  before?: { at: string; id: string } | null;
}

export interface InsertAutomationInput {
  id: string;
  name: string;
  prompt: string;
  when: AutomationWhen;
  calendarId: string | null;
  threadId: string;
  agentId: string;
  /** Null until its schedule is written and linked (the link is a foreign key). */
  scheduleId: string | null;
  createdByAgentId: string | null;
  createdByMemberId: string | null;
  createdRunId: string | null;
  /** Omitted = the column default, `skip`. */
  unattendedPolicy?: UnattendedPolicy;
}

export interface AutomationPatch {
  name?: string;
  prompt?: string;
  when?: AutomationWhen;
  calendarId?: string | null;
  status?: AutomationStatus;
  pausedReason?: AutomationPausedReason | null;
  scheduleId?: string | null;
  consecutiveFailures?: number;
  unattendedPolicy?: UnattendedPolicy;
}

export interface ListAutomationsOptions {
  /** Omit for every status. */
  statuses?: readonly AutomationStatus[];
  createdByAgentId?: string;
  agentId?: string;
  calendarIds?: readonly string[];
  whenKinds?: readonly AutomationWhenKind[];
  ids?: readonly string[];
}

export const Automations = {
  async findById(id: string, runner: DbQueryable = getDb()): Promise<AutomationRow | null> {
    const { rows } = await runner.query<RawAutomation>(
      `SELECT ${COLUMNS} FROM public.automations a WHERE a.id = $1`,
      [id]
    );
    return rows[0] ? toRow(rows[0]) : null;
  },

  /** The row, locked for the rest of the transaction. */
  async lockById(id: string, tx: DbQueryable): Promise<AutomationRow | null> {
    const { rows } = await tx.query<RawAutomation>(
      `SELECT ${COLUMNS} FROM public.automations a WHERE a.id = $1 FOR UPDATE`,
      [id]
    );
    return rows[0] ? toRow(rows[0]) : null;
  },

  /** Serializes quota checks for one agent (locks its agents row). */
  async lockAgent(agentId: string, tx: DbQueryable): Promise<boolean> {
    const { rows } = await tx.query(`SELECT id FROM public.agents WHERE id = $1 FOR UPDATE`, [
      agentId,
    ]);
    return rows.length === 1;
  },

  async countActiveForAgent(agentId: string, runner: DbQueryable): Promise<number> {
    const { rows } = await runner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.automations WHERE agent_id = $1 AND status = 'active'`,
      [agentId]
    );
    return rows[0]?.n ?? 0;
  },

  async countCreatedInRun(runId: string, runner: DbQueryable): Promise<number> {
    const { rows } = await runner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.automations WHERE created_run_id = $1`,
      [runId]
    );
    return rows[0]?.n ?? 0;
  },

  async insert(input: InsertAutomationInput, tx: DbQueryable): Promise<AutomationRow> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO public.automations
         (id, name, prompt, ${WHEN_COLUMN_NAMES.join(', ')},
          calendar_id, thread_id, agent_id, schedule_id, created_by_agent_id,
          created_by_member_id, created_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19)
       RETURNING id`,
      [
        input.id,
        input.name,
        input.prompt,
        ...whenColumns(input.when),
        input.calendarId,
        input.threadId,
        input.agentId,
        input.scheduleId,
        input.createdByAgentId,
        input.createdByMemberId,
        input.createdRunId,
      ]
    );
    const id = rows[0]!.id;
    // Only a person sets it (AutomationService); otherwise the column default, `skip`.
    if (input.unattendedPolicy !== undefined) {
      await tx.query('UPDATE public.automations SET unattended_policy = $2 WHERE id = $1', [
        id,
        input.unattendedPolicy,
      ]);
    }
    return (await Automations.findById(id, tx))!;
  },

  async update(id: string, patch: AutomationPatch, tx: DbQueryable): Promise<AutomationRow> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.prompt !== undefined) set('prompt', patch.prompt);
    if (patch.when !== undefined) {
      const values = whenColumns(patch.when);
      WHEN_COLUMN_NAMES.forEach((column, i) => set(column, values[i]));
    }
    if (patch.calendarId !== undefined) set('calendar_id', patch.calendarId);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.pausedReason !== undefined) set('paused_reason', patch.pausedReason);
    if (patch.scheduleId !== undefined) set('schedule_id', patch.scheduleId);
    if (patch.consecutiveFailures !== undefined)
      set('consecutive_failures', patch.consecutiveFailures);
    if (patch.unattendedPolicy !== undefined) set('unattended_policy', patch.unattendedPolicy);
    sets.push('updated_at = now()');
    await tx.query(`UPDATE public.automations SET ${sets.join(', ')} WHERE id = $1`, params);
    return (await Automations.findById(id, tx))!;
  },

  /** Rows with their agent, thread, calendar, next run and last run, newest first. */
  async list(
    options: ListAutomationsOptions = {},
    runner: DbQueryable = getDb()
  ): Promise<AutomationListRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };
    if (options.statuses) add((n) => `a.status = ANY($${n}::text[])`, [...options.statuses]);
    if (options.createdByAgentId)
      add((n) => `a.created_by_agent_id = $${n}`, options.createdByAgentId);
    if (options.agentId) add((n) => `a.agent_id = $${n}`, options.agentId);
    if (options.calendarIds)
      add((n) => `a.calendar_id = ANY($${n}::text[])`, [...options.calendarIds]);
    if (options.whenKinds) add((n) => `a.when_kind = ANY($${n}::text[])`, [...options.whenKinds]);
    if (options.ids) add((n) => `a.id = ANY($${n}::text[])`, [...options.ids]);
    const { rows } = await runner.query<RawListAutomation>(
      `SELECT ${LIST_COLUMNS} ${LIST_FROM}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.created_at DESC, a.id DESC`,
      params
    );
    return rows.map(toListRow);
  },

  /**
   * An automation's run log, newest first by start: the runs of every
   * schedule it owns or kept. With no schedule run at all, the wakes it
   * posted in its thread (as `succeeded`), as its last run reads them.
   */
  async listRuns(
    automationId: string,
    options: ListAutomationRunsOptions,
    runner: DbQueryable = getDb()
  ): Promise<AutomationRunRow[]> {
    const before = options.before ?? null;
    const params = [automationId, before?.at ?? null, before?.id ?? null, options.limit];
    const { rows } = await runner.query<RawRun>(
      `SELECT r.id, ${iso('r.scheduled_for')}, ${iso('r.started_at')}, ${iso('r.finished_at')},
              r.status, r.error, r.manual,
              ${cursorExpr('r.started_at')} AS cursor_at
         FROM public.schedule_runs r
        WHERE r.schedule_id IN (${runSchedulesOf('$1')})
          AND ($2::timestamptz IS NULL OR (r.started_at, r.id) < ($2::timestamptz, $3::text))
        ORDER BY r.started_at DESC, r.id DESC
        LIMIT $4`,
      params
    );
    if (rows.length) return rows.map(toRunRow);
    const { rows: logged } = await runner.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM public.schedule_runs r
                       WHERE r.schedule_id IN (${runSchedulesOf('$1')})) AS found`,
      [automationId]
    );
    if (logged[0]?.found) return [];
    const { rows: wakes } = await runner.query<RawRun>(
      `SELECT m.id, ${iso(WAKE_SCHEDULED_FOR, 'scheduled_for')}, ${iso('m.created_at', 'started_at')},
              ${iso('m.created_at', 'finished_at')}, 'succeeded' AS status, NULL AS error,
              false AS manual, ${cursorExpr('m.created_at')} AS cursor_at
         FROM public.automations a
         JOIN public.messages m
           ON m.thread_id = a.thread_id AND m.metadata->'automation'->>'id' = a.id
        WHERE a.id = $1
          AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2::timestamptz, $3::text))
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $4`,
      params
    );
    return wakes.map(toRunRow);
  },

  /**
   * The deleted (canceled) rows, the Archive drawer's automations, most
   * recently deleted first (`updated_at`, see the note at the top).
   */
  async listCanceled(runner: DbQueryable = getDb()): Promise<AutomationRow[]> {
    const { rows } = await runner.query<RawAutomation>(
      `SELECT ${COLUMNS} FROM public.automations a
        WHERE a.status = 'cancelled'
        ORDER BY a.updated_at DESC, a.id`
    );
    return rows.map(toRow);
  },

  /**
   * Delete a row for good inside `tx`, with every schedule it owns or kept
   * (their runs go with them, ON DELETE CASCADE) and its reminder settings
   * (by cascade). The wakes it posted stay in its thread. Returns the ids
   * of the schedules removed.
   */
  async purge(id: string, tx: DbQueryable): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `DELETE FROM public.schedules
        WHERE action_kind = 'automation' AND action_json->>'automationId' = $1
        RETURNING id`,
      [id]
    );
    await tx.query(`DELETE FROM public.automations WHERE id = $1`, [id]);
    return rows.map((row) => row.id);
  },

  /** Every row that should own a schedule (all but canceled). */
  async listNonCanceled(runner: DbQueryable = getDb()): Promise<AutomationRow[]> {
    const { rows } = await runner.query<RawAutomation>(
      `SELECT ${COLUMNS} FROM public.automations a WHERE a.status <> 'cancelled' ORDER BY a.id`
    );
    return rows.map(toRow);
  },
};
