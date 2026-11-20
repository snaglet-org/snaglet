/**
 * Pausing, resuming and removing subagent helpers against the real
 * database, with dispatch stubbed (no model calls):
 *
 * - pause stops the helper's run and keeps it (status 'stopped') through its
 *   orchestrator's next completed run; op:send resumes it with its thread;
 * - remove retires it at once; both tell the orchestrator with a notice row
 *   that never wakes it, and op:wait returns at once with that notice;
 * - a timed pause resumes at resume_at (driven through the check, no real
 *   waiting), also after a restart; a redirect clears the timer; the idle
 *   sweep leaves a timed helper alone;
 * - an agent acts only on its own helpers, the user on any, also through the
 *   REST routes the UI calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

type DispatchInput = { threadId: string; targetAgentId?: string; messageId?: string };
const mockDispatch = jest.fn(async (_input: DispatchInput) => ({
  ok: true,
  reason: 'dispatched',
  wakeCount: 1,
  capHit: false,
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@server/services/SocketService/dispatch/dispatchToThread'
  ),
  dispatchToThread: (input: DispatchInput) => mockDispatch(input),
}));

import { Agents, Messages, Threads, ThreadParticipants, getDb } from '@snaglet/db';
import { Subagents, type SubagentRow } from '@snaglet/db/tables/subagents';
import { Users } from '@snaglet/db/tables/users';
import { errorHandler } from '@server/middleware';
import { registerSubagentRoutes } from '@server/domains/threads/handlers/subagentHandlers';
import { runWithActor } from '@server/realtime/actorContext';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { wsService } from '@server/services/WebSocketService';
import { hooks } from '@server/services/HookService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import {
  clearAgentAbortController,
  createAbortController,
  createAgentAbortController,
} from '@server/services/SocketService/abortStore';
import { noteContextAssemblyStarted } from '@server/services/subagents/resultVisibility';
import { describeResumeTime } from '@server/services/subagents/subagentText';
import { helperTurnHeld } from '@server/services/subagents/turnGate';
import {
  SUBAGENT_RESUME_MESSAGE,
  subagentService,
  type SubagentActor,
} from '@server/services/subagents/SubagentService';

const ORCH = 'test-agent-a';
const OTHER = 'test-agent-b';
const USER: SubagentActor = { kind: 'user', userId: 'user-test-1', name: 'Test User' };
const MINE: SubagentActor = { kind: 'orchestrator', agentId: ORCH };

let providerId = '';
let fastModel = '';
let strongModel = '';
let parentCount = 0;

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 6000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`waitFor timed out; last value ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

async function insertRun(id: string, threadId: string, agentId: string, status: string) {
  await getDb().query(
    `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [id, threadId, agentId, providerId, fastModel, status]
  );
}

/** A fresh parent thread with the orchestrator in it, so tests never share helpers. */
async function newParent(): Promise<string> {
  parentCount += 1;
  const id = `thread-1111111111111-pause${String(parentCount).padStart(4, '0')}`;
  await Threads.create({ id, title: `Parent ${parentCount}` });
  await ThreadParticipants.addParticipant({ threadId: id, agentId: ORCH });
  return id;
}

function startHelper(parentThreadId: string, name: string, orchestratorAgentId = ORCH) {
  return subagentService.start({
    orchestratorAgentId,
    parentThreadId,
    name,
    model: fastModel,
    brief: `Brief for ${name}.`,
  });
}

/**
 * A live run of the helper that unwinds like the turn loop when aborted:
 * the run ends 'aborted' and the thread is released.
 */
function liveHelperRun(sub: SubagentRow, runId: string) {
  const threadId = sub.threadId!;
  const session = `test-session-${runId}`;
  expect(activeRunTracker.startSession(session, threadId)).toBe(true);
  const parent = createAbortController(session, threadId);
  const controller = createAgentAbortController(session, threadId, sub.agentId, parent.signal);
  let ended = false;
  const end = async (status: 'completed' | 'aborted', reply?: string) => {
    if (ended) return;
    ended = true;
    if (reply) {
      await Messages.create({
        threadId,
        role: 'assistant',
        agentId: sub.agentId,
        content: reply,
        messageType: 'message',
      });
    }
    await insertRun(runId, threadId, sub.agentId, status === 'aborted' ? 'failed' : 'completed');
    hooks.emit('run:end', { runId, agentId: sub.agentId, threadId, status });
    clearAgentAbortController(threadId, sub.agentId, controller);
    // The wave's teardown releases the thread a moment after the run's end.
    setTimeout(() => activeRunTracker.finishSession(session), 30);
  };
  controller.signal.addEventListener('abort', () => void end('aborted'), { once: true });
  return { end };
}

