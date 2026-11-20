/**
 * Subagent helpers against the real database, with dispatch stubbed
 * (no model calls): `start` makes a hidden helper agent + thread without
 * moving visible threads; validation refuses duplicates, foreign models and
 * nesting; a helper run's end turns its reply into an orchestrator-only
 * result row and wakes the orchestrator (or queues it mid-run when it is
 * running); the orchestrator run that saw the result removes the helper
 * unless it was given more work; a run that missed it keeps the helper and
 * wakes again; failures and restarts report too, and both keep the helper.
 * Pause, resume and remove: subagentPause.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

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

import { Agents, Messages, Runs, Threads, ThreadParticipants, getDb } from '@snaglet/db';
import { Subagents, type SubagentRow } from '@snaglet/db/tables/subagents';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { hooks } from '@server/services/HookService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { drainInjectablePeerMessages } from '@server/services/SocketService/handlers/chatPhases/peerInjection';
import { SubagentError } from '@server/services/subagents/errors';
import { noteContextAssemblyStarted } from '@server/services/subagents/resultVisibility';
import { subagentService } from '@server/services/subagents/SubagentService';

const ORCH = 'test-agent-a';
const OTHER = 'test-agent-b';
const PARENT = 'thread-1111111111111-parentaaa';
const VISIBLE = 'thread-1111111111111-visibleaa';

let providerId = '';
let fastModel = '';
let strongModel = '';
let foreignModel = '';

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

async function insertRun(
  id: string,
  threadId: string,
  agentId: string,
  status = 'completed',
  error: string | null = null
) {
  await getDb().query(
    `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, error, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [id, threadId, agentId, providerId, fastModel, status, error]
  );
}

/** A helper replies in its thread and its run ends. */
async function helperReplies(
  sub: SubagentRow,
  reply: string,
  runId: string,
  status: 'completed' | 'failed' | 'aborted' = 'completed'
) {
  await Messages.create({
    threadId: sub.threadId!,
    role: 'assistant',
    agentId: sub.agentId,
    content: reply,
    messageType: 'message',
  });
  await insertRun(
    runId,
    sub.threadId!,
    sub.agentId,
    status,
    status === 'failed' ? 'rate limited' : null
  );
  hooks.emit('run:end', { runId, agentId: sub.agentId, threadId: sub.threadId!, status });
}

async function settled(id: string): Promise<SubagentRow> {
  return waitFor(
    () => Subagents.findById(id),
    (row): row is SubagentRow => !!row && row.status !== 'running' && !!row.lastResultMessageId
  ) as Promise<SubagentRow>;
}

/** The orchestrator ran in the parent thread; `assembledAt` is when its context was built. */
async function orchestratorRunEnds(
  runId: string,
  assembledAt: number,
  status: 'completed' | 'failed' | 'aborted' = 'completed'
) {
  await insertRun(runId, PARENT, ORCH, status);
  noteContextAssemblyStarted(PARENT, ORCH, assembledAt);
  hooks.emit('run:end', { runId, agentId: ORCH, threadId: PARENT, status });
}

function wakesFor(threadId: string) {
  return mockDispatch.mock.calls
    .map(([input]) => input)
    .filter((input) => input.threadId === threadId);
}

beforeAll(async () => {
  const { rows } = await getDb().query<{ provider_id: string; model_ids: string[] }>(
    `SELECT provider_id, array_agg(model_id ORDER BY sort_order, model_id) AS model_ids
       FROM public.models
      WHERE is_active AND supports_tools AND type = 'llm'
      GROUP BY provider_id HAVING count(*) >= 2
      ORDER BY provider_id`
  );
  if (rows.length < 2) throw new Error('seed needs two providers with two tool-capable models');
  providerId = rows[0]!.provider_id;
  [fastModel, strongModel] = rows[0]!.model_ids as [string, string];
  foreignModel =
    rows[1]!.model_ids.find((m) => !rows[0]!.model_ids.includes(m)) ?? rows[1]!.model_ids[0]!;

  await Agents.create({ id: ORCH, name: 'Test Agent A', providerId, modelId: strongModel });
  await Agents.create({ id: OTHER, name: 'Test Agent B', providerId, modelId: strongModel });
  await Threads.create({ id: VISIBLE, title: 'Visible' });
  await Threads.create({ id: PARENT, title: 'Parent' });
  await ThreadParticipants.addParticipant({ threadId: PARENT, agentId: ORCH });
  subagentService.init({ recoverAfterRestart: false });
});

