import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import type {
  AutomationRecord,
  AutomationRunNowResponse,
  AutomationStatus,
} from '@snaglet/shared/types';
import {
  AppError,
  describeAutomationWhen,
  formatAutomationInstant,
  readTrimmedString,
  safeJsonParse,
} from '@snaglet/shared/utils';
import { getCurrentActor } from '@server/realtime/actorContext';
import { getRunContext } from '@server/realtime/runContext';
import {
  AUTOMATED_RUN_NOW_REFUSAL,
  AUTOMATED_RUN_REFUSAL,
  automationService,
  type AutomationActor,
} from '@server/services/automations/AutomationService';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';

type Input = Record<string, unknown>;

/**
 * Who is calling. An agent run (or an agent's hook/tool child) gets the
 * agent rules; a person (the panel acting as an agent, the CLI, an external
 * client) may set any thread and agent. An external MCP client (the gateway
 * runs it as the ambient `external` actor) is a person held to the agent
 * limits on Run now and the Every floor.
 */
export function automationActor(context: ToolHandlerContext | undefined): AutomationActor {
  if (context?.agentId && !context.bypassToolAccess) {
    const run = getRunContext();
    return {
      kind: 'agent',
      agentId: context.agentId,
      threadId: context.threadId ?? run?.threadId ?? null,
      runId: run?.runId ?? null,
      ...(context.wakeOrigin ? { wakeOrigin: context.wakeOrigin } : {}),
    };
  }
  return getCurrentActor()?.actorKind === 'external'
    ? { kind: 'person', external: true }
    : { kind: 'person' };
}

/**
 * The next run in the automation's zone. A first-open one has no fixed time:
 * it says so, with the earliest it may run.
 */
function nextRunLocal(a: AutomationRecord): string | null {
  if (!a.nextRunAt) return null;
  const at = formatAutomationInstant(a.nextRunAt, a.when.tz);
  return a.when.kind === 'first_open' ? `when Snaglet first opens, from ${at}` : at;
}

/**
 * The automation as the agent reads it. Times carry their zone: `next_run_at`
 * alone is UTC, and an agent reading the hour off it tells the user the wrong
 * time.
 */
function view(a: AutomationRecord) {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    ...(a.pausedReason ? { paused_reason: a.pausedReason } : {}),
    when: describeAutomationWhen(a.when, undefined, { namedZone: true }),
    tz: a.when.tz,
    next_run_at: a.nextRunAt,
    next_run_local: nextRunLocal(a),
    thread_id: a.threadId,
    agent_id: a.agentId,
    calendar_id: a.calendarId,
    ...(a.lastRun
      ? {
          last_run: {
            status: a.lastRun.status,
            at: a.lastRun.scheduledFor,
            ...(a.lastRun.error ? { error: a.lastRun.error } : {}),
          },
        }
      : {}),
    ...(a.consecutiveFailures ? { consecutive_failures: a.consecutiveFailures } : {}),
  };
}

const WHEN_NOT_OBJECT =
  'when must be an object: {"in":"30m"}, {"at":"2026-10-14T09:00"}, {"repeat":"FREQ=DAILY","at":"09:00"} or {"every":"1h"}.';

/**
 * `when` as an object. A JSON string of one (some models send that) is
 * parsed; anything else that is not an object is refused with the shapes,
 * since the timing rules' "exactly one of" error reads as a wrong key.
 */
function readWhen(raw: unknown): Record<string, unknown> {
  const value =
    typeof raw === 'string' && raw.trim().startsWith('{')
      ? safeJsonParse<unknown>(raw.trim(), null)
      : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(WHEN_NOT_OBJECT);
  }
  return value as Record<string, unknown>;
}

function requireId(input: Input): string {
  const id = readTrimmedString(input.id);
  if (!id) throw new Error('id is required.');
  return id;
}

/** Writes are refused in a run an automation started (no self-perpetuating wakes). */
function refuseAutomated(context: ToolHandlerContext | undefined): void {
  if (context?.wakeOrigin) throw new Error(AUTOMATED_RUN_REFUSAL);
}

const LIST_STATUSES = new Set(['active', 'paused', 'finished', 'cancelled', 'all']);

const RUNS_PAGE = 10;
const RUNS_PAGE_MAX = 50;

function runsLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return RUNS_PAGE;
  const limit = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > RUNS_PAGE_MAX) {
    throw new Error(`limit must be a whole number from 1 to ${RUNS_PAGE_MAX}.`);
  }
  return limit;
}

/**
 * What a Run now did, in words. The wake's own text is left out on purpose:
 * agents copy formats they are shown into their replies.
 */
function runNote(
  automation: AutomationRecord,
  run: AutomationRunNowResponse['run'],
  actor: AutomationActor
): string {
  if (run.status === 'skipped') return `Skipped (${run.error ?? 'no reason'}): nothing was posted.`;
  if (run.status === 'failed') return `The wake failed: ${run.error ?? 'unknown error'}.`;
  const thread = `“${automation.threadTitle ?? automation.threadId}”`;
  const yourThread =
    actor.kind === 'agent' &&
    actor.agentId === automation.agentId &&
    actor.threadId === automation.threadId;
  return yourThread
    ? `Posted the wake in ${thread}. You'll get it as a new message once your current run ends; check runs afterward.`
    : `Posted the wake in ${thread} for ${automation.agentName ?? automation.agentId}; check runs afterward.`;
}