/** The orchestrator ran in `parent`; `assembledAt` is when its context was built. */
async function orchestratorRunEnds(parent: string, runId: string, assembledAt: number) {
  await insertRun(runId, parent, ORCH, 'completed');
  noteContextAssemblyStarted(parent, ORCH, assembledAt);
  hooks.emit('run:end', { runId, agentId: ORCH, threadId: parent, status: 'completed' });
}

function wakesFor(threadId: string) {
  return mockDispatch.mock.calls
    .map(([input]) => input)
    .filter((input) => input.threadId === threadId);
}

async function resultRows(parent: string, subagentId: string) {
  const { rows } = await getDb().query<{ id: string; content: string; metadata: unknown }>(
    `SELECT id, content, metadata FROM public.messages
      WHERE thread_id = $1 AND metadata->>'subagent_id' = $2
      ORDER BY created_at, id`,
    [parent, subagentId]
  );
  return rows;
}

async function helperThreadMessages(threadId: string) {
  const { rows } = await getDb().query<{ agent_id: string | null; content: string }>(
    `SELECT agent_id, content FROM public.messages
      WHERE thread_id = $1 AND message_type = 'message'
      ORDER BY created_at, id`,
    [threadId]
  );
  return rows;
}

/** Move a helper's timed pause into the past, as if the time had come. */
async function makeDue(id: string) {
  await getDb().query(
    `UPDATE public.subagents SET resume_at = now() - interval '1 second' WHERE id = $1`,
    [id]
  );
}

beforeAll(async () => {
  const { rows } = await getDb().query<{ provider_id: string; model_ids: string[] }>(
    `SELECT provider_id, array_agg(model_id ORDER BY sort_order, model_id) AS model_ids
       FROM public.models
      WHERE is_active AND supports_tools AND type = 'llm'
      GROUP BY provider_id HAVING count(*) >= 2
      ORDER BY provider_id`
  );
  if (rows.length < 1) throw new Error('seed needs a provider with two tool-capable models');
  providerId = rows[0]!.provider_id;
  [fastModel, strongModel] = rows[0]!.model_ids as [string, string];

  await Agents.create({ id: ORCH, name: 'Test Agent A', providerId, modelId: strongModel });
  await Agents.create({ id: OTHER, name: 'Test Agent B', providerId, modelId: strongModel });
  subagentService.init({ recoverAfterRestart: false });
});

afterAll(() => {
  subagentService.shutdown();
});

beforeEach(() => {
  mockDispatch.mockClear();
});

