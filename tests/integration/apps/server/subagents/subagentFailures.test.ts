/**
 * When a subagent helper fails, against the real database with dispatch
 * stubbed (no model calls). Every way a helper run can end badly reaches its
 * orchestrator as one result row that names the helper (name and id), says
 * why in plain words and what it can do next (op:send to retry, or take
 * over), and carries the work so far. It is delivered like a finish: queued
 * for a running orchestrator, a wake for an idle one, and op:wait returns it.
 * The path table: docs/agents.md. Pause and remove
 * during op:wait: subagentPause.test.ts; retry with op:send and a restart:
 * subagentLifecycle.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type DispatchInput = { threadId: string; targetAgentId?: string; messageId?: string };
type DispatchOutput = { ok: boolean; reason: string; wakeCount: number; capHit: boolean };
const mockDispatch = jest.fn(
  async (_input: DispatchInput): Promise<DispatchOutput> => ({
    ok: true,
    reason: 'dispatched',
    wakeCount: 1,
    capHit: false,
  })
);
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@server/services/SocketService/dispatch/dispatchToThread'
  ),
  dispatchToThread: (input: DispatchInput) => mockDispatch(input),
}));

import { Agents, Messages, Threads, ThreadParticipants, getDb } from '@snaglet/db';
import { Subagents, type SubagentRow } from '@snaglet/db/tables/subagents';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { hooks } from '@server/services/HookService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import {
  clearAgentAbortController,
  createAbortController,
  createAgentAbortController,
} from '@server/services/SocketService/abortStore';
import { noteContextAssemblyStarted } from '@server/services/subagents/resultVisibility';
import { subagentService } from '@server/services/subagents/SubagentService';
import { noteHelperTurnFailure } from '@server/services/subagents/turnFailures';

const ORCH = 'test-agent-a';

let providerId = '';
let fastModel = '';
let strongModel = '';
let parentCount = 0;
let runCount = 0;

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

const pause = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

/** A fresh parent thread with the orchestrator in it, so tests never share helpers. */
async function newParent(): Promise<string> {
  parentCount += 1;
  const id = `thread-1111111111111-fail${String(parentCount).padStart(5, '0')}`;
  await Threads.create({ id, title: `Parent ${parentCount}` });
  await ThreadParticipants.addParticipant({ threadId: id, agentId: ORCH });
  return id;
}

function startHelper(parentThreadId: string, name: string) {
  return subagentService.start({
    orchestratorAgentId: ORCH,
    parentThreadId,
    name,
    model: fastModel,
    brief: `Brief for ${name}.`,
  });
}

function nextRunId(): string {
  runCount += 1;
  return `run-test-fail-${String(runCount).padStart(4, '0')}`;
}

