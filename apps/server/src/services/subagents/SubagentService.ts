/**
 * SubagentService — named helpers an agent starts on a self-contained task: an
 * ordinary agent row (`agents.parent_agent_id`) in a hidden thread
 * (`threads.parent_thread_id`), tracked by a `subagents` row. Start dispatches
 * the brief fire-and-forget (awaiting a nested run can freeze the sender's
 * thread). When the helper goes idle its reply (or a `failed` result) becomes
 * an orchestrator-only thread_event; after the run that saw it, helpers given
 * no other task are removed. Pause keeps a helper, optionally until
 * `resume_at`. See docs/agents.md.
 */
import { randomUUID } from 'node:crypto';
import { Agents, type AgentRow } from '@snaglet/db/tables/agents';
import { Memories } from '@snaglet/db/tables/memories';
import { Messages, type MessageRow } from '@snaglet/db/tables/messages';
import { Nodes, type NodeRunner } from '@snaglet/db/tables/nodes';
import { Runs } from '@snaglet/db/tables/runs';
import { SkillAssignments } from '@snaglet/db/tables/skill_assignments';
import { Subagents, type SubagentRow, type SubagentStatus } from '@snaglet/db/tables/subagents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import {
  agentThreadIds,
  markThreadsRosterChanged,
} from '@server/services/SocketService/dispatch/agentRosterChanges';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Threads } from '@snaglet/db/tables/threads';
import {
  resolveEnabledMcpServers,
  SUBAGENT_RESULT_EVENT_KIND,
  type Actor,
  type SubagentNotice,
  type SubagentResultMetadata,
} from '@snaglet/shared/types';
import { generateId, getErrorMessage, isoNow, isoStamp, sleep } from '@snaglet/shared/utils';
import { getRunContext } from '@server/realtime/runContext';
import { emitThreadDeleted } from '@server/realtime/surfaces/threads';
import { emitSubagentChanged, toSubagentSummary } from '@server/realtime/surfaces/subagents';
import { AbortRunService } from '@server/services/AbortRunService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { resolveThreadRuntimeConfig } from '@server/services/ConfigResolverService';
import { hooks } from '@server/services/HookService';
import { LogsService } from '@server/services/LogsService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { REAPER_STALL_DEFAULT_MS } from '@server/services/RunReaperService';
import { settingsService } from '@server/services/settings';
import { agentSettings } from '@server/services/settings/categories/agent';
import { SkillAssignmentService } from '@server/services/skills/SkillAssignmentService';
import { withReservedThreadTransaction } from '@server/services/ThreadExecutionPurgeService';
import {
  postAgentMessageToThread,
  type PostedMessageDispatch,
} from '@server/services/ThreadDeliveryPolicyService';
import { wsService } from '@server/services/WebSocketService';
import { dispatchToThread } from '@server/services/SocketService/dispatch/dispatchToThread';
import { summarizeError } from '@server/services/SocketService/persistRunErrorMessage';
import {
  forgetMessageInjected,
  noteMessageInjected,
  sawResult,
  takeSeen,
} from './resultVisibility';
import { agentToolAccess, helperToolAccess } from './toolAccess';
import { loadToolNameCatalog } from './helperInheritance';
import { isHelperThread } from './helperVisibility';
import { describeModels, helperModels, helperProviderId, matchModel } from './helperModels';
import { SubagentError } from './errors';
import {
  clearHelperTurnFailure,
  noteHelperTurnFailure,
  takeHelperTurnFailure,
} from './turnFailures';

export { SubagentError } from './errors';
import { describeAbort, helperSystemPrompt, noticeText, resultText } from './subagentText';

const NAME_MAX = 60;
/**
 * Longest standing instructions an orchestrator can give a helper (op:start
 * or op:update `instructions`), the cap on instructions for all agents: the
 * text rides in every one of the helper's system prompts.
 */
export const SUBAGENT_INSTRUCTIONS_MAX_LENGTH = 8000;
/** Wait after a helper run ends before deciding its thread is idle. */
const SETTLE_DELAY_MS = 300;
/** Longest a finished result waits for a busy parent thread before the wake is dropped. */
const PARENT_IDLE_WAIT_MS = 30 * 60_000;
const PARENT_IDLE_POLL_MS = 1_000;
/** After the parent goes idle, time for the last run's end handling to finish. */
const RUN_END_GRACE_MS = 750;
const MAX_WAKES_PER_RESULT = 3;
const SWEEP_INTERVAL_MS = 10 * 60_000;
/** A live helper with no activity this long is removed. */
const IDLE_HELPER_MS = 24 * 60 * 60_000;
const BOOT_RECOVERY_DELAY_MS = 10_000;
/** How long pause and remove wait for the run they stopped to unwind; past it, the run's end finishes them. */
const ACTION_RELEASE_WAIT_MS = 15_000;
/** How often timed pauses are checked for a due resume. */
const RESUME_CHECK_INTERVAL_MS = 60_000;
/** What a helper is told, as its orchestrator, when a timed pause ends or the user resumes it. */
export const SUBAGENT_RESUME_MESSAGE = 'Continue where you left off.';
/** op:wait polls this often; its longest wait stays under the 5 min tool ceiling. */
const WAIT_POLL_MS = 500;
export const SUBAGENT_WAIT_MAX_MS = 4 * 60_000;
/** The sender name a queued mid-run result carries (narration, not a principal). */
const RESULT_SENDER_NAME = 'thread state';

interface StartSubagentInput {
  orchestratorAgentId: string;
  parentThreadId: string;
  name: string;
  /** A model id, `provider:model` id or display name on the orchestrator's provider. */
  model: string;
  brief: string;
  /** Narrows the helper's tools to these ids (never wider than the orchestrator's). */
  tools?: readonly string[] | null;
  /**
   * Standing instructions added to the helper's system prompt, after Snaglet's
   * own helper prompt (its participant addendum in its thread).
   */
  instructions?: string | null;
}

/**
 * Who pauses, resumes or removes a helper. An orchestrator acts only on the
 * helpers it started; the user acts on any.
 */
export type SubagentActor =
  | { kind: 'orchestrator'; agentId: string }
  | { kind: 'user'; userId: string; name: string };

interface PendingPause {
  by: SubagentActor;
  resumeAt: string | null;
}

interface PendingRemoval {
  by: SubagentActor;
}

interface RunEndPayload {
  runId: string;
  agentId?: string;
  threadId?: string;
  status: 'completed' | 'failed' | 'aborted';
}

function normalizeName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw new SubagentError('name is required.');
  if (name.length > NAME_MAX)
    throw new SubagentError(`name must be at most ${NAME_MAX} characters.`);
  if (/[@\[\]\n]/.test(name))
    throw new SubagentError('name may not contain @, brackets or newlines.');
  return name;
}

/**
 * A helper's standing instructions as stored: trimmed, null when empty (no
 * instructions). Over the cap is refused, never cut.
 */
function normalizeInstructions(raw: string | null | undefined): string | null {
  const text = raw?.trim() ?? '';
  if (!text) return null;
  if (text.length > SUBAGENT_INSTRUCTIONS_MAX_LENGTH) {
    throw new SubagentError(
      `instructions must be at most ${SUBAGENT_INSTRUCTIONS_MAX_LENGTH} characters (got ${text.length}).`
    );
  }
  return text;
}

/**
 * A failed or paused helper outlives the delivery of its result: its thread
 * still holds the brief and the work so far, so the orchestrator can retry or
 * resume it with op:send. The idle sweep removes it after IDLE_HELPER_MS
 * without work (never while a timed pause is pending).
 */
function keptAfterDelivery(sub: SubagentRow): boolean {
  return sub.status === 'failed' || sub.status === 'stopped';
}

/** A pause or removal notice: informational, so it never wakes the orchestrator. */
function isNotice(row: MessageRow): boolean {
  return typeof row.metadata?.subagent_notice === 'string';
}

function isOrchestratorRunning(threadId: string, agentId: string): boolean {
  return activeWorkRegistry
    .snapshot()
    .some(
      (item) => item.kind === 'thread-run' && item.threadId === threadId && item.agentId === agentId
    );
}