afterAll(() => {
  subagentService.shutdown();
});

beforeEach(() => {
  mockDispatch.mockClear();
});

describe('subagent lifecycle (real DB)', () => {
  let scout: SubagentRow;

  it('start makes a hidden helper agent and thread and posts the brief as the orchestrator', async () => {
    const before = await Threads.listAllOrdered();
    scout = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Scout',
      model: fastModel,
      brief: 'Find five leads. Report a table.',
    });
    expect(scout).toMatchObject({
      name: 'Scout',
      status: 'running',
      providerId,
      modelId: fastModel,
    });

    const agent = await Agents.findById(scout.agentId);
    // Permissions are inherited live from the orchestrator (helperInheritance);
    // the row holds only a narrowing, none here.
    expect(agent).toMatchObject({
      parentAgentId: ORCH,
      providerId,
      modelId: fastModel,
      toolAccessMode: null,
    });
    expect(agent!.systemPrompt).toContain('You are Scout, a subagent working for Test Agent A.');
    expect((await Agents.list()).map((a) => a.id)).not.toContain(scout.agentId);
    expect(await Agents.findByName('Scout')).toBeNull();

    const thread = await Threads.findById(scout.threadId!);
    expect(thread).toMatchObject({
      parentThreadId: PARENT,
      dispatchMode: 'all',
      title: 'Test Agent A › Scout',
    });
    // Hidden from every list, and the visible threads kept their order.
    const after = await Threads.listAllOrdered();
    expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(after.map((t) => t.sortOrder)).toEqual(before.map((t) => t.sortOrder));

    const { rows } = await getDb().query<{ agent_id: string; content: string }>(
      `SELECT agent_id, content FROM public.messages WHERE thread_id = $1`,
      [scout.threadId]
    );
    expect(rows).toEqual([{ agent_id: ORCH, content: 'Find five leads. Report a table.' }]);
    expect(wakesFor(scout.threadId!)).toHaveLength(1);
  });

  it('refuses a duplicate name, an unknown or foreign model, nesting and an empty tool set', async () => {
    const start = (over: Partial<Parameters<typeof subagentService.start>[0]>) =>
      subagentService.start({
        orchestratorAgentId: ORCH,
        parentThreadId: PARENT,
        name: 'Reader',
        model: fastModel,
        brief: 'Read.',
        ...over,
      });
    await expect(start({ name: 'scout' })).rejects.toThrow(/already has a subagent named "scout"/);
    await expect(start({ model: 'no-such-model' })).rejects.toThrow(
      new RegExp(`Pick one of: .*${fastModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
    await expect(start({ model: foreignModel })).rejects.toThrow(SubagentError);
    await expect(start({ tools: ['memory'] })).rejects.toThrow(/none of the listed tools/);
    await expect(
      start({ orchestratorAgentId: scout.agentId, parentThreadId: scout.threadId! })
    ).rejects.toThrow(/cannot start subagents/);
    expect(await Subagents.listLiveForParent(PARENT)).toHaveLength(1);
  });

  it('a finished helper becomes an orchestrator-only result row and wakes the idle orchestrator', async () => {
    await helperReplies(scout, 'Found 5 leads.', 'run-helper-scout-1');
    const done = await settled(scout.id);
    expect(done.status).toBe('finished');

    const row = await Messages.findById(done.lastResultMessageId!);
    expect(row).toMatchObject({
      messageType: 'thread_event',
      threadId: PARENT,
      visibleToAgentId: ORCH,
    });
    expect(row!.content.split('\n').slice(0, 2)).toEqual([
      '[subagent Scout finished]',
      'Found 5 leads.',
    ]);

    const wakes = wakesFor(PARENT);
    expect(wakes).toEqual([expect.objectContaining({ targetAgentId: ORCH, messageId: row!.id })]);
  });

  it('the orchestrator run that saw the result removes the helper; runs stay as usage', async () => {
    const helperThread = scout.threadId!;
    const resultId = (await Subagents.findById(scout.id))!.lastResultMessageId!;
    await orchestratorRunEnds('run-orch-1', Date.now() + 1000);

    const gone = await waitFor(
      () => Subagents.findById(scout.id),
      (row) => !!row?.deletedAt
    );
    expect(gone!.deliveredRunId).toBe('run-orch-1');
    expect(await Threads.findById(helperThread)).toBeNull();
    const { rows } = await getDb().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.nodes WHERE id = $1
          OR id IN (SELECT id FROM public.messages WHERE thread_id = $1)`,
      [helperThread]
    );
    expect(rows[0]!.n).toBe(0);
    expect((await Agents.findById(scout.agentId))!.archived).toBe(true);
    expect((await Runs.findById('run-helper-scout-1'))!.threadId).toBeNull();
    // The result stays in the parent thread's history.
    expect(await Messages.findById(resultId)).not.toBeNull();
    // The name is free again.
    expect(await Subagents.findLiveByName(PARENT, 'Scout')).toBeNull();
  });

  let reader: SubagentRow;

  it('a run that missed the result keeps the helper and wakes the orchestrator again', async () => {
    reader = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Reader',
      model: fastModel,
      brief: 'Read the pricing page.',
    });
    await helperReplies(reader, 'Prices: $99/month.', 'run-helper-reader-1');
    const done = await settled(reader.id);
    const row = (await Messages.findById(done.lastResultMessageId!))!;
    mockDispatch.mockClear();

    // Its context was built before the result was written.
    await orchestratorRunEnds('run-orch-2', Date.parse(row.createdAt) - 5_000);
    const wakes = await waitFor(
      async () => wakesFor(PARENT),
      (w) => w.length > 0
    );
    expect(wakes[0]).toMatchObject({ targetAgentId: ORCH, messageId: row.id });
    const still = await Subagents.findById(reader.id);
    expect(still).toMatchObject({ deletedAt: null, deliveredRunId: null });
  });

  it('a helper given more work during the turn that read its result is kept', async () => {
    const sent = await subagentService.send({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      ref: 'Reader',
      message: 'Now compare with two competitors.',
    });
    expect(sent).toMatchObject({ status: 'running', taskCount: 2 });
    expect(wakesFor(reader.threadId!)).toHaveLength(1);
    await orchestratorRunEnds('run-orch-3', Date.now() + 1000);
    await new Promise((r) => setTimeout(r, 300));
    expect(await Subagents.findById(reader.id)).toMatchObject({
      deletedAt: null,
      status: 'running',
    });
    await expect(
      subagentService.send({
        orchestratorAgentId: OTHER,
        parentThreadId: PARENT,
        ref: 'Reader',
        message: 'x',
      })
    ).rejects.toThrow(/belongs to another agent/);
  });

  it('a result for a running orchestrator is queued mid-run and counts once injected', async () => {
    const writer = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Writer',
      model: fastModel,
      brief: 'Draft the pitch.',
    });
    const session = 'test-session-parent';
    expect(activeRunTracker.startSession(session, PARENT)).toBe(true);
    activeWorkRegistry.registerThreadRun({
      id: 'run-orch-4',
      agentId: ORCH,
      agentName: 'Test Agent A',
      threadId: PARENT,
      threadTitle: 'Parent',
    });
    try {
      mockDispatch.mockClear();
      await helperReplies(writer, 'Pitch drafted.', 'run-helper-writer-1');
      const done = await settled(writer.id);
      const row = (await Messages.findById(done.lastResultMessageId!))!;
      expect(wakesFor(PARENT)).toHaveLength(0);
      expect(pendingAgentMessages.listUnread(PARENT, ORCH).map((m) => m.sourceMessageId)).toContain(
        row.id
      );

      const injected = drainInjectablePeerMessages({
        threadId: PARENT,
        agentId: ORCH,
        mode: 'mentioned',
      });
      expect(injected.some((text) => text.startsWith('[subagent Writer finished]'))).toBe(true);
      // Context was built before the result: only the injection makes it seen.
      await orchestratorRunEnds('run-orch-4', Date.parse(row.createdAt) - 5_000);
      await waitFor(
        () => Subagents.findById(writer.id),
        (r) => !!r?.deletedAt
      );
    } finally {
      activeWorkRegistry.unregister('run-orch-4');
      activeRunTracker.finishSession(session);
    }
  });

  it('the run a wake starts counts as having seen the result, even when it starts at once', async () => {
    const quick = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Quick',
      model: fastModel,
      brief: 'Answer fast.',
    });
    // The woken orchestrator run assembles its context within the replay
    // margin of the row and ends before dispatchToThread resolves.
    mockDispatch.mockImplementationOnce(async (input) => {
      await insertRun('run-orch-woken', PARENT, ORCH);
      noteContextAssemblyStarted(PARENT, ORCH, Date.now());
      hooks.emit('run:end', {
        runId: 'run-orch-woken',
        agentId: ORCH,
        threadId: PARENT,
        status: 'completed',
      });
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true, reason: 'dispatched', wakeCount: 1, capHit: false };
    });
    mockDispatch.mockClear();
    await helperReplies(quick, 'Done quickly.', 'run-helper-quick-1');
    const gone = await waitFor(
      () => Subagents.findById(quick.id),
      (row) => !!row?.deletedAt
    );
    expect(gone!.deliveredRunId).toBe('run-orch-woken');
    // No second wake for the same result.
    await new Promise((r) => setTimeout(r, 1200));
    expect(wakesFor(PARENT)).toHaveLength(1);
  });

  it('wait returns the report inside the running turn; no wake follows and the run end cleans up', async () => {
    const waiter = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Waited',
      model: fastModel,
      brief: 'Answer, then stop.',
    });
    const session = 'test-session-wait';
    expect(activeRunTracker.startSession(session, PARENT)).toBe(true);
    activeWorkRegistry.registerThreadRun({
      id: 'run-orch-wait',
      agentId: ORCH,
      agentName: 'Test Agent A',
      threadId: PARENT,
      threadTitle: 'Parent',
    });
    try {
      mockDispatch.mockClear();
      const waiting = subagentService.wait({
        orchestratorAgentId: ORCH,
        parentThreadId: PARENT,
        names: ['Waited'],
        timeoutMs: 8000,
      });
      await new Promise((r) => setTimeout(r, 200));
      await helperReplies(waiter, 'The answer is 42.', 'run-helper-waited-1');
      const { reports, stillRunning } = await waiting;
      expect(stillRunning).toEqual([]);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.content.split('\n').slice(0, 2)).toEqual([
        '[subagent Waited finished]',
        'The answer is 42.',
      ]);
      // The queued mid-run copy was dropped: the report is already in hand.
      expect(pendingAgentMessages.listUnread(PARENT, ORCH)).toHaveLength(0);
      // The run's context was built long before; only wait made it seen.
      await orchestratorRunEnds('run-orch-wait', Date.now() - 60_000);
      await waitFor(
        () => Subagents.findById(waiter.id),
        (r) => !!r?.deletedAt
      );
    } finally {
      activeWorkRegistry.unregister('run-orch-wait');
      activeRunTracker.finishSession(session);
    }
    await new Promise((r) => setTimeout(r, 1200));
    expect(wakesFor(PARENT)).toHaveLength(0);
  });

  it('wait gives up at its timeout and names the helpers still running', async () => {
    const slow = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Slow',
      model: fastModel,
      brief: 'Take your time.',
    });
    const { reports, stillRunning } = await subagentService.wait({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      names: ['Slow'],
      timeoutMs: 600,
    });
    expect(reports).toEqual([]);
    expect(stillRunning.map((s) => s.id)).toEqual([slow.id]);
  });

  it('a failed helper run reports the failure', async () => {
    const failing = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Checker',
      model: fastModel,
      brief: 'Check the links.',
    });
    await helperReplies(failing, 'Checked 3 of 10.', 'run-helper-checker-1', 'failed');
    const done = await settled(failing.id);
    expect(done).toMatchObject({ status: 'failed', error: 'rate limited' });
    const row = await Messages.findById(done.lastResultMessageId!);
    expect(row!.content.split('\n').slice(0, 3)).toEqual([
      '[subagent Checker failed: rate limited]',
      'Work so far:',
      'Checked 3 of 10.',
    ]);
    expect(row!.content).toContain(
      `Checker (id ${failing.id}) is kept with its thread, brief and work so far`
    );
  });

  it('an orchestrator run that failed did not read the result: nothing is delivered or removed', async () => {
    const checker = (await Subagents.findLiveByName(PARENT, 'Checker'))!;
    mockDispatch.mockClear();
    // The model call failed (e.g. a network outage) with the result in its context.
    await orchestratorRunEnds('run-orch-failed', Date.now() + 1000, 'failed');
    await new Promise((r) => setTimeout(r, 300));
    expect(await Subagents.findById(checker.id)).toMatchObject({
      deletedAt: null,
      deliveredRunId: null,
    });
    // No re-wake: a failing model would only fail again.
    expect(wakesFor(PARENT)).toHaveLength(0);
  });

  it('a failed helper outlives delivery so the orchestrator can retry it', async () => {
    const checker = (await Subagents.findLiveByName(PARENT, 'Checker'))!;
    await orchestratorRunEnds('run-orch-read-failure', Date.now() + 1000);
    const delivered = await waitFor(
      () => Subagents.findById(checker.id),
      (row) => row?.deliveredRunId === 'run-orch-read-failure'
    );
    expect(delivered).toMatchObject({ deletedAt: null, status: 'failed' });
    expect(await Threads.findById(checker.threadId!)).not.toBeNull();
    // The sweep leaves it too.
    await subagentService.sweep();
    expect((await Subagents.findById(checker.id))!.deletedAt).toBeNull();

    const retried = await subagentService.send({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      ref: 'Checker',
      message: 'Try again from where you stopped.',
    });
    expect(retried).toMatchObject({ status: 'running', taskCount: 2 });
    expect(wakesFor(checker.threadId!)).toHaveLength(1);
  });

  it('after a restart a helper still marked running reports as stopped', async () => {
    const orphan = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Orphan',
      model: fastModel,
      brief: 'Long job.',
    });
    await subagentService.recoverAfterRestart();
    const done = await Subagents.findById(orphan.id);
    expect(done).toMatchObject({
      status: 'stopped',
      error: 'the server restarted while it was working',
    });
    const row = await Messages.findById(done!.lastResultMessageId!);
    expect(row!.content.split('\n')[0]).toBe(
      '[subagent Orphan stopped: the server restarted while it was working]'
    );
  });

  it('list shows the live helpers; a helper stopped by a restart is kept as paused', async () => {
    const live = (await subagentService.list(PARENT)).map((s) => s.name).sort();
    expect(live).toEqual(expect.arrayContaining(['Reader', 'Checker', 'Orphan', 'Slow']));
    expect(live).not.toContain('Scout');
    const orphan = (await Subagents.findLiveByName(PARENT, 'Orphan'))!;
    const row = await Messages.findById(orphan.lastResultMessageId!);
    expect(row!.content).toContain(
      `Orphan (id ${orphan.id}) is paused: it keeps its thread, brief and work so far.`
    );
    await orchestratorRunEnds('run-orch-read-restart', Date.now() + 1000);
    const delivered = await waitFor(
      () => Subagents.findById(orphan.id),
      (r) => r?.deliveredRunId === 'run-orch-read-restart'
    );
    expect(delivered).toMatchObject({ status: 'stopped', deletedAt: null });
  });
});