describe('subagent pause', () => {
  it('stops a running helper and keeps it; the orchestrator gets a notice and is not woken', async () => {
    const parent = await newParent();
    const echo = await startHelper(parent, 'Echo');
    liveHelperRun(echo, 'run-echo-1');
    mockDispatch.mockClear();

    const { sub, interrupted, done } = await subagentService.pause({
      parentThreadId: parent,
      ref: 'Echo',
      by: USER,
    });
    expect({ interrupted, done }).toEqual({ interrupted: true, done: true });
    expect(sub).toMatchObject({ status: 'stopped', resumeAt: null, deletedAt: null });
    expect(await Threads.findById(echo.threadId!)).not.toBeNull();

    await settle();
    // One row for the orchestrator: the notice, not a "stopped" result as well.
    const rows = await resultRows(parent, echo.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content.split('\n')[0]).toBe('[subagent Echo paused by Test User]');
    expect(rows[0]!.content).toContain('leave it paused unless they ask you to resume it');
    expect(rows[0]!.metadata).toMatchObject({
      subagent_notice: 'paused',
      subagent_notice_by: 'Test User',
      subagent_status: 'stopped',
    });
    expect((await Subagents.findById(echo.id))!.lastResultMessageId).toBe(rows[0]!.id);
    expect(wakesFor(parent)).toHaveLength(0);
  });

  it('queues the notice for a running orchestrator, still without a wake', async () => {
    const parent = await newParent();
    const echo = await startHelper(parent, 'Echo');
    const session = 'test-session-orch-running';
    expect(activeRunTracker.startSession(session, parent)).toBe(true);
    activeWorkRegistry.registerThreadRun({
      id: 'run-orch-running',
      agentId: ORCH,
      agentName: 'Test Agent A',
      threadId: parent,
      threadTitle: 'Parent',
    });
    try {
      mockDispatch.mockClear();
      await subagentService.pause({ parentThreadId: parent, ref: 'Echo', by: USER });
      const notice = (await Subagents.findById(echo.id))!.lastResultMessageId;
      expect(pendingAgentMessages.listUnread(parent, ORCH).map((m) => m.sourceMessageId)).toEqual([
        notice,
      ]);
    } finally {
      activeWorkRegistry.unregister('run-orch-running');
      activeRunTracker.finishSession(session);
    }
    await settle();
    expect(wakesFor(parent)).toHaveLength(0);
  });

  it("a paused helper outlives the orchestrator's next completed run; op:send resumes it with its thread", async () => {
    const parent = await newParent();
    const echo = await startHelper(parent, 'Echo');
    liveHelperRun(echo, 'run-echo-keep-1');
    await subagentService.pause({ parentThreadId: parent, ref: 'Echo', by: USER });

    await orchestratorRunEnds(parent, 'run-orch-keep-1', Date.now() + 1000);
    const delivered = await waitFor(
      () => Subagents.findById(echo.id),
      (row) => row?.deliveredRunId === 'run-orch-keep-1'
    );
    expect(delivered).toMatchObject({ status: 'stopped', deletedAt: null });
    expect(await Threads.findById(echo.threadId!)).not.toBeNull();
    await subagentService.sweep();
    expect((await Subagents.findById(echo.id))!.deletedAt).toBeNull();

    mockDispatch.mockClear();
    const resumed = await subagentService.send({
      orchestratorAgentId: ORCH,
      parentThreadId: parent,
      ref: 'Echo',
      message: 'Focus on the second half instead.',
    });
    expect(resumed).toMatchObject({ status: 'running', taskCount: 2 });
    expect(wakesFor(echo.threadId!)).toHaveLength(1);
    // Same thread: the brief and the redirect, so the helper keeps its context.
    expect((await helperThreadMessages(echo.threadId!)).map((m) => m.content)).toEqual([
      'Brief for Echo.',
      'Focus on the second half instead.',
    ]);
  });

  it("the orchestrator's own pause says by you and counts as read by its run", async () => {
    const parent = await newParent();
    const echo = await startHelper(parent, 'Echo');
    const { sub } = await subagentService.pause({ parentThreadId: parent, ref: 'Echo', by: MINE });
    const notice = await Messages.findById(sub.lastResultMessageId!);
    expect(notice!.content.split('\n')[0]).toBe('[subagent Echo paused by you]');
    expect(notice!.content).not.toContain('unless they ask');

    // Its context was built long before the notice: only the tool call makes it read.
    await orchestratorRunEnds(parent, 'run-orch-own-pause', Date.now() - 60_000);
    await waitFor(
      () => Subagents.findById(echo.id),
      (row) => row?.deliveredRunId === 'run-orch-own-pause'
    );
    expect((await Subagents.findById(echo.id))!.deletedAt).toBeNull();
  });
});