class SubagentServiceImpl {
  private initialized = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  /** Latest helper run outcome, by subagent id (read when its thread settles). */
  private lastRunOutcome = new Map<string, { status: RunEndPayload['status']; runId: string }>();
  private settleTimers = new Map<string, NodeJS.Timeout>();
  /** Per-helper chain: settling, pausing and removing one helper never interleave. */
  private locks = new Map<string, Promise<unknown>>();
  /**
   * A pause or removal waiting for the run it stopped to unwind. Whoever gets
   * the helper's lock first once its thread is idle (the caller, or the run's
   * end in settleHelper) finishes it.
   */
  private pendingPause = new Map<string, PendingPause>();
  private pendingRemoval = new Map<string, PendingRemoval>();
  /** Wakes spent per result row, so a result that never lands cannot loop. */
  private wakeCount = new Map<string, number>();
  /** Parent threads with a result waiting for the thread to go idle. */
  private waitingParents = new Set<string>();
  /**
   * Helper threads whose run:end is still being handled (its outcome is not
   * recorded yet), so the thread going idle meanwhile does not read as a
   * turn that never ran.
   */
  private runEndsInFlight = new Set<string>();
  /** Why Snaglet itself stopped a helper's run (the idle sweep), read when that run's end settles it. */
  private haltReasons = new Map<string, string>();
  private offThreadReleased: (() => void) | null = null;

  private readonly onRunEndListener = (payload: RunEndPayload): void => {
    const helperThread =
      payload.agentId?.startsWith('subagent-') && payload.threadId ? payload.threadId : null;
    if (helperThread) this.runEndsInFlight.add(helperThread);
    void this.onRunEnd(payload)
      .catch((err: unknown) => {
        LogsService.error('subagent run:end handling failed', {
          runId: payload.runId,
          error: getErrorMessage(err),
        });
      })
      .finally(() => {
        if (helperThread) this.runEndsInFlight.delete(helperThread);
      });
  };

  private readonly onThreadReleasedListener = (threadId: string): void => {
    void this.onHelperThreadIdle(threadId).catch((err: unknown) => {
      LogsService.warn('subagent idle-thread check failed', {
        threadId,
        error: getErrorMessage(err),
      });
    });
  };

  private readonly onMessageCreateListener = (payload: {
    threadId: string;
    agentId?: string;
  }): void => {
    void this.onThreadMessage(payload.threadId, payload.agentId ?? null).catch((err: unknown) => {
      LogsService.warn('subagent message handling failed', {
        threadId: payload.threadId,
        error: getErrorMessage(err),
      });
    });
  };