async function insertRun(
  id: string,
  threadId: string,
  agentId: string,
  status: string,
  error: string | null = null
) {
  await getDb().query(
    `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, error, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [id, threadId, agentId, providerId, fastModel, status, error]
  );
}

/** The dispatch holding the helper's thread while its turn runs; release() is its end. */
function helperSession(sub: SubagentRow) {
  runCount += 1;
  const session = `test-session-fail-${runCount}`;
  expect(activeRunTracker.startSession(session, sub.threadId!)).toBe(true);
  return { release: () => activeRunTracker.finishSession(session) };
}

/** One model attempt of the helper ends, as the turn loop reports it. */
async function helperRunEnds(
  sub: SubagentRow,
  status: 'completed' | 'failed' | 'aborted',
  error: string | null = null
): Promise<string> {
  const runId = nextRunId();
  await insertRun(
    runId,
    sub.threadId!,
    sub.agentId,
    status === 'completed' ? status : 'failed',
    error
  );
  hooks.emit('run:end', { runId, agentId: sub.agentId, threadId: sub.threadId!, status });
  return runId;
}

/** The helper says something in its thread (an interim message, or its report). */
async function helperSays(sub: SubagentRow, content: string) {
  await Messages.create({
    threadId: sub.threadId!,
    role: 'assistant',
    agentId: sub.agentId,
    content,
    messageType: 'message',
  });
}

/** The error bubble a failed run leaves in the helper's thread (persistRunErrorMessage). */
async function runErrorBubble(sub: SubagentRow, summary: string) {
  await Messages.create({
    threadId: sub.threadId!,
    role: 'assistant',
    agentId: sub.agentId,
    content: `⚠ Model error (${providerId}/${fastModel}): ${summary}`,
    messageType: 'message',
    metadata: { run_error: { kind: 'model_failure', summary } },
  });
}

async function settled(id: string): Promise<SubagentRow> {
  return waitFor(
    () => Subagents.findById(id),
    (row): row is SubagentRow => !!row && row.status !== 'running' && !!row.lastResultMessageId
  ) as Promise<SubagentRow>;
}

async function resultRows(parent: string, subagentId: string) {
  const { rows } = await getDb().query<{ id: string; content: string }>(
    `SELECT id, content FROM public.messages
      WHERE thread_id = $1 AND metadata->>'subagent_id' = $2
      ORDER BY created_at, id`,
    [parent, subagentId]
  );
  return rows;
}

function wakesFor(threadId: string) {
  return mockDispatch.mock.calls
    .map(([input]) => input)
    .filter((input) => input.threadId === threadId && input.targetAgentId === ORCH);
}

/** The orchestrator is mid-run in `parent` until end() (its run ends completed). */
function orchestratorRunning(parent: string) {
  const runId = nextRunId();
  const session = `test-session-orch-${runId}`;
  expect(activeRunTracker.startSession(session, parent)).toBe(true);
  activeWorkRegistry.registerThreadRun({
    id: runId,
    agentId: ORCH,
    agentName: 'Test Agent A',
    threadId: parent,
    threadTitle: 'Parent',
  });
  const assembledAt = Date.now() - 60_000;
  return {
    end: async () => {
      await insertRun(runId, parent, ORCH, 'completed');
      noteContextAssemblyStarted(parent, ORCH, assembledAt);
      hooks.emit('run:end', { runId, agentId: ORCH, threadId: parent, status: 'completed' });
      activeWorkRegistry.unregister(runId);
      activeRunTracker.finishSession(session);
    },
  };
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
  subagentService.init({ recoverAfterRestart: false });
});

afterAll(() => {
  subagentService.shutdown();
});

beforeEach(() => {
  mockDispatch.mockClear();
});

describe('a helper run that fails', () => {
  it('a model the provider refuses: one failed result with the reason, the id and what to do; one wake', async () => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Prompter');
    const reason =
      "The 'test-model-x' model is not supported when using this provider with a personal account.";
    const turn = helperSession(sub);
    await helperRunEnds(sub, 'failed', reason);
    await runErrorBubble(sub, reason);
    turn.release();

    const done = await settled(sub.id);
    expect(done).toMatchObject({ status: 'failed', error: reason, deletedAt: null });
    await pause();
    const rows = await resultRows(parent, sub.id);
    expect(rows).toHaveLength(1);
    const lines = rows[0]!.content.split('\n');
    expect(lines[0]).toBe(`[subagent Prompter failed: ${reason}]`);
    // The error bubble in its thread is not its work.
    expect(lines[1]).toBe('(no reply)');
    expect(lines[2]).toContain(`Prompter (id ${sub.id}) is kept with its thread`);
    expect(lines[2]).toContain('call subagent op:send with name "Prompter"');
    expect(lines[2]).toContain('call subagent op:remove with name "Prompter"');
    // Idle orchestrator: woken once, exactly as for a finish.
    expect(wakesFor(parent)).toEqual([
      expect.objectContaining({ targetAgentId: ORCH, messageId: rows[0]!.id }),
    ]);
  });

  it('a provider error mid-run keeps the work so far, not the error bubble', async () => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Reader');
    const turn = helperSession(sub);
    await helperSays(sub, 'Read 4 of 9 sources: the pricing page and three reviews.');
    await helperRunEnds(sub, 'failed', '529 overloaded_error: Overloaded');
    await runErrorBubble(sub, '529 overloaded_error: Overloaded');
    turn.release();

    const done = await settled(sub.id);
    expect(done.status).toBe('failed');
    const rows = await resultRows(parent, sub.id);
    expect(rows.map((r) => r.content.split('\n').slice(0, 3))).toEqual([
      [
        '[subagent Reader failed: 529 overloaded_error: Overloaded]',
        'Work so far:',
        'Read 4 of 9 sources: the pricing page and three reviews.',
      ],
    ]);
  });

  it('a failed model attempt, its fallback failing too and the thread going idle: one result', async () => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Twice');
    const turn = helperSession(sub);
    await helperRunEnds(sub, 'failed', 'first model unavailable');
    await helperRunEnds(sub, 'failed', 'fallback model unavailable');
    turn.release();

    const done = await settled(sub.id);
    expect(done.error).toBe('fallback model unavailable');
    await pause();
    expect(await resultRows(parent, sub.id)).toHaveLength(1);
    expect(wakesFor(parent)).toHaveLength(1);
  });

  it('a running orchestrator gets it at its next tool call and op:wait returns it; no wake', async () => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Keyless');
    const orch = orchestratorRunning(parent);
    try {
      const waiting = subagentService.wait({
        orchestratorAgentId: ORCH,
        parentThreadId: parent,
        names: ['Keyless'],
        timeoutMs: 8000,
      });
      await pause(200);
      const turn = helperSession(sub);
      await helperRunEnds(
        sub,
        'failed',
        "Missing credentials for provider 'test-provider'. Connect it on the Providers page."
      );
      turn.release();
      const { reports, stillRunning } = await waiting;
      expect(stillRunning).toEqual([]);
      expect(reports.map((r) => r.content.split('\n')[0])).toEqual([
        "[subagent Keyless failed: Missing credentials for provider 'test-provider'. Connect it on the Providers page.]",
      ]);
      // The report is in hand: the queued mid-run copy is dropped.
      expect(pendingAgentMessages.listUnread(parent, ORCH)).toHaveLength(0);
    } finally {
      await orch.end();
    }
    // The run that read it got it; a failed helper is kept for a retry.
    const delivered = await waitFor(
      () => Subagents.findById(sub.id),
      (row) => !!row?.deliveredRunId
    );
    expect(delivered).toMatchObject({ status: 'failed', deletedAt: null });
    await pause();
    expect(wakesFor(parent)).toHaveLength(0);
  });
});

describe('a helper turn that never starts a run', () => {
  it.each([
    ['it has no model configured'],
    ['its agent is archived'],
    ['tool policy lookup failed'],
  ])('reports why (%s) once its thread is idle; the idle orchestrator is woken', async (why) => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Starter');
    const turn = helperSession(sub);
    // What the turn loop notes when it returns before its first run.
    noteHelperTurnFailure(sub.threadId!, sub.agentId, why);
    turn.release();

    const done = await settled(sub.id);
    expect(done).toMatchObject({ status: 'failed', error: why });
    await pause();
    const rows = await resultRows(parent, sub.id);
    expect(rows.map((r) => r.content.split('\n')[0])).toEqual([
      `[subagent Starter failed: ${why}]`,
    ]);
    expect(wakesFor(parent)).toHaveLength(1);
  });

  it('op:wait returns instead of hanging until its timeout', async () => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Waited');
    const orch = orchestratorRunning(parent);
    try {
      const started = Date.now();
      const waiting = subagentService.wait({
        orchestratorAgentId: ORCH,
        parentThreadId: parent,
        names: ['Waited'],
        timeoutMs: 20_000,
      });
      await pause(200);
      const turn = helperSession(sub);
      noteHelperTurnFailure(sub.threadId!, sub.agentId, 'it has no model configured');
      turn.release();
      const { reports, stillRunning } = await waiting;
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(stillRunning).toEqual([]);
      expect(reports[0]!.content.split('\n')[0]).toBe(
        '[subagent Waited failed: it has no model configured]'
      );
    } finally {
      await orch.end();
    }
  });

  it('a dispatch that fails before the helper gets a turn is reported', async () => {
    const parent = await newParent();
    mockDispatch.mockImplementationOnce(() => Promise.reject(new Error('database is restarting')));
    const sub = await startHelper(parent, 'Undispatched');
    const done = await settled(sub.id);
    expect(done).toMatchObject({
      status: 'failed',
      error: 'Snaglet could not start its turn: database is restarting',
    });
    expect((await resultRows(parent, sub.id)).length).toBe(1);
  });

  it('a dispatch that wakes no one is reported', async () => {
    const parent = await newParent();
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      reason: 'no_dispatch',
      wakeCount: 0,
      capHit: false,
    });
    const sub = await startHelper(parent, 'Unwoken');
    const done = await settled(sub.id);
    expect(done).toMatchObject({
      status: 'failed',
      error: 'Snaglet could not start its turn: nothing woke it',
    });
  });

  it('a run Snaglet cut off when it stopped responding reports once; its late end adds nothing', async () => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Wedged');
    const turn = helperSession(sub);
    // A run that never ends on its own: the watchdog force-releases the thread.
    const runId = nextRunId();
    await insertRun(runId, sub.threadId!, sub.agentId, 'running');
    turn.release();

    const done = await settled(sub.id);
    expect(done).toMatchObject({
      status: 'failed',
      error: 'it stopped responding, so Snaglet ended its run',
    });
    // Much later the wedged run unwinds after all.
    await getDb().query(`UPDATE public.runs SET status = 'failed', error = $2 WHERE id = $1`, [
      runId,
      'Aborted by watchdog',
    ]);
    hooks.emit('run:end', {
      runId,
      agentId: sub.agentId,
      threadId: sub.threadId!,
      status: 'aborted',
    });
    await pause();
    expect(await resultRows(parent, sub.id)).toHaveLength(1);
    expect(wakesFor(parent)).toHaveLength(1);
  });
});

describe('a helper run that Snaglet or someone stopped', () => {
  it.each([
    ['Aborted by timeout', 'failed', 'it ran past the agent turn time limit'],
    ['Aborted by watchdog', 'failed', 'the watchdog stopped it after 15 min without progress'],
    ['Aborted by Test User', 'stopped', 'Test User stopped its run'],
  ] as const)('%s → %s: %s', async (runError, status, reason) => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Limited');
    const turn = helperSession(sub);
    await helperSays(sub, 'Drafted two of five sections.');
    await helperRunEnds(sub, 'aborted', runError);
    turn.release();

    const done = await settled(sub.id);
    expect(done).toMatchObject({ status, error: reason });
    const rows = await resultRows(parent, sub.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content.split('\n').slice(0, 3)).toEqual([
      `[subagent Limited ${status}: ${reason}]`,
      'Work so far:',
      'Drafted two of five sections.',
    ]);
    expect(rows[0]!.content).toContain(`Limited (id ${sub.id})`);
    expect(wakesFor(parent)).toHaveLength(1);
  });
});

describe('a helper run Snaglet stops itself', () => {
  it('the idle sweep stops a run that went on for a day, and says so', async () => {
    const parent = await newParent();
    const sub = await startHelper(parent, 'Endless');
    const threadId = sub.threadId!;
    runCount += 1;
    const session = `test-session-sweep-${runCount}`;
    expect(activeRunTracker.startSession(session, threadId)).toBe(true);
    const root = createAbortController(session, threadId);
    const controller = createAgentAbortController(session, threadId, sub.agentId, root.signal);
    // The run unwinds like the turn loop when aborted.
    controller.signal.addEventListener(
      'abort',
      () =>
        void (async () => {
          const runId = nextRunId();
          await insertRun(runId, threadId, sub.agentId, 'failed', 'Aborted by system');
          hooks.emit('run:end', { runId, agentId: sub.agentId, threadId, status: 'aborted' });
          clearAgentAbortController(threadId, sub.agentId, controller);
          setTimeout(() => activeRunTracker.finishSession(session), 30);
        })(),
      { once: true }
    );
    await getDb().query(
      `UPDATE public.subagents SET last_task_at = now() - interval '25 hours' WHERE id = $1`,
      [sub.id]
    );

    await subagentService.sweep();
    const done = await settled(sub.id);
    expect(done).toMatchObject({
      status: 'failed',
      error: 'it ran for a day without finishing, so Snaglet stopped it',
      deletedAt: null,
    });
    expect(await resultRows(parent, sub.id)).toHaveLength(1);
  });
});