describe('a pause never loses a report or lets a queued turn run', () => {
  /** The helper writes its report and its run ends, as the turn loop would. */
  async function helperFinishes(sub: SubagentRow, runId: string, reply: string) {
    await Messages.create({
      threadId: sub.threadId!,
      role: 'assistant',
      agentId: sub.agentId,
      content: reply,
      messageType: 'message',
    });
    await insertRun(runId, sub.threadId!, sub.agentId, 'completed');
    hooks.emit('run:end', {
      runId,
      agentId: sub.agentId,
      threadId: sub.threadId!,
      status: 'completed',
    });
  }

  it('pausing a finished helper whose report waits on a busy parent keeps the report and its wake', async () => {
    const parent = await newParent();
    const done = await startHelper(parent, 'Done');
    // Another run holds the parent thread; the orchestrator is not that run.
    const session = 'test-session-busy-parent';
    expect(activeRunTracker.startSession(session, parent)).toBe(true);
    let report: string;
    try {
      mockDispatch.mockClear();
      await helperFinishes(done, 'run-done-1', 'All 12 links work.');
      const finished = await waitFor(
        () => Subagents.findById(done.id),
        (row) => row?.status === 'finished'
      );
      report = finished!.lastResultMessageId!;
      expect(wakesFor(parent)).toHaveLength(0);

      const { sub, interrupted } = await subagentService.pause({
        parentThreadId: parent,
        ref: 'Done',
        by: USER,
      });
      expect(interrupted).toBe(false);
      // Kept, paused, and the report is still the result waiting to be read.
      expect(sub).toMatchObject({
        status: 'stopped',
        lastResultMessageId: report,
        deliveredRunId: null,
      });
      const rows = await resultRows(parent, done.id);
      expect(rows.map((r) => r.content.split('\n')[0])).toEqual([
        '[subagent Done finished]',
        '[subagent Done paused by Test User]',
      ]);
    } finally {
      activeRunTracker.finishSession(session);
    }

    // The parent frees up: the orchestrator is woken with the report.
    const wakes = await waitFor(
      async () => wakesFor(parent),
      (w) => w.length > 0
    );
    expect(wakes[0]).toMatchObject({ targetAgentId: ORCH, messageId: report });
    await orchestratorRunEnds(parent, 'run-orch-read-done', Date.now() + 1000);
    const delivered = await waitFor(
      () => Subagents.findById(done.id),
      (row) => row?.deliveredRunId === 'run-orch-read-done'
    );
    expect(delivered).toMatchObject({ status: 'stopped', deletedAt: null });
  });

  it('a run that ends on its own just as the pause lands still reports, then the helper is kept', async () => {
    const parent = await newParent();
    const quick = await startHelper(parent, 'Quick');
    mockDispatch.mockClear();
    await helperFinishes(quick, 'run-quick-1', 'Done: 3 matches.');
    // The run has ended; its result is not written yet (the settle delay).
    await settle(50);
    const { sub } = await subagentService.pause({ parentThreadId: parent, ref: 'Quick', by: USER });

    const rows = await resultRows(parent, quick.id);
    expect(rows.map((r) => r.content.split('\n').slice(0, 2))).toEqual([
      ['[subagent Quick finished]', 'Done: 3 matches.'],
      ['[subagent Quick paused by Test User]', expect.any(String)],
    ]);
    expect(sub).toMatchObject({ status: 'stopped', lastResultMessageId: rows[0]!.id });
    expect(wakesFor(parent)).toEqual([
      expect.objectContaining({ targetAgentId: ORCH, messageId: rows[0]!.id }),
    ]);
    await settle(500);
    expect(await resultRows(parent, quick.id)).toHaveLength(2);
  });

  it('a turn queued by op:send before the pause is dropped; one triggered after it runs', async () => {
    const parent = await newParent();
    const queued = await startHelper(parent, 'Queued');
    await helperFinishes(queued, 'run-queued-1', 'First pass done.');
    await waitFor(
      () => Subagents.findById(queued.id),
      (row) => row?.status === 'finished'
    );

    // op:send posts its message and dispatches; the turn has not started yet.
    mockDispatch.mockClear();
    await subagentService.send({
      orchestratorAgentId: ORCH,
      parentThreadId: parent,
      ref: 'Queued',
      message: 'Now do the second pass.',
    });
    const sendWake = wakesFor(queued.threadId!)[0]!;
    expect(sendWake.messageId).toBeTruthy();
    await settle(20);
    await subagentService.pause({ parentThreadId: parent, ref: 'Queued', by: USER });

    // The queued turn reaches the turn gate: dropped before any model call.
    expect(await helperTurnHeld(queued.agentId, sendWake.messageId)).toBe(true);
    expect(await Subagents.findById(queued.id)).toMatchObject({ status: 'stopped' });
    const { rows: runs } = await getDb().query(
      `SELECT id FROM public.runs WHERE thread_id = $1 AND id <> 'run-queued-1'`,
      [queued.threadId]
    );
    expect(runs).toHaveLength(0);

    // The user writing to it after the pause runs as usual.
    await settle(20);
    const typed = await Messages.create({
      threadId: queued.threadId!,
      role: 'user',
      userId: (await Users.getOrCreateLocalUser()).id,
      content: 'Do the second pass after all.',
    });
    expect(await helperTurnHeld(queued.agentId, typed.id)).toBe(false);

    // So does op:send after the pause (it resumes it first).
    mockDispatch.mockClear();
    await subagentService.send({
      orchestratorAgentId: ORCH,
      parentThreadId: parent,
      ref: 'Queued',
      message: 'Go.',
    });
    expect(await helperTurnHeld(queued.agentId, wakesFor(queued.threadId!)[0]!.messageId)).toBe(
      false
    );
    // Ordinary agents never pass through the check.
    expect(await helperTurnHeld(ORCH, sendWake.messageId)).toBe(false);
  });

  it('a turn queued before a removal is dropped', async () => {
    const parent = await newParent();
    const gone = await startHelper(parent, 'Gone');
    const brief = wakesFor(gone.threadId!)[0]!;
    await subagentService.remove({ parentThreadId: parent, ref: 'Gone', by: USER });
    expect(await helperTurnHeld(gone.agentId, brief.messageId)).toBe(true);
  });
});

describe('live result rows', () => {
  it('carry created_at in UTC, the same form as live user messages, so they sort in place', async () => {
    const parent = await newParent();
    await startHelper(parent, 'Utc');
    const broadcast = jest.spyOn(wsService, 'broadcastToChannel');
    try {
      const { sub } = await subagentService.pause({ parentThreadId: parent, ref: 'Utc', by: USER });
      const row = (await Messages.findById(sub.lastResultMessageId!))!;
      const frame = broadcast.mock.calls
        .map(([, message]) => message as { type: string; payload: Record<string, unknown> })
        .find((m) => m.type === 'socket:chat:message_created' && m.payload.id === row.id);
      expect(frame!.payload.created_at).toBe(new Date(row.createdAt).toISOString());
    } finally {
      broadcast.mockRestore();
    }
  });
});