const OPS: Record<string, ToolHandler> = {
  async create(input, _settings, context) {
    refuseAutomated(context);
    const actor = automationActor(context);
    const when = readWhen(input.when);
    const automation = await automationService.create(
      {
        name: input.name,
        prompt: input.prompt,
        when,
        calendarId: input.calendar_id,
        threadId:
          input.thread_id ?? (actor.kind === 'agent' ? (actor.threadId ?? undefined) : undefined),
        agentId: input.agent_id ?? (actor.kind === 'agent' ? actor.agentId : undefined),
      },
      actor
    );
    return JSON.stringify({ automation: view(automation), when_input: when });
  },

  async list(input, _settings, context) {
    const actor = automationActor(context);
    const status = input.status === undefined ? 'active' : input.status;
    if (typeof status !== 'string' || !LIST_STATUSES.has(status)) {
      throw new Error('status must be active, paused, finished, cancelled or all.');
    }
    const mine = input.mine !== false;
    const automations = await automationService.list({
      status: status as AutomationStatus | 'all',
      ...(mine && actor.kind === 'agent' ? { agentId: actor.agentId } : {}),
    });
    return JSON.stringify({ automations: automations.map(view) });
  },

  /** Full detail is private to the agent it wakes; people retain the open read path. */
  async get(input, _settings, context) {
    const automation = await automationService.get(requireId(input));
    const actor = automationActor(context);
    if (actor.kind === 'agent' && automation.agentId !== actor.agentId) {
      throw new AppError(
        'You can only read automations that wake you.',
        ErrorCode.FORBIDDEN,
        HTTP_STATUS.FORBIDDEN
      );
    }
    return JSON.stringify({
      automation: {
        ...view(automation),
        prompt: automation.prompt,
        schedule: automation.when,
        agent_name: automation.agentName,
        thread_title: automation.threadTitle,
        schedule_id: automation.scheduleId,
        calendar_title: automation.calendarTitle,
        created_by_agent_id: automation.createdByAgentId,
        created_by_member_id: automation.createdByMemberId,
        created_at: automation.createdAt,
        updated_at: automation.updatedAt,
        paused_reason: automation.pausedReason,
        consecutive_failures: automation.consecutiveFailures,
        running: automation.running,
        running_since: automation.runningSince,
        // Read-only here: only a person sets it (AutomationService).
        unattended_policy: automation.unattendedPolicy,
        last_run: automation.lastRun
          ? {
              status: automation.lastRun.status,
              at: automation.lastRun.scheduledFor,
              finished_at: automation.lastRun.finishedAt,
              error: automation.lastRun.error,
            }
          : null,
      },
    });
  },

  async update(input, _settings, context) {
    refuseAutomated(context);
    const id = requireId(input);
    const when = input.when !== undefined ? readWhen(input.when) : undefined;
    const automation = await automationService.update(
      id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(when ? { when } : {}),
        ...(input.calendar_id !== undefined ? { calendarId: input.calendar_id } : {}),
      },
      automationActor(context)
    );
    return JSON.stringify({
      automation: view(automation),
      ...(when ? { when_input: when } : {}),
    });
  },

  async disable(input, _settings, context) {
    refuseAutomated(context);
    const automation = await automationService.pause(requireId(input), automationActor(context));
    return JSON.stringify({ automation: view(automation) });
  },

  async enable(input, _settings, context) {
    refuseAutomated(context);
    const automation = await automationService.resume(requireId(input), automationActor(context));
    return JSON.stringify({ automation: view(automation) });
  },

  async cancel(input, _settings, context) {
    refuseAutomated(context);
    const automation = await automationService.cancel(requireId(input), automationActor(context));
    return JSON.stringify({ id: automation.id, status: automation.status });
  },

  /** One wake now, to test it; the service holds the agent rules (own, not automated, per hour). */
  async run(input, _settings, context) {
    if (context?.wakeOrigin) throw new Error(AUTOMATED_RUN_NOW_REFUSAL);
    const actor = automationActor(context);
    const { automation, run } = await automationService.runNow(requireId(input), actor);
    return JSON.stringify({
      automation: view(automation),
      run: { status: run.status, ...(run.error ? { error: run.error } : {}) },
      note: runNote(automation, run, actor),
    });
  },

  /** The run log, newest first; readable for any automation, like list with mine false. */
  async runs(input) {
    const id = requireId(input);
    const limit = runsLimit(input.limit);
    const before = readTrimmedString(input.before) || null;
    const automation = await automationService.get(id);
    const page = await automationService.runs(id, { limit, before });
    const tz = automation.when.tz;
    return JSON.stringify({
      id: automation.id,
      name: automation.name,
      tz,
      runs: page.runs.map((run) => ({
        due_at: run.scheduledFor,
        due_local: formatAutomationInstant(run.scheduledFor, tz),
        status: run.status,
        ...(run.error ? { error: run.error } : {}),
        manual: run.manual,
      })),
      next_cursor: page.nextCursor,
    });
  },
};

/** Earlier names for disable / enable, still accepted. */
const OP_ALIASES: Record<string, string> = { pause: 'disable', resume: 'enable' };

/** automation(op): scheduled wakes: create, list, get, update, disable, enable, cancel, run, runs. */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? (OP_ALIASES[input.op] ?? input.op) : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  return handler(input, settings, context);
};

export default tool;
