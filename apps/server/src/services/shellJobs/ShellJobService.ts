/**
 * ShellJobService — tells an agent when a background shell job it started
 * ends (`shell` op:run with `background: true`). Modeled on subagent result
 * delivery (SubagentService), with less to track: a job has one owner, one
 * result, and its output lives in the shell session.
 *
 *   start   → the job is still running past its start window: an
 *             agent-private start row in its thread ("[shell job 4 started in
 *             the background …]"). It is what boot recovery reads.
 *   end     → an agent-private end row with the outcome, the run time and the
 *             tail of the output. Delivered:
 *               - mid-run: queued (pendingAgentMessages) and read at the
 *                 agent's next tool step; if that run ends without reading
 *                 it, the agent is woken instead;
 *               - idle: the agent is woken once, when the thread is idle,
 *                 through the same dispatch path subagent reports use. A run
 *                 it has meanwhile (which reads the row from replay) cancels
 *                 the wake. At most one wake per job.
 *             The session stays the source of truth: op:write reads its
 *             remaining output until the session is cleaned up.
 *   owner   → archiving or deleting the agent kills its jobs (end row, no
 *             delivery). Stop does not: a background job is detached from
 *             the run that started it.
 *   restart → jobs die with the server (killAllShellSessions on a graceful
 *             shutdown). On boot, every start row without an end row is a job
 *             the restart cut off: its leftover process group is reaped when
 *             it provably is the job (a crash leaves it running), an end row
 *             says it was lost, and the agent is woken once.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Agents } from '@snaglet/db/tables/agents';
import { Messages, type MessageRow } from '@snaglet/db/tables/messages';
import { SHELL_JOB_ENDED_EVENT_KIND, SHELL_JOB_STARTED_EVENT_KIND } from '@snaglet/shared/types';
import { getErrorMessage, isoNow, isoStamp, sleep } from '@snaglet/shared/utils';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { hooks } from '@server/services/HookService';
import { LogsService } from '@server/services/LogsService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { wsService } from '@server/services/WebSocketService';
import { dispatchToThread } from '@server/services/SocketService/dispatch/dispatchToThread';
import {
  setBackgroundJobReporter,
  type BackgroundJobReporter,
  type BackgroundJobStart,
} from '@server/services/ToolService/tools/shell/backgroundJobs';
import {
  killBackgroundShellJobs,
  type ShellSessionEnd,
} from '@server/services/ToolService/tools/shell/codex-shell-sessions';
import { reapOrphanGroup, type ReapOutcome } from './orphanReaper';
import { endedText, lostText, startedText, wakeSeed } from './shellJobText';

/** The sender name a queued mid-run report carries (narration, not a principal). */
const REPORT_SENDER_NAME = 'thread state';
/** senderId of a wake: not a participant, so it never filters the owner out. */
const WAKE_SENDER_ID = 'system';
/** Longest a report waits for a busy thread before its wake is dropped. */
const IDLE_WAIT_MS = 30 * 60_000;
const IDLE_POLL_MS = 1_000;
/** After the thread goes idle, time for the last run's end handling to finish. */
const RUN_END_GRACE_MS = 750;
const BOOT_RECOVERY_DELAY_MS = 10_000;
/** Start rows older than this are not recovered (a server down longer forgets them). */
const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60_000;
const COMMAND_METADATA_CHARS = 2_000;
/** This server process. Its own start rows are live jobs, never recovered. */
const SERVER_INSTANCE_ID = randomUUID();

interface RunEndPayload {
  agentId?: string;
  threadId?: string;
}

/** A report on its way to its agent. */
interface Delivery {
  jobId: string;
  sessionId: number;
  threadId: string;
  agentId: string;
  row: MessageRow;
}

interface IdleWait extends Delivery {
  /** The agent ran in the thread after the row was written: it read it from replay. */
  seen: boolean;
}

function isAgentRunning(threadId: string, agentId: string): boolean {
  return activeWorkRegistry
    .snapshot()
    .some(
      (item) => item.kind === 'thread-run' && item.threadId === threadId && item.agentId === agentId
    );
}

/**
 * A live process other than this one: another server may still own the job.
 * This process's own pid counts as dead (a predecessor that had the same pid);
 * its own rows are told apart by SERVER_INSTANCE_ID.
 */