describe('subagent remove', () => {
  it('stops and retires a running helper at once and tells the orchestrator without waking it', async () => {
    const parent = await newParent();
    const scout = await startHelper(parent, 'Scout');
    liveHelperRun(scout, 'run-scout-1');
    mockDispatch.mockClear();

    const { removed, interrupted } = await subagentService.remove({
      parentThreadId: parent,
      ref: 'Scout',
      by: USER,
    });
    expect({ removed, interrupted }).toEqual({ removed: true, interrupted: true });
    const row = (await Subagents.findById(scout.id))!;
    expect(row.deletedAt).not.toBeNull();
    expect(await Threads.findById(scout.threadId!)).toBeNull();
    expect((await Agents.findById(scout.agentId))!.archived).toBe(true);
    expect(await Subagents.findLiveByName(parent, 'Scout')).toBeNull();

    await settle();
    const rows = await resultRows(parent, scout.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content.split('\n')[0]).toBe('[subagent Scout removed by Test User]');
    expect(rows[0]!.metadata).toMatchObject({
      subagent_notice: 'removed',
      subagent_thread_id: null,
    });
    expect(row.lastResultMessageId).toBe(rows[0]!.id);
    expect(wakesFor(parent)).toHaveLength(0);
  });

  it('removes an idle helper the same way', async () => {
    const parent = await newParent();
    const idle = await startHelper(parent, 'Idle');
    const { removed, interrupted } = await subagentService.remove({
      parentThreadId: parent,
      ref: 'Idle',
      by: MINE,
    });
    expect({ removed, interrupted }).toEqual({ removed: true, interrupted: false });
    const rows = await resultRows(parent, idle.id);
    expect(rows.map((r) => r.content.split('\n')[0])).toEqual(['[subagent Idle removed by you]']);
  });
});

describe('subagent remove: once, and only when it lands', () => {
  it('a removal that fails tells no one and keeps the helper; the retry tells once', async () => {
    const parent = await newParent();
    const keep = await startHelper(parent, 'Stuck');
    // Something else holds the helper's thread, so it cannot be deleted now.
    expect(activeRunTracker.reserveThreadPurge(keep.threadId!)).toBe(true);
    try {
      await expect(
        subagentService.remove({ parentThreadId: parent, ref: 'Stuck', by: USER })
      ).rejects.toThrow("Stuck's thread could not be deleted; try again.");
    } finally {
      activeRunTracker.releaseThreadPurge(keep.threadId!);
    }
    expect(await resultRows(parent, keep.id)).toHaveLength(0);
    expect(await Subagents.findById(keep.id)).toMatchObject({ deletedAt: null });
    expect(await Threads.findById(keep.threadId!)).not.toBeNull();

    const { removed } = await subagentService.remove({
      parentThreadId: parent,
      ref: 'Stuck',
      by: USER,
    });
    expect(removed).toBe(true);
    expect((await resultRows(parent, keep.id)).map((r) => r.content.split('\n')[0])).toEqual([
      '[subagent Stuck removed by Test User]',
    ]);
  });

  it('removing the same helper twice at once writes one notice', async () => {
    const parent = await newParent();
    const twice = await startHelper(parent, 'Twice');
    const results = await Promise.all([
      subagentService.remove({ parentThreadId: parent, ref: twice.id, by: USER }),
      subagentService.remove({ parentThreadId: parent, ref: twice.id, by: USER }),
    ]);
    expect(results.map((r) => r.removed)).toEqual([true, true]);
    await settle();
    expect(await resultRows(parent, twice.id)).toHaveLength(1);
  });

  it('a running orchestrator gets the notice at its next tool call, without a wake', async () => {
    const parent = await newParent();
    const busy = await startHelper(parent, 'Busy');
    const session = 'test-session-orch-remove';
    expect(activeRunTracker.startSession(session, parent)).toBe(true);
    activeWorkRegistry.registerThreadRun({
      id: 'run-orch-remove',
      agentId: ORCH,
      agentName: 'Test Agent A',
      threadId: parent,
      threadTitle: 'Parent',
    });
    try {
      mockDispatch.mockClear();
      await subagentService.remove({ parentThreadId: parent, ref: 'Busy', by: USER });
      const [notice] = await resultRows(parent, busy.id);
      expect(pendingAgentMessages.listUnread(parent, ORCH).map((m) => m.sourceMessageId)).toContain(
        notice!.id
      );
      expect(notice!.content).toContain(`Busy (id ${busy.id}) is gone`);
    } finally {
      activeWorkRegistry.unregister('run-orch-remove');
      activeRunTracker.finishSession(session);
    }
    await settle();
    expect(wakesFor(parent)).toHaveLength(0);
  });
});