  /**
   * Subscribe to run ends and messages, start the sweep and the timed-pause
   * check, and recover helpers left running. Tests pass
   * `recoverAfterRestart: false` to keep the boot timer out.
   */
  init(opts: { recoverAfterRestart?: boolean } = {}): void {
    if (this.initialized) return;
    this.initialized = true;
    hooks.on('run:end', this.onRunEndListener);
    hooks.on('message:create', this.onMessageCreateListener);
    this.offThreadReleased = activeRunTracker.onThreadReleased(this.onThreadReleasedListener);
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err: unknown) =>
        LogsService.warn('subagent sweep failed', { error: getErrorMessage(err) })
      );
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    this.resumeTimer = setInterval(() => {
      void this.resumeDue().catch((err: unknown) =>
        LogsService.warn('subagent resume check failed', { error: getErrorMessage(err) })
      );
    }, RESUME_CHECK_INTERVAL_MS);
    this.resumeTimer.unref?.();
    if (opts.recoverAfterRestart === false) return;
    const boot = setTimeout(() => {
      void this.recoverAfterRestart().catch((err: unknown) =>
        LogsService.warn('subagent boot recovery failed', { error: getErrorMessage(err) })
      );
    }, BOOT_RECOVERY_DELAY_MS);
    boot.unref?.();
  }

  shutdown(): void {
    if (!this.initialized) return;
    this.initialized = false;
    hooks.off('run:end', this.onRunEndListener);
    hooks.off('message:create', this.onMessageCreateListener);
    this.offThreadReleased?.();
    this.offThreadReleased = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.resumeTimer = null;
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
  }

  // Ops

  async start(input: StartSubagentInput): Promise<SubagentRow> {
    const name = normalizeName(input.name);
    const brief = input.brief.trim();
    if (!brief) throw new SubagentError('brief is required: the whole assignment, self-contained.');
    const instructions = normalizeInstructions(input.instructions);

    const orchestrator = await Agents.findById(input.orchestratorAgentId);
    if (!orchestrator) throw new SubagentError('Calling agent not found.');
    if (orchestrator.parentAgentId) throw new SubagentError('A subagent cannot start subagents.');
    const parent = await Threads.findById(input.parentThreadId);
    if (!parent) throw new SubagentError('Thread not found.');
    if (parent.parentThreadId) throw new SubagentError('A subagent thread cannot start subagents.');
    if (await Subagents.findLiveByName(parent.id, name)) {
      throw new SubagentError(
        `This thread already has a subagent named "${name}". Give it more work with op:send, or pick another name.`
      );
    }

    // The orchestrator's provider in this thread (participant override first).
    const effective = await Threads.getEffectiveModel(parent.id, orchestrator.id);
    const providerId = await helperProviderId(parent.id, orchestrator.id, orchestrator.providerId);
    if (!providerId)
      throw new SubagentError(
        'Your own model has no provider, so no subagent model can be picked.'
      );
    const models = await helperModels(providerId);
    const model = matchModel(models, input.model);
    if (!model) {
      throw new SubagentError(
        `model "${input.model}" is not an active tool-capable model on your provider (${providerId}). Pick one of: ${describeModels(models) || '(none)'}.`
      );
    }
    const credentialId =
      effective?.providerId === providerId ? effective.credentialId : orchestrator.credentialId;

    // Permissions are inherited live (helperInheritance): the helper row keeps
    // only the narrowing chosen here. helperToolAccess still checks it against
    // the orchestrator's current access (entries read by id, display name or
    // old id, as the permission engine reads them; an MCP tool against the
    // orchestrator's servers here), so an impossible list fails now.
    const runtime = await resolveThreadRuntimeConfig(parent.id);
    const override = runtime?.agentOverrides.get(orchestrator.id);
    const narrowing =
      input.tools && input.tools.length > 0
        ? helperToolAccess(override?.toolAccess ?? agentToolAccess(orchestrator), input.tools, {
            catalog: await loadToolNameCatalog(),
            mcpServerIds: resolveEnabledMcpServers(orchestrator.mcpServers, override?.mcpServers),
          })
        : null;

    const agentId = `subagent-${randomUUID()}`;
    const threadId = generateId('thread');
    let createdAgent = false;
    let createdThread = false;
    let row: SubagentRow | null = null;
    try {
      await Agents.create({
        id: agentId,
        name,
        role: 'subagent',
        systemPrompt: helperSystemPrompt({ name, orchestratorName: orchestrator.name }),
        identity: null,
        modelId: model.modelId,
        providerId,
        credentialId: credentialId ?? null,
        toolAccessMode: narrowing?.toolAccessMode ?? null,
        toolAccessAllowList: narrowing?.toolAccessAllowList ?? null,
        toolAccessDenyList: null,
        toolAccessAdvertiseAllowedOnly: false,
        // Access and confirmation overrides are inherited live from the
        // orchestrator. Persist trust too: call-time permission escalation
        // needs the helper's runtime agent to honor the inherited trust.
        toolOverrides: null,
        trustedToolCalls: orchestrator.trustedToolCalls === true,
        mcpServers: [],
        maxToolCallsPerTurn: orchestrator.maxToolCallsPerTurn,
        maxDurationSeconds: orchestrator.maxDurationSeconds,
        fallbacks: null,
        disableModelFallback: false,
        parentAgentId: orchestrator.id,
      });
      createdAgent = true;

      // The orchestrator's assigned skills, minus any built-in assignment left
      // from before built-ins became unassignable: every agent has those anyway.
      const skillIds = await SkillAssignmentService.listGeneral(orchestrator.id);
      if (skillIds.length > 0) await SkillAssignments.replace(agentId, null, skillIds);

      await Threads.create({
        id: threadId,
        title: `${orchestrator.name} › ${name}`,
        projectId: await Nodes.getProjectId(parent.id),
        dispatchMode: 'all',
        parentThreadId: parent.id,
      });
      createdThread = true;
      // The instructions are the helper's participant addendum in its own
      // thread: appended after its system prompt like any thread addendum,
      // and what its thread's Settings → Agents shows as Instructions.
      await ThreadParticipants.addParticipant({
        threadId,
        agentId,
        systemPromptAddendum: instructions,
      });

      row = await Subagents.create({
        parentThreadId: parent.id,
        orchestratorAgentId: orchestrator.id,
        agentId,
        threadId,
        startedByRunId: getRunContext()?.runId ?? null,
        name,
        providerId,
        modelId: model.modelId,
      });
    } catch (err) {
      await this.discardPartialStart({
        agentId,
        threadId,
        createdAgent,
        createdThread,
        rowId: row?.id,
      });
      if (err instanceof SubagentError) throw err;
      if ((err as { code?: string }).code === '23505') {
        throw new SubagentError(`This thread already has a subagent named "${name}".`);
      }
      throw err;
    }

    emitSubagentChanged(parent.id, toSubagentSummary(row, orchestrator.name));
    // Persists the brief, broadcasts it, and dispatches without awaiting the run.
    try {
      await this.postTask(row, orchestrator.id, brief);
    } catch (err) {
      // No brief, no work: a helper left behind would read as running forever.
      await this.discardPartialStart({
        agentId,
        threadId,
        createdAgent,
        createdThread,
        rowId: row.id,
      });
      emitSubagentChanged(parent.id, null, row.id);
      throw new SubagentError(`could not give ${name} its brief: ${getErrorMessage(err)}`);
    }
    LogsService.socket.event('subagent started', {
      subagentId: row.id,
      name,
      parentThreadId: parent.id,
      orchestratorAgentId: orchestrator.id,
      model: `${providerId}:${model.modelId}`,
    });
    return row;
  }

  /** Give a live helper another task, or answer its question. */
  async send(input: {
    orchestratorAgentId: string;
    parentThreadId: string;
    ref: string;
    message: string;
  }): Promise<SubagentRow> {
    const message = input.message.trim();
    if (!message) throw new SubagentError('message is required.');
    const sub = await this.resolve(input.parentThreadId, input.orchestratorAgentId, input.ref);
    if (!sub.threadId) throw new SubagentError(`Subagent "${sub.name}" no longer has a thread.`);
    if (this.pendingRemoval.has(sub.id)) {
      throw new SubagentError(`Subagent "${sub.name}" is being removed.`);
    }
    // A new task is the redirect: it wins over a pause still unwinding.
    this.pendingPause.delete(sub.id);
    const running = (await Subagents.markRunning(sub.id)) ?? sub;
    this.wakeCount.delete(sub.lastResultMessageId ?? '');
    const orchestrator = await Agents.findById(input.orchestratorAgentId);
    emitSubagentChanged(sub.parentThreadId, toSubagentSummary(running, orchestrator?.name ?? null));
    await this.postTask(running, input.orchestratorAgentId, message);
    return running;
  }

  /**
   * Replace a live helper's standing instructions (null or empty clears
   * them). They are its participant addendum in its own thread, so they apply
   * from its next turn; a run already going keeps the prompt it started with.
   * An orchestrator changes only its own helpers'; the user any.
   */
  async updateInstructions(input: {
    parentThreadId: string;
    ref: string;
    by: SubagentActor;
    instructions: string | null;
  }): Promise<{ sub: SubagentRow; instructions: string | null }> {
    const instructions = normalizeInstructions(input.instructions);
    const sub = await this.resolveFor(input.parentThreadId, input.ref, input.by);
    if (!sub.threadId) throw new SubagentError(`Subagent "${sub.name}" no longer has a thread.`);
    if (this.pendingRemoval.has(sub.id)) {
      throw new SubagentError(`Subagent "${sub.name}" is being removed.`);
    }
    const updated = await ThreadParticipants.updateOverrides(sub.threadId, sub.agentId, {
      systemPromptAddendum: instructions,
    });
    if (!updated) throw new SubagentError(`Subagent "${sub.name}" no longer has a thread.`);
    LogsService.socket.event('subagent instructions updated', {
      subagentId: sub.id,
      parentThreadId: sub.parentThreadId,
      by: input.by.kind,
      length: instructions?.length ?? 0,
    });
    return { sub, instructions };
  }

  /**
   * Pause a helper: stop its current run, if any, and keep it with its thread,
   * brief and work so far (status 'stopped') until it gets a new task, or
   * until `resumeAt`, when it is told to continue. Its orchestrator gets a
   * notice ("[subagent Echo paused by Ana]") that never wakes it; a running
   * orchestrator reads it at its next tool call and op:wait returns it.
   *
   * `done` is false when the stopped run had not unwound yet: the pause then
   * lands as that run ends.
   */
  async pause(input: {
    parentThreadId: string;
    ref: string;
    by: SubagentActor;
    resumeAt?: Date | null;
  }): Promise<{ sub: SubagentRow; interrupted: boolean; done: boolean }> {
    const sub = await this.resolveFor(input.parentThreadId, input.ref, input.by);
    if (!sub.threadId) throw new SubagentError(`Subagent "${sub.name}" no longer has a thread.`);
    if (this.pendingRemoval.has(sub.id)) {
      throw new SubagentError(`Subagent "${sub.name}" is being removed.`);
    }
    this.pendingPause.set(sub.id, {
      by: input.by,
      resumeAt: input.resumeAt ? input.resumeAt.toISOString() : null,
    });
    const interrupted = await this.interrupt(sub, input.by);
    const after = await this.finishPendingAction(sub);
    return { sub: after ?? sub, interrupted, done: !this.pendingPause.has(sub.id) };
  }

  /**
   * Remove a helper at once: stop its run, if any, and retire it (thread and
   * messages deleted, agent archived). Its orchestrator gets a notice
   * ("[subagent Echo removed by Ana]") that never wakes it.
   *
   * `removed` is false when the stopped run had not unwound yet: the removal
   * then lands as that run ends.
   */
  async remove(input: {
    parentThreadId: string;
    ref: string;
    by: SubagentActor;
  }): Promise<{ sub: SubagentRow; interrupted: boolean; removed: boolean }> {
    const sub = await this.resolveFor(input.parentThreadId, input.ref, input.by);
    this.pendingPause.delete(sub.id);
    if (!this.pendingRemoval.has(sub.id)) {
      this.pendingRemoval.set(sub.id, { by: input.by });
    }
    const interrupted = await this.interrupt(sub, input.by);
    const after = await this.finishPendingAction(sub);
    return { sub: after ?? sub, interrupted, removed: !!after?.deletedAt };
  }

  /**
   * Resume a paused helper now: it is told to continue where it left off, as
   * a message from its orchestrator (a timed pause ending does the same).
   */
  async resume(input: {
    parentThreadId: string;
    ref: string;
    by: SubagentActor;
  }): Promise<SubagentRow> {
    const found = await this.resolveFor(input.parentThreadId, input.ref, input.by);
    if (this.pendingRemoval.has(found.id)) {
      throw new SubagentError(`Subagent "${found.name}" is being removed.`);
    }
    const running = await this.exclusive(found.id, async () => {
      const sub = await Subagents.findById(found.id);
      if (!sub || sub.deletedAt || !sub.threadId) {
        throw new SubagentError(`Subagent "${found.name}" no longer has a thread.`);
      }
      if (sub.status !== 'stopped' || activeRunTracker.hasActiveThread(sub.threadId)) {
        throw new SubagentError(`Subagent "${sub.name}" is not paused.`);
      }
      return Subagents.markRunning(sub.id);
    });
    if (!running?.threadId) throw new SubagentError(`Subagent "${found.name}" is gone.`);
    await this.startResumedRun(running);
    return running;
  }

  /**
   * Resume every helper whose timed pause is due. Run each minute and at
   * boot, so a pause that ended while the server was down resumes too.
   */
  async resumeDue(): Promise<SubagentRow[]> {
    const resumed: SubagentRow[] = [];
    for (const due of await Subagents.listResumeDue()) {
      const claimed = await this.exclusive(due.id, async () => {
        if (!due.threadId || activeRunTracker.hasActiveThread(due.threadId)) {
          // It already has work (or nowhere to run): that replaces the timed resume.
          const cleared = await Subagents.clearResumeAt(due.id);
          if (cleared) await this.emitChanged(cleared);
          return null;
        }
        return Subagents.claimDueResume(due.id);
      });
      if (!claimed?.threadId) continue;
      await this.startResumedRun(claimed);
      resumed.push(claimed);
    }
    return resumed;
  }

  private async startResumedRun(sub: SubagentRow): Promise<void> {
    if (!sub.threadId) return;
    this.wakeCount.delete(sub.lastResultMessageId ?? '');
    await this.emitChanged(sub);
    await this.postTask(sub, sub.orchestratorAgentId, SUBAGENT_RESUME_MESSAGE);
    LogsService.socket.event('subagent resumed', { subagentId: sub.id, name: sub.name });
  }

  /**
   * Post a task (brief, op:send, resume) in the helper's thread as `fromAgentId`
   * and dispatch it without awaiting the run. A dispatch that fails, or wakes
   * no one, never starts a turn and so never ends one: it is reported as a
   * failure once the thread is idle, like any turn that never ran.
   */
  private async postTask(sub: SubagentRow, fromAgentId: string, content: string): Promise<void> {
    const threadId = sub.threadId;
    if (!threadId) throw new SubagentError(`Subagent "${sub.name}" no longer has a thread.`);
    clearHelperTurnFailure(threadId);
    await postAgentMessageToThread({
      threadId,
      agentId: fromAgentId,
      content,
      onDispatchSettled: (outcome) => this.onTaskDispatchSettled(sub, threadId, outcome),
    });
  }

  private onTaskDispatchSettled(
    sub: SubagentRow,
    threadId: string,
    outcome: PostedMessageDispatch
  ): void {
    if ('error' in outcome) {
      noteHelperTurnFailure(
        threadId,
        sub.agentId,
        `Snaglet could not start its turn: ${getErrorMessage(outcome.error)}`
      );
    } else if (outcome.result.reason === 'no_dispatch' && outcome.result.wakeCount === 0) {
      noteHelperTurnFailure(
        threadId,
        sub.agentId,
        'Snaglet could not start its turn: nothing woke it'
      );
    } else {
      // It ran (its run's end reports it), or it waits for the run that holds
      // the thread (that run's end, or the thread going idle, reports it).
      return;
    }
    this.scheduleSettle(sub.id);
  }

  /**
   * A helper thread went idle. A helper still marked running whose turn
   * ended without a run:end (no model, a crash before its first run, Snaglet
   * cutting off a run that stopped responding) is settled now, so its
   * orchestrator hears why and op:wait returns; so is a pause or removal
   * still waiting for that run. Settling is idempotent: when a run:end did
   * arrive, this only moves the settle that run:end scheduled.
   */
  private async onHelperThreadIdle(threadId: string): Promise<void> {
    // Its handler records the outcome and schedules the settle itself.
    if (this.runEndsInFlight.has(threadId)) return;
    if (!(await isHelperThread(threadId))) return;
    const sub = await Subagents.findLiveByThreadId(threadId);
    if (!sub || this.runEndsInFlight.has(threadId)) return;
    const pendingAction = this.pendingRemoval.has(sub.id) || this.pendingPause.has(sub.id);
    if (sub.status !== 'running' && !pendingAction) return;
    this.scheduleSettle(sub.id);
  }

  /**
   * Someone other than the helper wrote in its thread (the user redirecting
   * it): that new task replaces a scheduled resume.
   */
  private async onThreadMessage(threadId: string, authorAgentId: string | null): Promise<void> {
    // Cached per thread (the hook bus asks the same for every event).
    if (!(await isHelperThread(threadId))) return;
    const cleared = await Subagents.clearResumeAtForThread(threadId, authorAgentId);
    if (cleared) await this.emitChanged(cleared);
  }

  /**
   * A turn of helper `agentId` is about to start (turnGate): drop it when the
   * helper is gone, being paused or removed, or paused after the message
   * that triggered the turn. Its pause time is `finishedAt` (set when it was
   * paused or stopped); a new task (op:send, Resume, the timer) moves it to
   * running first, and a message the user writes after the pause is newer.
   */
  async holdsTurn(agentId: string, triggerMessageId: string | undefined): Promise<boolean> {
    const sub = await Subagents.findByAgentId(agentId);
    if (!sub) return false;
    if (sub.deletedAt || this.pendingRemoval.has(sub.id) || this.pendingPause.has(sub.id)) {
      return true;
    }
    if (sub.status !== 'stopped') return false;
    const trigger = triggerMessageId ? await Messages.findById(triggerMessageId) : null;
    if (!trigger || !sub.finishedAt) return true;
    return Date.parse(trigger.createdAt) <= Date.parse(sub.finishedAt);
  }

  /**
   * Block until the named helpers (default: every running helper of this
   * orchestrator in this thread) have finished, at most `timeoutMs`, and
   * return their reports. A model that wants a report inside its turn waits
   * here instead of inventing it (seen live). Each returned report counts as
   * seen by the calling run, so it is not woken for it again and the helper
   * is cleaned up when that run ends, as for any delivered result.
   */
  async wait(input: {
    orchestratorAgentId: string;
    parentThreadId: string;
    names?: readonly string[] | null;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{
    reports: Array<{ sub: SubagentRow; content: string }>;
    stillRunning: SubagentRow[];
  }> {
    const mine = (await Subagents.listLiveForParent(input.parentThreadId)).filter(
      (s) => s.orchestratorAgentId === input.orchestratorAgentId
    );
    let targets: SubagentRow[];
    if (input.names && input.names.length > 0) {
      targets = [];
      for (const ref of input.names) {
        targets.push(await this.resolve(input.parentThreadId, input.orchestratorAgentId, ref));
      }
    } else {
      // Running ones, plus finished ones whose report this run has not had yet.
      targets = mine.filter((s) => s.status === 'running' || !s.deliveredRunId);
    }
    if (targets.length === 0) return { reports: [], stillRunning: [] };

    const ids = new Set(targets.map((t) => t.id));
    const deadline = Date.now() + input.timeoutMs;
    let current: SubagentRow[] = targets;
    for (;;) {
      if (input.signal?.aborted) throw new SubagentError('wait was stopped.');
      const rows = await Promise.all([...ids].map((id) => Subagents.findById(id)));
      current = rows.filter((r): r is SubagentRow => !!r);
      // A helper that is busy settling (its run just ended) still reads as running.
      const pending = current.filter((r) => r.status === 'running' && !r.deletedAt);
      if (pending.length === 0 || Date.now() >= deadline) break;
      await sleep(WAIT_POLL_MS);
    }

    const reports: Array<{ sub: SubagentRow; content: string }> = [];
    for (const sub of current) {
      if (sub.status === 'running' || !sub.lastResultMessageId) continue;
      const row = await Messages.findById(sub.lastResultMessageId);
      if (!row) continue;
      // This run now holds the report: drop the queued mid-run copy and count
      // it as seen, exactly like an injection.
      pendingAgentMessages.discardUnreadBySource(
        input.parentThreadId,
        input.orchestratorAgentId,
        row.id
      );
      noteMessageInjected(input.parentThreadId, input.orchestratorAgentId, row.id);
      reports.push({ sub, content: row.content });
    }
    const stillRunning = current.filter((r) => r.status === 'running' && !r.deletedAt);
    return { reports, stillRunning };
  }

  async list(parentThreadId: string): Promise<SubagentRow[]> {
    return Subagents.listLiveForParent(parentThreadId);
  }

  /** A live helper of this thread and orchestrator, by name or id. */
  private async resolve(
    parentThreadId: string,
    orchestratorAgentId: string,
    ref: string
  ): Promise<SubagentRow> {
    const sub = await this.resolveAny(parentThreadId, ref);
    if (sub.orchestratorAgentId !== orchestratorAgentId) {
      throw new SubagentError(`Subagent "${sub.name}" belongs to another agent.`);
    }
    return sub;
  }

  /** The helper an actor may act on: an orchestrator only its own, the user any. */
  private resolveFor(parentThreadId: string, ref: string, by: SubagentActor): Promise<SubagentRow> {
    return by.kind === 'orchestrator'
      ? this.resolve(parentThreadId, by.agentId, ref)
      : this.resolveAny(parentThreadId, ref);
  }

  /** A live helper of this thread, by name or id, whoever started it. */
  private async resolveAny(parentThreadId: string, ref: string): Promise<SubagentRow> {
    const wanted = ref.trim();
    if (!wanted) throw new SubagentError('name (or id) is required.');
    const sub =
      (await Subagents.findLiveByName(parentThreadId, wanted)) ??
      (await Subagents.listLiveForParent(parentThreadId)).find((s) => s.id === wanted) ??
      null;
    if (!sub) {
      const live = await Subagents.listLiveForParent(parentThreadId);
      const names = live.map((s) => s.name).join(', ');
      throw new SubagentError(
        `No live subagent "${wanted}" in this thread${names ? ` (live: ${names})` : ''}.`
      );
    }
    return sub;
  }

  private async orchestratorNameOf(sub: SubagentRow): Promise<string> {
    return (await Agents.findById(sub.orchestratorAgentId))?.name ?? sub.orchestratorAgentId;
  }

  private async emitChanged(sub: SubagentRow): Promise<void> {
    emitSubagentChanged(
      sub.parentThreadId,
      toSubagentSummary(sub, await this.orchestratorNameOf(sub))
    );
  }

  /** Serialize work on one helper; a failure never blocks the next caller. */
  private async exclusive<T>(subagentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(subagentId) ?? Promise.resolve();
    const run = previous.then(() => fn());
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(subagentId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(subagentId) === tail) this.locks.delete(subagentId);
    }
  }

  /** Stop the helper's current run, attributed to whoever pauses or removes it. */
  private async interrupt(sub: SubagentRow, by: SubagentActor): Promise<boolean> {
    if (!sub.threadId || !activeRunTracker.hasActiveThread(sub.threadId)) return false;
    const abortedBy: Actor =
      by.kind === 'user'
        ? { actorKind: 'user', actorId: by.userId, actorName: by.name }
        : {
            actorKind: 'agent',
            actorId: by.agentId,
            actorName: (await Agents.findById(by.agentId))?.name ?? by.agentId,
          };
    // Thread-wide, like the composer's Stop: the helper's thread holds only
    // the helper, and this also keeps its wave from starting another turn.
    const { abortedCount } = await AbortRunService.abortAllAgentRuns({
      threadId: sub.threadId,
      abortedBy,
    });
    return abortedCount > 0;
  }

  /** Once the stopped run has unwound, finish the pending pause or removal (unless its end did). */
  private async finishPendingAction(sub: SubagentRow): Promise<SubagentRow | null> {
    if (sub.threadId) {
      await activeRunTracker.waitForThreadRelease(sub.threadId, ACTION_RELEASE_WAIT_MS);
    }
    return this.exclusive(sub.id, () => this.applyPendingAction(sub.id));
  }

  /** Under the helper's lock: apply a pending removal or pause if its thread is idle. */
  private async applyPendingAction(subagentId: string): Promise<SubagentRow | null> {
    const removal = this.pendingRemoval.get(subagentId);
    const pause = this.pendingPause.get(subagentId);
    const sub = await Subagents.findById(subagentId);
    if (!removal && !pause) return sub;
    if (!sub || sub.deletedAt) {
      this.pendingRemoval.delete(subagentId);
      this.pendingPause.delete(subagentId);
      return sub;
    }
    // Still unwinding: the run's end finishes the action (settleHelper).
    if (sub.threadId && activeRunTracker.hasActiveThread(sub.threadId)) return sub;
    const timer = this.settleTimers.get(sub.id);
    if (timer) clearTimeout(timer);
    this.settleTimers.delete(sub.id);

    if (removal) {
      this.lastRunOutcome.delete(sub.id);
      this.pendingRemoval.delete(sub.id);
      this.pendingPause.delete(sub.id);
      await this.applyRemoval(sub, removal);
      return Subagents.findById(sub.id);
    }
    this.pendingPause.delete(sub.id);
    if (!pause) return sub;
    const outcome = this.lastRunOutcome.get(sub.id);
    if (outcome && outcome.status !== 'aborted') {
      // The run ended on its own just as the pause landed: its report goes
      // out (and wakes) as usual, and the helper is then kept, paused.
      await this.writeRunResult(sub, {});
      return this.applyPause((await Subagents.findById(sub.id)) ?? sub, pause);
    }
    // The run that just ended is the one the pause stopped: the notice
    // replaces its result.
    this.lastRunOutcome.delete(sub.id);
    return this.applyPause(sub, pause);
  }

  /**
   * True when the helper's latest result is a report its orchestrator has not
   * had yet. A pause keeps that report as the latest result, so it is still
   * delivered (and still wakes the orchestrator); the notice goes alongside.
   */
  private async hasPendingReport(sub: SubagentRow): Promise<boolean> {
    if (sub.status === 'running' || !sub.lastResultMessageId || sub.deliveredRunId) return false;
    const row = await Messages.findById(sub.lastResultMessageId);
    return !!row && !isNotice(row);
  }

  private async applyPause(sub: SubagentRow, pause: PendingPause): Promise<SubagentRow | null> {
    if (await this.hasPendingReport(sub)) {
      const row = await this.writeNotice(sub, {
        notice: 'paused',
        by: pause.by,
        resumeAt: pause.resumeAt,
        reply: null,
      });
      const paused = await Subagents.markPausedKeepingResult(sub.id, pause.resumeAt);
      if (!paused) return null;
      await this.emitChanged(paused);
      this.handOverNotice(paused, row, pause.by);
      LogsService.socket.event('subagent paused', {
        subagentId: sub.id,
        name: sub.name,
        by: pause.by.kind,
        resumeAt: pause.resumeAt,
        keptPendingReport: true,
      });
      return paused;
    }
    // A reply the stopped run had already written is the work so far.
    const newReply = await this.newReplyOf(sub);
    const row = await this.writeNotice(sub, {
      notice: 'paused',
      by: pause.by,
      resumeAt: pause.resumeAt,
      reply: newReply?.content ?? null,
    });
    const paused = await Subagents.markPaused(sub.id, {
      resultMessageId: row.id,
      replyMessageId: newReply?.id ?? null,
      resumeAt: pause.resumeAt,
    });
    if (!paused) return null;
    await this.emitChanged(paused);
    this.handOverNotice(paused, row, pause.by);
    LogsService.socket.event('subagent paused', {
      subagentId: sub.id,
      name: sub.name,
      by: pause.by.kind,
      resumeAt: pause.resumeAt,
    });
    return paused;
  }

  /**
   * Retire the helper, then tell its orchestrator. The notice is written only
   * once the helper is really gone, so a removal that fails tells no one it
   * worked, and one that lands writes exactly one notice.
   */
  private async applyRemoval(sub: SubagentRow, removal: PendingRemoval): Promise<boolean> {
    const removed = await this.retire(sub, 'removed', async () => {
      const row = await this.writeNotice(sub, {
        notice: 'removed',
        by: removal.by,
        resumeAt: null,
        reply: null,
      });
      this.handOverNotice(sub, row, removal.by);
      return row.id;
    });
    if (removed) return true;
    if (sub.threadId && activeRunTracker.hasActiveThread(sub.threadId)) {
      // Its thread got busy again in between: the next run's end retries.
      this.pendingRemoval.set(sub.id, removal);
      return false;
    }
    throw new SubagentError(`${sub.name}'s thread could not be deleted; try again.`);
  }

  /** The orchestrator-only notice row in the parent thread, shown live to its viewers. */
  private async writeNotice(
    sub: SubagentRow,
    input: {
      notice: SubagentNotice;
      by: SubagentActor;
      resumeAt: string | null;
      reply: string | null;
    }
  ): Promise<MessageRow> {
    const orchestratorName = await this.orchestratorNameOf(sub);
    const byUser = input.by.kind === 'user' ? input.by.name : null;
    const content = noticeText({
      name: sub.name,
      id: sub.id,
      notice: input.notice,
      byUser,
      resumeAt: input.resumeAt,
      reply: input.reply,
    });
    const metadata: SubagentResultMetadata = {
      subagent_id: sub.id,
      subagent_name: sub.name,
      subagent_thread_id: input.notice === 'removed' ? null : sub.threadId,
      orchestrator_agent_id: sub.orchestratorAgentId,
      orchestrator_name: orchestratorName,
      subagent_status: 'stopped',
      subagent_notice: input.notice,
      subagent_notice_by: byUser ?? orchestratorName,
      subagent_resume_at: input.resumeAt,
    };
    const row = await Messages.createEvent({
      threadId: sub.parentThreadId,
      content,
      eventKind: SUBAGENT_RESULT_EVENT_KIND,
      visibleToAgentId: sub.orchestratorAgentId,
      metadata: { ...metadata },
    });
    this.broadcastResultRow(sub, row, orchestratorName, metadata.subagent_status, {
      notice: input.notice,
      noticeBy: byUser ?? orchestratorName,
      resumeAt: input.resumeAt,
    });
    return row;
  }

  /**
   * A notice never wakes the orchestrator. A running one reads it at its next
   * tool call; an idle one, in its next run's history. The orchestrator's own
   * pause or removal is in hand already (its tool result said so).
   */
  private handOverNotice(sub: SubagentRow, row: MessageRow, by: SubagentActor): void {
    if (by.kind === 'orchestrator') {
      noteMessageInjected(sub.parentThreadId, sub.orchestratorAgentId, row.id);
      return;
    }
    if (!isOrchestratorRunning(sub.parentThreadId, sub.orchestratorAgentId)) return;
    pendingAgentMessages.enqueue({
      threadId: sub.parentThreadId,
      targetAgentId: sub.orchestratorAgentId,
      senderName: RESULT_SENDER_NAME,
      content: row.content,
      reason: 'system',
      sourceMessageId: row.id,
    });
  }

  private async discardPartialStart(input: {
    agentId: string;
    threadId: string;
    createdAgent: boolean;
    createdThread: boolean;
    rowId?: string;
  }): Promise<void> {
    try {
      if (input.rowId) await Subagents.delete(input.rowId);
      if (input.createdThread) await Nodes.deleteOfType(input.threadId, 'thread');
      if (input.createdAgent) await Agents.delete(input.agentId);
    } catch (err) {
      LogsService.warn('subagent start cleanup failed', {
        agentId: input.agentId,
        threadId: input.threadId,
        error: getErrorMessage(err),
      });
    }
  }

  // Lifecycle

  private async onRunEnd(payload: RunEndPayload): Promise<void> {
    const { agentId, threadId } = payload;
    if (!agentId) return;
    // Orchestrator side first: forget what this run saw, whoever ran it.
    const seen = threadId ? takeSeen(threadId, agentId) : null;
    const helper = await Subagents.findByAgentId(agentId);
    if (helper) {
      if (!helper.deletedAt && helper.threadId && helper.threadId === threadId) {
        this.lastRunOutcome.set(helper.id, { status: payload.status, runId: payload.runId });
        this.scheduleSettle(helper.id);
      }
      return;
    }
    if (threadId && seen) {
      await this.onOrchestratorRunEnd(payload.runId, payload.status, threadId, agentId, seen);
    }
  }

  private scheduleSettle(subagentId: string): void {
    const existing = this.settleTimers.get(subagentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.settleTimers.delete(subagentId);
      void this.settleHelper(subagentId).catch((err: unknown) =>
        LogsService.error('subagent settle failed', { subagentId, error: getErrorMessage(err) })
      );
    }, SETTLE_DELAY_MS);
    timer.unref?.();
    this.settleTimers.set(subagentId, timer);
  }

  /**
   * The helper's thread went quiet: turn its newest reply into a result for
   * the orchestrator. A thread that picked up new work meanwhile is left for
   * that run's end.
   */
  async settleHelper(subagentId: string, opts: { afterRestart?: boolean } = {}): Promise<void> {
    await this.exclusive(subagentId, () => this.settleHelperNow(subagentId, opts));
  }

  private async settleHelperNow(
    subagentId: string,
    opts: { afterRestart?: boolean }
  ): Promise<void> {
    const sub = await Subagents.findById(subagentId);
    if (!sub || sub.deletedAt || !sub.threadId) return;
    if (!opts.afterRestart) {
      await activeRunTracker.waitForThreadRelease(sub.threadId, 30_000);
      if (activeRunTracker.hasActiveThread(sub.threadId)) return;
    }
    // A pause or removal asked for during this run lands now, in place of its result.
    if (this.pendingRemoval.has(sub.id) || this.pendingPause.has(sub.id)) {
      await this.applyPendingAction(sub.id);
      return;
    }

    await this.writeRunResult(sub, opts);
  }

  /**
   * The helper's newest reply since its last result, if any: its report, or
   * the work so far of a run that failed or was stopped. A failed run's error
   * bubble is not the helper's work, and nothing older than the reply the
   * last result carried counts as new.
   */
  private async newReplyOf(sub: SubagentRow): Promise<MessageRow | null> {
    if (!sub.threadId) return null;
    const reply = await Messages.findLatestAgentReply(sub.threadId, sub.agentId, {
      skipRunErrors: true,
    });
    if (!reply || reply.id === sub.lastReplyMessageId) return null;
    const last = sub.lastReplyMessageId ? await Messages.findById(sub.lastReplyMessageId) : null;
    if (last && Date.parse(reply.createdAt) < Date.parse(last.createdAt)) return null;
    return reply;
  }

  /**
   * The helper's thread is idle after a run: turn its newest reply into a
   * result row for the orchestrator and deliver it, unless there is nothing
   * new to report. Every way a run can end badly lands here once, as one
   * `failed` or `stopped` result with the reason (docs/agents.md).
   */
  private async writeRunResult(
    current: SubagentRow,
    opts: { afterRestart?: boolean }
  ): Promise<void> {
    let sub = current;
    const threadId = sub.threadId;
    if (!threadId) return;
    const outcome = this.lastRunOutcome.get(sub.id);
    this.lastRunOutcome.delete(sub.id);
    // Why a turn could not run, or why Snaglet stopped it, if noted; stale once read.
    const noted = takeHelperTurnFailure(threadId);
    const halted = this.haltReasons.get(sub.id) ?? null;
    this.haltReasons.delete(sub.id);
    const run = outcome ? await Runs.findById(outcome.runId) : null;
    if (
      outcome &&
      outcome.status !== 'completed' &&
      sub.status !== 'running' &&
      run &&
      sub.finishedAt &&
      Date.parse(run.startedAt) < Date.parse(sub.finishedAt)
    ) {
      // A run that started before the latest result belongs to a task already
      // reported: Snaglet cut it off when it stopped responding, and it unwound
      // only now. Its end adds nothing.
      return;
    }
    const newReply = await this.newReplyOf(sub);

    let status: Exclude<SubagentStatus, 'running'>;
    let error: string | null = null;
    if (outcome?.status === 'failed') {
      status = 'failed';
      error = plainReason(run?.error) ?? 'its run failed without saying why';
    } else if (outcome?.status === 'aborted') {
      // A paused helper's run was stopped again: still paused, nothing new to report.
      if (sub.status === 'stopped') return;
      const abort = halted
        ? { status: 'failed' as const, reason: halted }
        : describeAbort(run?.error ?? null, {
            turnTimeoutSeconds: await turnTimeoutSeconds(),
            watchdogMinutes: Math.round(REAPER_STALL_DEFAULT_MS / 60_000),
          });
      status = abort.status;
      error = plainReason(abort.reason);
    } else if (opts.afterRestart && sub.status === 'running') {
      status = newReply ? 'finished' : 'stopped';
      if (!newReply) error = 'the server restarted while it was working';
    } else if (!outcome && sub.status === 'running') {
      // No run of this task ended: its turn never started one (it has no
      // model, its agent is gone, it crashed building its context, Snaglet could
      // not start it), or Snaglet cut off a run that stopped responding.
      if (newReply) {
        status = 'finished';
      } else {
        status = 'failed';
        error = plainReason(noted) ?? (await this.endedWithoutRunReason(threadId, sub.agentId));
      }
    } else {
      // A completed run with nothing new to say (e.g. it only acknowledged
      // the user) does not produce a second result.
      if (!newReply && sub.status !== 'running') return;
      status = 'finished';
    }
    if (sub.status !== 'running') {
      // New work arrived without op:send (the user wrote to the helper).
      sub = (await Subagents.markRunning(sub.id)) ?? sub;
    }

    const orchestrator = await Agents.findById(sub.orchestratorAgentId);
    const orchestratorName = orchestrator?.name ?? sub.orchestratorAgentId;
    const reply =
      newReply ??
      (status === 'finished'
        ? await Messages.findLatestAgentReply(threadId, sub.agentId, { skipRunErrors: true })
        : null);
    const content = resultText({
      name: sub.name,
      id: sub.id,
      status,
      error,
      reply: reply?.content ?? null,
      isQuestion: newReply?.messageType === 'question',
    });
    const row = await Messages.createEvent({
      threadId: sub.parentThreadId,
      content,
      eventKind: SUBAGENT_RESULT_EVENT_KIND,
      visibleToAgentId: sub.orchestratorAgentId,
      metadata: {
        subagent_id: sub.id,
        subagent_name: sub.name,
        subagent_thread_id: threadId,
        orchestrator_agent_id: sub.orchestratorAgentId,
        orchestrator_name: orchestratorName,
        subagent_status: status,
      },
    });
    const ended = await Subagents.markEnded(sub.id, {
      status,
      error,
      resultMessageId: row.id,
      replyMessageId: newReply?.id ?? sub.lastReplyMessageId,
    });
    if (!ended) return;
    this.broadcastResultRow(sub, row, orchestratorName, status);
    emitSubagentChanged(sub.parentThreadId, toSubagentSummary(ended, orchestratorName));
    if (status !== 'finished') {
      LogsService.socket.event('subagent run ended badly', {
        subagentId: sub.id,
        name: sub.name,
        status,
        error,
      });
    }
    await this.deliver(ended, row);
  }

  /**
   * Why a helper's turn ended with no run of its own to report on and no
   * reason noted: a run still marked running was cut off by Snaglet (the
   * watchdog releases a run that ignores its abort).
   */
  private async endedWithoutRunReason(threadId: string, agentId: string): Promise<string> {
    const runs = await Runs.listByThreadId(threadId).catch(() => []);
    const latest = runs.filter((r) => r.agentId === agentId).at(-1);
    return latest?.status === 'running'
      ? 'it stopped responding, so Snaglet ended its run'
      : 'its turn ended before it could start';
  }

  private broadcastResultRow(
    sub: SubagentRow,
    row: MessageRow,
    orchestratorName: string,
    status: Exclude<SubagentStatus, 'running'>,
    notice?: { notice: SubagentNotice; noticeBy: string; resumeAt: string | null }
  ): void {
    wsService.broadcastToChannel(sub.parentThreadId, {
      type: 'socket:chat:message_created',
      payload: {
        id: row.id,
        threadId: sub.parentThreadId,
        role: 'user',
        content: row.content,
        created_at: row.createdAt ? isoStamp(row.createdAt) : isoNow(),
        message_type: 'thread_event',
        visible_to_agent_id: sub.orchestratorAgentId,
        event_kind: SUBAGENT_RESULT_EVENT_KIND,
        subagent: {
          id: sub.id,
          name: sub.name,
          threadId: notice?.notice === 'removed' ? null : sub.threadId,
          orchestratorAgentId: sub.orchestratorAgentId,
          orchestratorName,
          status,
          ...(notice ?? {}),
        },
      },
    });
  }

  /** Hand a result row to its orchestrator: mid-run if it is running there, else a wake. */
  private async deliver(sub: SubagentRow, row: MessageRow): Promise<void> {
    if (isOrchestratorRunning(sub.parentThreadId, sub.orchestratorAgentId)) {
      pendingAgentMessages.enqueue({
        threadId: sub.parentThreadId,
        targetAgentId: sub.orchestratorAgentId,
        senderName: RESULT_SENDER_NAME,
        content: row.content,
        reason: 'system',
        sourceMessageId: row.id,
      });
      // If the run ends without reaching another tool seam, its end hands the
      // result to a fresh wake (onOrchestratorRunEnd). The idle watch covers
      // a run that was already ending when the result landed.
      this.wakeWhenParentIdle(sub.parentThreadId);
      return;
    }
    if (activeRunTracker.hasActiveThread(sub.parentThreadId)) {
      this.wakeWhenParentIdle(sub.parentThreadId);
      return;
    }
    await this.wake(sub, row);
  }

  private async wake(sub: SubagentRow, row: MessageRow): Promise<void> {
    const count = this.wakeCount.get(row.id) ?? 0;
    if (count >= MAX_WAKES_PER_RESULT) {
      LogsService.warn('subagent result wake limit reached', {
        subagentId: sub.id,
        messageId: row.id,
      });
      return;
    }
    this.wakeCount.set(row.id, count + 1);
    // The woken run reads the row from replay; a copy still queued from an
    // earlier mid-run attempt would show it twice.
    pendingAgentMessages.discardUnreadBySource(sub.parentThreadId, sub.orchestratorAgentId, row.id);
    // The row is committed before the dispatch, so the run it starts has it
    // in replay — mark it seen now: that run ends (and is judged) before
    // dispatchToThread resolves, and its context may be assembled too soon
    // after the row for the replay-time check.
    noteMessageInjected(sub.parentThreadId, sub.orchestratorAgentId, row.id);
    const result = await dispatchToThread({
      threadId: sub.parentThreadId,
      senderId: sub.agentId,
      messageId: row.id,
      message: row.content,
      source: 'tool',
      targetAgentId: sub.orchestratorAgentId,
    });
    // The wave is over: a run it started has already ended and used the
    // mark. Drop it either way so a dispatch that started no run (a race with
    // another run, or a skip) cannot lend it to some later run.
    forgetMessageInjected(sub.parentThreadId, sub.orchestratorAgentId, row.id);
    if (result.reason === 'queued_for_post_run' || result.reason === 'no_dispatch') {
      // Not seen yet: try again once the thread is idle.
      if (activeRunTracker.hasActiveThread(sub.parentThreadId))
        this.wakeWhenParentIdle(sub.parentThreadId);
    }
  }

  /** Wake the orchestrators of undelivered results once the parent thread is idle. */
  private wakeWhenParentIdle(parentThreadId: string): void {
    if (this.waitingParents.has(parentThreadId)) return;
    this.waitingParents.add(parentThreadId);
    void (async () => {
      const deadline = Date.now() + PARENT_IDLE_WAIT_MS;
      try {
        // Idle, and still idle after a grace that lets the ended run's own
        // run:end handling record what it saw.
        for (;;) {
          while (activeRunTracker.hasActiveThread(parentThreadId)) {
            if (Date.now() > deadline) return;
            await sleep(PARENT_IDLE_POLL_MS);
          }
          await sleep(RUN_END_GRACE_MS);
          if (!activeRunTracker.hasActiveThread(parentThreadId)) break;
        }
        await this.deliverPending(parentThreadId);
      } finally {
        this.waitingParents.delete(parentThreadId);
      }
    })().catch((err: unknown) =>
      LogsService.warn('subagent parent-idle wake failed', {
        parentThreadId,
        error: getErrorMessage(err),
      })
    );
  }

  /** Wake each orchestrator in this thread that has undelivered results (one wake per agent). */
  private async deliverPending(parentThreadId: string): Promise<void> {
    const live = await Subagents.listLiveForParent(parentThreadId);
    const woken = new Set<string>();
    for (const sub of live) {
      if (sub.status === 'running' || !sub.lastResultMessageId || sub.deliveredRunId) continue;
      if (woken.has(sub.orchestratorAgentId)) continue;
      const row = await Messages.findById(sub.lastResultMessageId);
      if (!row || isNotice(row)) continue;
      woken.add(sub.orchestratorAgentId);
      await this.wake(sub, row);
    }
  }

  private async onOrchestratorRunEnd(
    runId: string,
    runStatus: RunEndPayload['status'],
    parentThreadId: string,
    orchestratorAgentId: string,
    seen: ReturnType<typeof takeSeen>
  ): Promise<void> {
    // Only a completed run read what it saw. A run that failed (the model
    // call itself, e.g. during a network outage) or was stopped may have had
    // a result in its context without ever acting on it: nothing is marked
    // delivered and no helper is removed, so the next run reads the result
    // from replay and the helper is still there to re-task. No re-wake
    // either: a failing model would fail again at once.
    if (runStatus !== 'completed') return;
    const undelivered = await Subagents.listUndelivered(parentThreadId, orchestratorAgentId);
    if (undelivered.length === 0) return;
    let missed = false;
    for (const sub of undelivered) {
      const row = sub.lastResultMessageId ? await Messages.findById(sub.lastResultMessageId) : null;
      if (!row) continue;
      if (sawResult(seen, row)) {
        await Subagents.markDelivered(sub.id, runId);
      } else {
        // Queued for this run but never injected: the next wake reads it from
        // replay. A notice wakes no one; the next run reads it anyway.
        pendingAgentMessages.discardUnreadBySource(parentThreadId, orchestratorAgentId, row.id);
        if (!isNotice(row)) missed = true;
      }
    }
    for (const sub of await Subagents.listDoneAfterRun(runId)) {
      if (keptAfterDelivery(sub)) continue;
      await this.retire(sub, 'done');
    }
    if (missed) this.wakeWhenParentIdle(parentThreadId);
  }

  /**
   * Remove a helper: delete its thread (messages, tool activity, summaries,
   * memories), take it out of any other thread it joined, archive its agent,
   * mark the row deleted. Its runs stay, thread-less, as usage of the parent
   * thread until that thread is deleted, which takes them (threadDeleteResidue).
   * A helper whose thread is busy is left for the sweep. `notice` (a removal) writes the orchestrator's
   * notice once the thread is gone; its id becomes the latest result, so an
   * op:wait on the helper returns it.
   */
  async retire(
    sub: SubagentRow,
    reason: 'done' | 'idle' | 'orphan' | 'removed',
    notice?: () => Promise<string>
  ): Promise<boolean> {
    const threadId = sub.threadId;
    if (threadId && activeRunTracker.hasActiveThread(threadId)) return false;
    // Read before its participant rows go; bumped once they are gone.
    const joinedThreadIds = await agentThreadIds(sub.agentId);
    if (threadId) {
      try {
        await withReservedThreadTransaction([threadId], async (tx: NodeRunner) => {
          // Its rows in other threads (an @mention, or added before helper
          // threads were guarded) would outlive it as "agent not found".
          await ThreadParticipants.removeAgentFromAllThreads(sub.agentId, tx);
          // Activity first: it is found through runs.thread_id, which the
          // thread delete sets NULL (the runs themselves stay).
          await tx.query(
            `DELETE FROM public.agent_activity_log a
              USING public.runs r
              WHERE r.id = a.run_id AND r.thread_id = $1`,
            [threadId]
          );
          await Messages.deleteByThread(threadId, tx);
          await ThreadSummaries.deleteByThread(threadId, tx);
          await Memories.deleteByThread(threadId, tx);
          await Nodes.deleteOfType(threadId, 'thread', tx);
        });
      } catch (err) {
        LogsService.warn('subagent retire: thread delete failed', {
          subagentId: sub.id,
          threadId,
          error: getErrorMessage(err),
        });
        return false;
      }
      pendingAgentMessages.clearThread(threadId);
      emitThreadDeleted(threadId);
    } else {
      await ThreadParticipants.removeAgentFromAllThreads(sub.agentId);
    }
    // A run in a thread it had joined stops routing mentions to it.
    markThreadsRosterChanged(joinedThreadIds);
    await Agents.archive(sub.agentId);
    let noticeId: string | null = null;
    if (notice) {
      try {
        noticeId = await notice();
      } catch (err) {
        // The helper is gone either way; only the orchestrator's notice is lost.
        LogsService.warn('subagent removal notice failed', {
          subagentId: sub.id,
          error: getErrorMessage(err),
        });
      }
    }
    await Subagents.markDeleted(sub.id, noticeId);
    this.lastRunOutcome.delete(sub.id);
    emitSubagentChanged(sub.parentThreadId, null, sub.id);
    LogsService.socket.event('subagent removed', { subagentId: sub.id, name: sub.name, reason });
    return true;
  }

  /** Remove delivered helpers whose cleanup was deferred, idle helpers, and orphaned helper agents. */
  async sweep(): Promise<void> {
    for (const sub of await Subagents.listDelivered()) {
      if (!keptAfterDelivery(sub)) await this.retire(sub, 'done');
    }
    for (const sub of await Subagents.listIdleSince(IDLE_HELPER_MS)) {
      if (
        sub.status === 'running' &&
        sub.threadId &&
        activeRunTracker.hasActiveThread(sub.threadId)
      ) {
        this.haltReasons.set(sub.id, 'it ran for a day without finishing, so Snaglet stopped it');
        await AbortRunService.abortAgentRun({
          threadId: sub.threadId,
          agentId: sub.agentId,
          abortedBy: { actorKind: 'system', actorId: 'system', actorName: 'system' },
        }).catch((err: unknown) =>
          LogsService.warn('subagent sweep: abort of an idle helper failed', {
            subagentId: sub.id,
            error: getErrorMessage(err),
          })
        );
        continue;
      }
      await this.retire(sub, 'idle');
    }
    for (const agentId of await Subagents.listOrphanHelperAgentIds()) {
      const joinedThreadIds = await agentThreadIds(agentId);
      await ThreadParticipants.removeAgentFromAllThreads(agentId);
      markThreadsRosterChanged(joinedThreadIds);
      await Agents.archive(agentId);
    }
  }

  /**
   * After a restart nothing runs: settle every helper still marked running,
   * clear out retired helpers still listed in other threads, and resume the
   * timed pauses that ended while the server was down.
   */
  async recoverAfterRestart(): Promise<void> {
    for (const sub of await Subagents.listRunning()) {
      if (sub.threadId && activeRunTracker.hasActiveThread(sub.threadId)) continue;
      await this.settleHelper(sub.id, { afterRestart: true });
    }
    await this.sweep();
    // A failed cleanup must not keep timed pauses from resuming.
    await this.removeRetiredHelperParticipants().catch((err: unknown) =>
      LogsService.warn('subagent boot: retired helper participant cleanup failed', {
        error: getErrorMessage(err),
      })
    );
    await this.resumeDue();
  }

  /**
   * Take retired helpers out of threads that still list them as participants
   * (shown as "Agent record not found"). Runs at boot after the sweep (which
   * archives orphaned helpers); idempotent.
   */
  async removeRetiredHelperParticipants(): Promise<number> {
    const removed = await Subagents.removeRetiredHelperParticipants();
    if (removed > 0)
      LogsService.info('subagent boot: removed retired helpers from threads', {
        participants: removed,
      });
    return removed;
  }

  resetForTests(): void {
    this.lastRunOutcome.clear();
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
    this.locks.clear();
    this.pendingPause.clear();
    this.pendingRemoval.clear();
    this.wakeCount.clear();
    this.waitingParents.clear();
    this.runEndsInFlight.clear();
    this.haltReasons.clear();
  }
}

/** A run error as one plain line for the orchestrator (no stack, paths or keys); null when empty. */
function plainReason(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  return text ? summarizeError(text, 'runtime') : null;
}

/** The agent turn time limit in seconds, when one is set (0 = none). */
async function turnTimeoutSeconds(): Promise<number | null> {
  const seconds = await settingsService.read(agentSettings.timeoutSeconds).catch(() => 0);
  return seconds > 0 ? seconds : null;
}

export const subagentService = new SubagentServiceImpl();