function isOtherProcessAlive(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM: alive, owned by another user.
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

function metaString(row: MessageRow, key: string): string | null {
  const value = row.metadata?.[key];
  return typeof value === 'string' ? value : null;
}

function metaNumber(row: MessageRow, key: string): number | null {
  const value = Number(row.metadata?.[key]);
  return Number.isFinite(value) ? value : null;
}

class ShellJobServiceImpl implements BackgroundJobReporter {
  private initialized = false;
  private stopped = false;
  private bootTimer: NodeJS.Timeout | null = null;
  /** Start-row writes in flight, by job: an end row waits for its start row. */
  private starting = new Map<string, Promise<void>>();
  /** Reports queued for a running agent, by row id, settled at that run's end. */
  private midRun = new Map<string, Delivery>();
  /** Reports waiting for an idle thread to wake their agent, by row id. */
  private idleWaits = new Map<string, IdleWait>();
  /** Jobs whose one wake is spent. */
  private woken = new Set<string>();

  private readonly onRunEndListener = (payload: RunEndPayload): void => {
    this.onRunEnd(payload);
  };

  private readonly onAgentUpdateListener = (payload: { id: string; changed: string[] }): void => {
    if (!payload.changed.includes('archived')) return;
    void this.killJobsIfArchived(payload.id).catch((err: unknown) =>
      LogsService.warn('shell job archive check failed', {
        agentId: payload.id,
        error: getErrorMessage(err),
      })
    );
  };

  private readonly onAgentDeleteListener = (payload: { id: string }): void => {
    this.killJobsOf(payload.id);
  };

  /**
   * Register as the shell tool's background reporter, subscribe to run ends
   * and agent archive/delete, and schedule boot recovery. Tests pass
   * `recoverAfterRestart: false` to keep the boot timer out.
   */
  init(opts: { recoverAfterRestart?: boolean } = {}): void {
    if (this.initialized) return;
    this.initialized = true;
    this.stopped = false;
    setBackgroundJobReporter(this);
    hooks.on('run:end', this.onRunEndListener);
    hooks.on('agent:update', this.onAgentUpdateListener);
    hooks.on('agent:delete', this.onAgentDeleteListener);
    if (opts.recoverAfterRestart === false) return;
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.recoverAfterRestart().catch((err: unknown) =>
        LogsService.warn('shell job boot recovery failed', { error: getErrorMessage(err) })
      );
    }, BOOT_RECOVERY_DELAY_MS);
    this.bootTimer.unref?.();
  }

  /**
   * Stop reporting: no new background jobs, and jobs ended by the shutdown
   * kill are left for the next boot's recovery (the database is closing).
   */
  shutdown(): void {
    if (!this.initialized) return;
    this.initialized = false;
    this.stopped = true;
    setBackgroundJobReporter(null);
    hooks.off('run:end', this.onRunEndListener);
    hooks.off('agent:update', this.onAgentUpdateListener);
    hooks.off('agent:delete', this.onAgentDeleteListener);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
  }

  // Reporter

  async started(job: BackgroundJobStart): Promise<void> {
    const write = this.writeStartRow(job).catch((err: unknown) => {
      // The job still runs and still reports; only boot recovery loses it.
      LogsService.warn('shell job start row failed', {
        jobId: job.jobId,
        threadId: job.threadId,
        error: getErrorMessage(err),
      });
    });
    this.starting.set(job.jobId, write);
    await write;
  }

  ended(job: BackgroundJobStart, end: ShellSessionEnd): void {
    void this.onJobEnded(job, end).catch((err: unknown) =>
      LogsService.warn('shell job report failed', {
        jobId: job.jobId,
        threadId: job.threadId,
        error: getErrorMessage(err),
      })
    );
  }

  // Rows

  private async writeStartRow(job: BackgroundJobStart): Promise<void> {
    const content = startedText(job);
    const row = await Messages.createEvent({
      threadId: job.threadId,
      content,
      eventKind: SHELL_JOB_STARTED_EVENT_KIND,
      visibleToAgentId: job.agentId,
      metadata: {
        shell_job_id: job.jobId,
        shell_session_id: job.sessionId,
        shell_command: job.command.slice(0, COMMAND_METADATA_CHARS),
        shell_pid: job.pid,
        shell_started_at: new Date(job.startedAt).toISOString(),
        shell_limit_ms: job.limitMs,
        // Boot recovery only touches jobs this machine's dead server owned.
        shell_host: os.hostname(),
        shell_server_pid: process.pid,
        shell_server_instance: SERVER_INSTANCE_ID,
      },
    });
    this.broadcastRow(job.threadId, job.agentId, row, SHELL_JOB_STARTED_EVENT_KIND);
  }

  private async writeEndRow(input: {
    jobId: string;
    sessionId: number;
    threadId: string;
    agentId: string;
    content: string;
    metadata: Record<string, unknown>;
  }): Promise<MessageRow> {
    const row = await Messages.createEvent({
      threadId: input.threadId,
      content: input.content,
      eventKind: SHELL_JOB_ENDED_EVENT_KIND,
      visibleToAgentId: input.agentId,
      metadata: {
        shell_job_id: input.jobId,
        shell_session_id: input.sessionId,
        ...input.metadata,
      },
    });
    this.broadcastRow(input.threadId, input.agentId, row, SHELL_JOB_ENDED_EVENT_KIND);
    return row;
  }

  private broadcastRow(
    threadId: string,
    agentId: string,
    row: MessageRow,
    eventKind: string
  ): void {
    wsService.broadcastToChannel(threadId, {
      type: 'socket:chat:message_created',
      payload: {
        id: row.id,
        threadId,
        role: 'user',
        content: row.content,
        created_at: row.createdAt ? isoStamp(row.createdAt) : isoNow(),
        message_type: 'thread_event',
        visible_to_agent_id: agentId,
        event_kind: eventKind,
      },
    });
  }

  // End of a job

  private async onJobEnded(job: BackgroundJobStart, end: ShellSessionEnd): Promise<void> {
    await this.starting.get(job.jobId);
    this.starting.delete(job.jobId);
    // Killed by the shutdown, or ended while stopping: the next boot reports it.
    if (end.killReason === 'shutdown' || this.stopped) return;
    const row = await this.writeEndRow({
      jobId: job.jobId,
      sessionId: job.sessionId,
      threadId: job.threadId,
      agentId: job.agentId,
      content: endedText(end),
      metadata: {
        shell_exit_code: end.exitCode,
        shell_signal: end.signal,
        shell_kill_reason: end.killReason,
        shell_ran_ms: end.endedAt - end.startedAt,
      },
    });
    LogsService.socket.event('shell job ended', {
      jobId: job.jobId,
      sessionId: job.sessionId,
      threadId: job.threadId,
      agentId: job.agentId,
      exitCode: end.exitCode,
      killReason: end.killReason,
    });
    // Its agent is gone: the row is the record, nobody to tell.
    if (end.killReason === 'owner-removed') return;
    this.deliver({
      jobId: job.jobId,
      sessionId: job.sessionId,
      threadId: job.threadId,
      agentId: job.agentId,
      row,
    });
  }

  /** Mid-run if the agent is running in the thread, otherwise a wake once it is idle. */
  private deliver(delivery: Delivery): void {
    const { threadId, agentId, row } = delivery;
    if (isAgentRunning(threadId, agentId)) {
      pendingAgentMessages.enqueue({
        threadId,
        targetAgentId: agentId,
        senderName: REPORT_SENDER_NAME,
        content: row.content,
        reason: 'system',
        sourceMessageId: row.id,
      });
      this.midRun.set(row.id, delivery);
      return;
    }
    this.wakeWhenIdle(delivery);
  }

  private onRunEnd(payload: RunEndPayload): void {
    const { agentId, threadId } = payload;
    if (!agentId || !threadId) return;
    // A run that started after an idle report's row was written read it from replay.
    for (const wait of this.idleWaits.values()) {
      if (wait.threadId === threadId && wait.agentId === agentId) wait.seen = true;
    }
    for (const [rowId, delivery] of this.midRun) {
      if (delivery.threadId !== threadId || delivery.agentId !== agentId) continue;
      this.midRun.delete(rowId);
      const unread = pendingAgentMessages
        .listUnread(threadId, agentId)
        .some((m) => m.sourceMessageId === rowId);
      if (!unread) continue;
      // The run ended before another tool step: the next run reads the row
      // from replay, so drop the queued copy and wake the agent for it.
      pendingAgentMessages.discardUnreadBySource(threadId, agentId, rowId);
      this.wakeWhenIdle(delivery);
    }
  }

  private wakeWhenIdle(delivery: Delivery): void {
    if (this.woken.has(delivery.jobId) || this.idleWaits.has(delivery.row.id)) return;
    const wait: IdleWait = { ...delivery, seen: false };
    this.idleWaits.set(delivery.row.id, wait);
    void this.wakeOnceIdle(wait)
      .catch((err: unknown) =>
        LogsService.warn('shell job wake failed', {
          jobId: wait.jobId,
          threadId: wait.threadId,
          error: getErrorMessage(err),
        })
      )
      .finally(() => this.idleWaits.delete(delivery.row.id));
  }

  private async wakeOnceIdle(wait: IdleWait): Promise<void> {
    const deadline = Date.now() + IDLE_WAIT_MS;
    for (;;) {
      // Idle, and still idle after a grace that lets an ended run's own
      // run:end handling mark the report seen.
      while (activeRunTracker.hasActiveThread(wait.threadId)) {
        if (wait.seen || this.stopped) return;
        if (Date.now() > deadline) {
          LogsService.warn('shell job wake dropped: thread stayed busy', {
            jobId: wait.jobId,
            threadId: wait.threadId,
          });
          return;
        }
        await sleep(IDLE_POLL_MS);
      }
      await sleep(RUN_END_GRACE_MS);
      if (wait.seen || this.stopped || this.woken.has(wait.jobId)) return;
      if (activeRunTracker.hasActiveThread(wait.threadId)) continue;
      const result = await dispatchToThread({
        threadId: wait.threadId,
        senderId: WAKE_SENDER_ID,
        messageId: wait.row.id,
        message: wakeSeed(wait.sessionId),
        source: 'tool',
        targetAgentId: wait.agentId,
      });
      // The thread got busy in between: wait again (this was not the wake).
      if (result.reason === 'queued_for_post_run' && Date.now() <= deadline) continue;
      this.woken.add(wait.jobId);
      return;
    }
  }

  // Owner removed

  private async killJobsIfArchived(agentId: string): Promise<void> {
    const agent = await Agents.findById(agentId);
    if (!agent || agent.archived) this.killJobsOf(agentId);
  }

  private killJobsOf(agentId: string): void {
    const killed = killBackgroundShellJobs({ agentId }, 'owner-removed');
    if (killed > 0)
      LogsService.socket.event('shell jobs killed with their agent', { agentId, killed });
  }

  // Restart

  /**
   * Every start row without an end row is a job a restart cut off: reap its
   * leftover processes when they provably are the job, write an end row that
   * says it was lost, and wake its agent once. Rows another live server (or
   * another machine sharing the database) may own are left alone.
   */
  async recoverAfterRestart(): Promise<void> {
    const since = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
    const starts = await Messages.listUnansweredEvents({
      startKind: SHELL_JOB_STARTED_EVENT_KIND,
      endKind: SHELL_JOB_ENDED_EVENT_KIND,
      pairKey: 'shell_job_id',
      since,
    });
    for (const start of starts) {
      if (this.stopped) return;
      await this.recoverOne(start).catch((err: unknown) =>
        LogsService.warn('shell job recovery failed', {
          messageId: start.id,
          error: getErrorMessage(err),
        })
      );
    }
  }

  private async recoverOne(start: MessageRow): Promise<void> {
    const jobId = metaString(start, 'shell_job_id');
    const agentId = start.visibleToAgentId;
    const sessionId = metaNumber(start, 'shell_session_id');
    if (!jobId || !agentId || sessionId === null) return;
    if (metaString(start, 'shell_host') !== os.hostname()) return;
    // Started by this process (a job begun before recovery ran): still live.
    if (metaString(start, 'shell_server_instance') === SERVER_INSTANCE_ID) return;
    if (isOtherProcessAlive(start.metadata?.shell_server_pid)) return;
    const startedAt = Date.parse(metaString(start, 'shell_started_at') ?? start.createdAt);
    const pid = metaNumber(start, 'shell_pid');
    const reaped: ReapOutcome =
      pid !== null && Number.isFinite(startedAt)
        ? await reapOrphanGroup({ pgid: pid, startedAt })
        : 'none';
    const command = metaString(start, 'shell_command') ?? '';
    const row = await this.writeEndRow({
      jobId,
      sessionId,
      threadId: start.threadId,
      agentId,
      content: lostText({ sessionId, command, startedAt, now: Date.now(), reaped }),
      metadata: { shell_lost: true, shell_reaped: reaped },
    });
    LogsService.socket.event('shell job lost to a restart', {
      jobId,
      threadId: start.threadId,
      agentId,
      reaped,
    });
    this.deliver({ jobId, sessionId, threadId: start.threadId, agentId, row });
  }

  resetForTests(): void {
    this.starting.clear();
    this.midRun.clear();
    this.idleWaits.clear();
    this.woken.clear();
  }
}

export const shellJobService = new ShellJobServiceImpl();