describe('op:wait and pause / remove', () => {
  it('returns at once when the helper it waits on is paused, and when one is removed', async () => {
    const parent = await newParent();
    const first = await startHelper(parent, 'First');
    const second = await startHelper(parent, 'Second');
    liveHelperRun(first, 'run-first-1');
    liveHelperRun(second, 'run-second-1');

    const wait = (name: string) =>
      subagentService.wait({
        orchestratorAgentId: ORCH,
        parentThreadId: parent,
        names: [name],
        timeoutMs: 20_000,
      });

    let started = Date.now();
    let waiting = wait('First');
    await settle(200);
    await subagentService.pause({ parentThreadId: parent, ref: 'First', by: USER });
    let { reports, stillRunning } = await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(stillRunning).toEqual([]);
    expect(reports.map((r) => r.content.split('\n')[0])).toEqual([
      '[subagent First paused by Test User]',
    ]);

    started = Date.now();
    waiting = wait('Second');
    await settle(200);
    await subagentService.remove({ parentThreadId: parent, ref: 'Second', by: USER });
    ({ reports, stillRunning } = await waiting);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(stillRunning).toEqual([]);
    expect(reports.map((r) => r.content.split('\n')[0])).toEqual([
      '[subagent Second removed by Test User]',
    ]);
    expect(reports[0]!.sub.id).toBe(second.id);
  });
});

describe('timed pause', () => {
  it('resumes at resume_at through the minute check, once', async () => {
    const parent = await newParent();
    const timer = await startHelper(parent, 'Timer');
    const at = new Date(Date.now() + 60 * 60_000);
    const { sub } = await subagentService.pause({
      parentThreadId: parent,
      ref: 'Timer',
      by: USER,
      resumeAt: at,
    });
    expect(sub.status).toBe('stopped');
    expect(new Date(sub.resumeAt!).toISOString()).toBe(at.toISOString());
    const notice = await Messages.findById(sub.lastResultMessageId!);
    // In words for the agent; the instant itself stays in metadata.
    expect(notice!.content).toContain(`paused until ${describeResumeTime(at.toISOString())}`);
    expect(notice!.content).not.toContain(at.toISOString());
    expect(notice!.metadata).toMatchObject({ subagent_resume_at: at.toISOString() });

    // Not due yet.
    expect(await subagentService.resumeDue()).toEqual([]);

    await makeDue(timer.id);
    mockDispatch.mockClear();
    const resumed = await subagentService.resumeDue();
    expect(resumed.map((r) => r.id)).toEqual([timer.id]);
    expect(await Subagents.findById(timer.id)).toMatchObject({
      status: 'running',
      resumeAt: null,
      taskCount: 2,
    });
    // Told by its orchestrator to continue, in its own thread.
    const messages = await helperThreadMessages(timer.threadId!);
    expect(messages[messages.length - 1]).toEqual({
      agent_id: ORCH,
      content: SUBAGENT_RESUME_MESSAGE,
    });
    expect(wakesFor(timer.threadId!)).toHaveLength(1);
    expect(await subagentService.resumeDue()).toEqual([]);
  });

  it('a pause that ended while the server was down resumes at boot', async () => {
    const parent = await newParent();
    const sleeper = await startHelper(parent, 'Sleeper');
    await subagentService.pause({
      parentThreadId: parent,
      ref: 'Sleeper',
      by: USER,
      resumeAt: new Date(Date.now() + 2 * 60 * 60_000),
    });
    await makeDue(sleeper.id);

    // A restart: in-memory state is gone, only the row remains.
    subagentService.resetForTests();
    await subagentService.recoverAfterRestart();
    expect(await Subagents.findById(sleeper.id)).toMatchObject({
      status: 'running',
      resumeAt: null,
    });
    const messages = await helperThreadMessages(sleeper.threadId!);
    expect(messages[messages.length - 1]!.content).toBe(SUBAGENT_RESUME_MESSAGE);
  });

  it('a redirect replaces the scheduled resume: op:send, or the user writing in its thread', async () => {
    const parent = await newParent();
    const a = await startHelper(parent, 'Redirected');
    const b = await startHelper(parent, 'Written');
    const later = new Date(Date.now() + 60 * 60_000);
    for (const name of ['Redirected', 'Written']) {
      await subagentService.pause({ parentThreadId: parent, ref: name, by: USER, resumeAt: later });
    }

    await subagentService.send({
      orchestratorAgentId: ORCH,
      parentThreadId: parent,
      ref: 'Redirected',
      message: 'Do this instead.',
    });
    expect(await Subagents.findById(a.id)).toMatchObject({ status: 'running', resumeAt: null });

    // The helper's own reply is not a new task: the timer stays.
    hooks.emit('message:create', {
      id: 'message-1111111111111-helperrep',
      threadId: b.threadId!,
      role: 'agent',
      agentId: b.agentId,
      text: 'Still paused.',
    });
    await settle(300);
    expect((await Subagents.findById(b.id))!.resumeAt).not.toBeNull();

    // The user writing to it is.
    hooks.emit('message:create', {
      id: 'message-1111111111111-userwrite',
      threadId: b.threadId!,
      role: 'user',
      text: 'Actually, look at the logs first.',
    });
    const cleared = await waitFor(
      () => Subagents.findById(b.id),
      (row) => row?.resumeAt === null
    );
    // Still paused: the user's message starts its next run, not the timer.
    expect(cleared!.status).toBe('stopped');
    expect(await subagentService.resumeDue()).toEqual([]);
  });

  it('the user writing to a paused helper resumes it; its reply reaches the orchestrator like any report', async () => {
    const parent = await newParent();
    const echo = await startHelper(parent, 'Typed');
    await subagentService.pause({
      parentThreadId: parent,
      ref: 'Typed',
      by: USER,
      resumeAt: new Date(Date.now() + 60 * 60_000),
    });
    // The user's message in the helper's thread, then the run it starts.
    await Messages.create({
      threadId: echo.threadId!,
      role: 'user',
      userId: (await Users.getOrCreateLocalUser()).id,
      content: 'Look at the logs first.',
    });
    hooks.emit('message:create', {
      id: 'message-1111111111111-usertyped',
      threadId: echo.threadId!,
      role: 'user',
      text: 'Look at the logs first.',
    });
    mockDispatch.mockClear();
    const run = liveHelperRun(echo, 'run-typed-1');
    await run.end('completed', 'The logs show a timeout at 03:12.');

    const done = await waitFor(
      () => Subagents.findById(echo.id),
      (row) => row?.status === 'finished'
    );
    expect(done).toMatchObject({ resumeAt: null, taskCount: 2 });
    const rows = await resultRows(parent, echo.id);
    expect(rows.map((r) => r.content.split('\n').slice(0, 2))).toEqual([
      ['[subagent Typed paused by Test User]', expect.any(String)],
      ['[subagent Typed finished]', 'The logs show a timeout at 03:12.'],
    ]);
    await waitFor(
      async () => wakesFor(parent),
      (w) => w.length === 1
    );
  });

  it('the idle sweep leaves a helper with a pending timed pause, and removes an untimed one', async () => {
    const parent = await newParent();
    const timed = await startHelper(parent, 'Timed');
    const untimed = await startHelper(parent, 'Untimed');
    await subagentService.pause({
      parentThreadId: parent,
      ref: 'Timed',
      by: USER,
      resumeAt: new Date(Date.now() + 6 * 24 * 60 * 60_000),
    });
    await subagentService.pause({ parentThreadId: parent, ref: 'Untimed', by: USER });
    await getDb().query(
      `UPDATE public.subagents
          SET last_task_at = now() - interval '2 days', finished_at = now() - interval '2 days'
        WHERE id = ANY($1)`,
      [[timed.id, untimed.id]]
    );

    await subagentService.sweep();
    expect((await Subagents.findById(timed.id))!.deletedAt).toBeNull();
    expect((await Subagents.findById(untimed.id))!.deletedAt).not.toBeNull();
  });
});

describe('who may act', () => {
  it("an agent cannot pause, resume or remove another orchestrator's helper; the user can", async () => {
    const parent = await newParent();
    const theirs = await startHelper(parent, 'Theirs', OTHER);
    await expect(
      subagentService.pause({ parentThreadId: parent, ref: 'Theirs', by: MINE })
    ).rejects.toThrow(/belongs to another agent/);
    await expect(
      subagentService.remove({ parentThreadId: parent, ref: 'Theirs', by: MINE })
    ).rejects.toThrow(/belongs to another agent/);
    await expect(
      subagentService.resume({ parentThreadId: parent, ref: 'Theirs', by: MINE })
    ).rejects.toThrow(/belongs to another agent/);
    expect((await Subagents.findById(theirs.id))!.status).toBe('running');

    const { sub } = await subagentService.pause({
      parentThreadId: parent,
      ref: 'Theirs',
      by: USER,
    });
    expect(sub.status).toBe('stopped');
    const resumed = await subagentService.resume({
      parentThreadId: parent,
      ref: 'Theirs',
      by: USER,
    });
    expect(resumed).toMatchObject({ status: 'running', resumeAt: null });
    // Resuming is the orchestrator telling it to continue.
    const messages = await helperThreadMessages(theirs.threadId!);
    expect(messages[messages.length - 1]).toEqual({
      agent_id: OTHER,
      content: SUBAGENT_RESUME_MESSAGE,
    });
    await expect(
      subagentService.resume({ parentThreadId: parent, ref: 'Theirs', by: USER })
    ).rejects.toThrow(/is not paused/);
  });
});

describe('REST routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use((_req, _res, next) =>
      runWithActor({ actorKind: 'user', actorId: 'user-test-1', actorName: 'Test User' }, next)
    );
    const router = express.Router();
    registerSubagentRoutes(router);
    app.use('/api/threads', router);
    app.use(errorHandler);
  });

  it('pause for a while, resume and remove a helper as the user', async () => {
    const parent = await newParent();
    const helper = await startHelper(parent, 'Routed');
    const base = `/api/threads/${parent}/subagents/${helper.id}`;

    const bad = await request(app).post(`${base}/pause`).send({ for: 'soon' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/for must be a length/);

    const before = Date.now();
    const paused = await request(app).post(`${base}/pause`).send({ for: '15m' });
    expect(paused.status).toBe(200);
    expect(paused.body.data.subagent).toMatchObject({ id: helper.id, status: 'stopped' });
    const resumeAt = Date.parse(paused.body.data.subagent.resumeAt);
    expect(resumeAt - before).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    expect(resumeAt - before).toBeLessThan(15 * 60_000 + 10_000);
    const notice = await Messages.findById(
      (await Subagents.findById(helper.id))!.lastResultMessageId!
    );
    expect(notice!.content.split('\n')[0]).toBe('[subagent Routed paused by Test User]');

    const resumed = await request(app).post(`${base}/resume`).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.subagent).toMatchObject({ status: 'running', resumeAt: null });

    const removed = await request(app).delete(base);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ removed: true });
    expect((await request(app).delete(base)).status).toBe(404);
    // A repeat finds nothing to remove and tells no one again.
    expect(await resultRows(parent, helper.id)).toHaveLength(2);
    // A helper is addressed under its own parent thread only.
    const other = await newParent();
    const elsewhere = await startHelper(other, 'Elsewhere');
    expect(
      (await request(app).post(`/api/threads/${parent}/subagents/${elsewhere.id}/pause`).send({}))
        .status
    ).toBe(404);
  });

  it('removes a finished, a failed or a paused helper, each with one notice naming it and who removed it', async () => {
    const parent = await newParent();
    const finished = await startHelper(parent, 'Done');
    await liveHelperRun(finished, 'run-removed-done-1').end('completed', 'Found it.');
    const failed = await startHelper(parent, 'Broken');
    await insertRun('run-removed-broken-1', failed.threadId!, failed.agentId, 'failed');
    hooks.emit('run:end', {
      runId: 'run-removed-broken-1',
      agentId: failed.agentId,
      threadId: failed.threadId!,
      status: 'failed',
    });
    const paused = await startHelper(parent, 'Napping');
    await subagentService.pause({ parentThreadId: parent, ref: 'Napping', by: USER });
    await waitFor(
      async () => Promise.all([finished, failed].map((h) => Subagents.findById(h.id))),
      (rows) => rows.every((row) => row?.status !== 'running')
    );
    expect((await Subagents.findById(failed.id))!.status).toBe('failed');

    for (const helper of [finished, failed, paused]) {
      const before = (await resultRows(parent, helper.id)).length;
      const res = await request(app).delete(`/api/threads/${parent}/subagents/${helper.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ removed: true });
      const rows = await resultRows(parent, helper.id);
      expect(rows).toHaveLength(before + 1);
      const notice = rows.at(-1)!;
      expect(notice.content.split('\n')[0]).toBe(`[subagent ${helper.name} removed by Test User]`);
      expect(notice.content).toContain(`${helper.name} (id ${helper.id}) is gone`);
      expect(notice.metadata).toMatchObject({
        subagent_id: helper.id,
        subagent_name: helper.name,
        subagent_notice: 'removed',
        subagent_notice_by: 'Test User',
      });
      // The parent thread keeps the helper's earlier results with the notice.
      expect(await Threads.findById(parent)).not.toBeNull();
      expect(
        (await request(app).delete(`/api/threads/${parent}/subagents/${helper.id}`)).status
      ).toBe(404);
      expect(await resultRows(parent, helper.id)).toHaveLength(before + 1);
    }
  });
});
