/**
 * The `automation` tool's `run` (an agent's Run now, to test an automation)
 * and `runs` (its run log) through ToolExecutor against the real database,
 * scheduler and dispatch entry. Only the dispatch's routing inputs
 * (buildDispatchDeps), sockets and the summary-halt switch are faked.
 *
 * The usual case is pinned end to end: the agent runs its own automation
 * from its own thread while its run holds that thread, so the wake is
 * posted once, not handed into the running turn, and delivered by the
 * one re-dispatch when the run ends, carrying the wake marker. Also: only
 * the agent's own automations, never from a run an automation started, at
 * most 3 an hour per automation (a skipped run and people are not counted),
 * and `runs` pages newest first with due times in the automation's zone.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));
jest.mock('@server/services/SocketService/dispatch/buildDispatchDeps', () => ({
  buildDispatchDeps: async () => ({
    ok: true as const,
    deps: {
      sessionId: `tool-dispatch-${Math.random()}`,
      dispatchSet: new Set(['test-agent-a']),
      agentNameMap: new Map([['test-agent-a', 'Test Agent A']]),
      mentions: { mentionedAgentIds: ['test-agent-a'], hasMentions: true, rawMentions: [] },
      resolveParticipantId: (id: string) => id,
    },
  }),
}));
const mockHalted = new Set<string>();
jest.mock('@server/services/summary/summaryHalt', () => ({
  ...jest.requireActual<object>('@server/services/summary/summaryHalt'),
  isThreadSummaryHalted: (threadId: string) => mockHalted.has(threadId),
}));
jest.mock('@server/services/SocketService/dispatch/summaryHaltedWakes', () => ({
  ...jest.requireActual<object>('@server/services/SocketService/dispatch/summaryHaltedWakes'),
  liftSummaryHaltAndReplayWakes: async () => false,
}));

import { Agents, Threads, ThreadParticipants, getDb } from '@snaglet/db';
import { runWithRunContext } from '@server/realtime/runContext';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { automationService } from '@server/services/automations/AutomationService';
import { finalizeDispatchRun } from '@server/services/SocketService/dispatch/dispatchRunTeardown';
import { redispatchPersistedMessage } from '@server/services/SocketService/dispatch/dispatchToThread';
import {
  listHeldWakes,
  resetHeldWakesForTests,
} from '@server/services/SocketService/dispatch/summaryHaltedWakes';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { findResolvedAgentTool } from '@server/services/ToolService/lib/resolveAgentTool';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';
const THREAD_A = 'thread-1111111111111-toolrunaa';
const THREAD_B = 'thread-1111111111111-toolrunbb';
const SESSION = 'session-test-agent-a-own-run';
const LA = 'America/Los_Angeles';

const asAgentA: ToolHandlerContext = { agentId: AGENT_A, threadId: THREAD_A };
const asAgentB: ToolHandlerContext = { agentId: AGENT_B, threadId: THREAD_B };

async function automationTool(agentId: string) {
  return (
    findResolvedAgentTool(await resolveAgentTools(agentId), 'automation') ??
    ({
      agentId: '',
      tool: { id: 'automation', name: 'Automation' },
      settings: {},
      requiresConfirmation: false,
    } as unknown as Parameters<typeof toolExecutor.execute>[1])
  );
}

async function call(
  input: Record<string, unknown>,
  context: ToolHandlerContext,
  agentId = AGENT_A
) {
  const agentTool = await automationTool(agentId);
  return runWithRunContext(
    { threadId: context.threadId!, runId: 'run-1111111111111-toolrunaa' },
    () => toolExecutor.execute({ name: 'automation', input }, agentTool, context)
  );
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await getDb().query<T>(text, params)).rows;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Agent A's automation in its own thread (made by agent A unless `by` says otherwise). */
async function makeAutomation(by: ToolHandlerContext | null = asAgentA): Promise<string> {
  const input = {
    op: 'create',
    name: 'Check the build',
    prompt: 'Look at the build and report.',
    when: { every: '1h', tz: LA },
    ...(by ? {} : { thread_id: THREAD_A, agent_id: AGENT_A }),
  };
  const result = by
    ? await call(input, by)
    : await toolExecutor.execute({ name: 'automation', input }, await automationTool(AGENT_A));
  expect(result.success).toBe(true);
  return (JSON.parse(result.output) as { automation: { id: string } }).automation.id;
}

/** `run` as agent A, then wait for the wake's bookkeeping to settle. */
async function runAsA(id: string, context: ToolHandlerContext = asAgentA) {
  const result = await call({ op: 'run', id }, context);
  await waitFor(() => !automationService.isWakeLive(id));
  return result;
}

async function wakes() {
  return sql<{ id: string; content: string; metadata: { automation?: { id: string } } }>(
    `SELECT id, content, metadata FROM public.messages WHERE thread_id = $1 ORDER BY created_at, id`,
    [THREAD_A]
  );
}

/** End agent A's run the way the dispatch does; returns what it re-dispatched. */
async function endOwnRun() {
  const redispatch = jest.fn(
    async (_args: Parameters<typeof redispatchPersistedMessage>[0]) => undefined
  );
  await finalizeDispatchRun({
    sessionId: SESSION,
    threadId: THREAD_A,
    threadName: 'Thread A',
    isGroup: false,
    activeRunIds: new Set<string>(),
    convBudget: {
      summary: () => ({ totalOutputTokens: 0, waves: 1, exhaustedReason: null }),
      seedSnapshot: () => ({ waves: 1, totalOutputTokens: 0 }),
    } as unknown as Parameters<typeof finalizeDispatchRun>[0]['convBudget'],
    stopReason: 'all-passed',
    passKinds: new Map(),
    wakeCount: 1,
    redispatch,
    runToken: activeRunTracker.sessionRunToken(SESSION),
  });
  return redispatch.mock.calls.map(([args]) => args);
}

beforeAll(async () => {
  await toolRegistry.load();
  await toolRegistry.syncToDatabase();
  const { rows } = await getDb().query<{ provider_id: string; model_id: string }>(
    `SELECT provider_id, model_id FROM public.models
      WHERE is_active AND supports_tools AND type = 'llm'
      ORDER BY provider_id, sort_order LIMIT 1`
  );
  const model = { providerId: rows[0]!.provider_id, modelId: rows[0]!.model_id };
  await Agents.create({ id: AGENT_A, name: 'Test Agent A', ...model });
  await Agents.create({ id: AGENT_B, name: 'Test Agent B', ...model });
  await Threads.create({ id: THREAD_A, title: 'Thread A' });
  await Threads.create({ id: THREAD_B, title: 'Thread B' });
  await ThreadParticipants.addParticipant({ threadId: THREAD_A, agentId: AGENT_A });
  await ThreadParticipants.addParticipant({ threadId: THREAD_B, agentId: AGENT_B });
});

beforeEach(async () => {
  await sql(`DELETE FROM public.automations`);
  await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
  await sql(`DELETE FROM public.messages WHERE thread_id = ANY($1)`, [[THREAD_A, THREAD_B]]);
  mockHalted.clear();
  resetHeldWakesForTests();
  // Agent A's own run holds its thread, as it does while the tool runs.
  expect(activeRunTracker.startSession(SESSION, THREAD_A)).toBe(true);
});

afterEach(() => {
  activeRunTracker.takeSkippedSeeds(SESSION);
  activeRunTracker.finishSession(SESSION);
});

describe('automation tool: run', () => {
  it('runs its own automation once, delivered after its own run ends with the wake marker', async () => {
    const id = await makeAutomation();
    await call({ op: 'pause', id }, asAgentA);

    const result = await runAsA(id);
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output) as {
      automation: { id: string; status: string };
      run: { status: string; error?: string };
      note: string;
    };
    // A paused automation runs as a test, like a person's Run now.
    expect(out.automation).toMatchObject({ id, status: 'paused' });
    expect(out.run).toEqual({ status: 'succeeded' });
    expect(out.note).toBe(
      "Posted the wake in “Thread A”. You'll get it as a new message once your current run ends; check runs afterward."
    );
    expect(out.note).not.toContain('[automation');

    // Posted once, logged as a Run now.
    const posted = await wakes();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.metadata.automation?.id).toBe(id);
    const log = JSON.parse((await call({ op: 'runs', id }, asAgentA)).output) as {
      runs: Array<{ status: string; manual: boolean }>;
    };
    expect(log.runs).toEqual([expect.objectContaining({ status: 'succeeded', manual: true })]);

    // Not handed into the running turn: the run's end re-dispatches it once.
    const redispatched = await endOwnRun();
    expect(redispatched).toHaveLength(1);
    expect(redispatched[0]).toMatchObject({
      threadId: THREAD_A,
      messageId: posted[0]!.id,
      coveredMessageIds: [posted[0]!.id],
    });

    // That re-dispatch wakes with the marker, so the woken turn is automated
    // (observed through a summary hold, which keeps the dispatch input). The
    // agent started it, so the wake is marked and never auto-approves.
    mockHalted.add(THREAD_A);
    await redispatchPersistedMessage(redispatched[0]!);
    expect(listHeldWakes(THREAD_A)).toEqual([
      expect.objectContaining({
        messageId: posted[0]!.id,
        wakeOrigin: { kind: 'automation', automationId: id, agentStarted: true },
        unattended: expect.objectContaining({ source: 'automation', id, policy: 'skip' }),
      }),
    ]);
  });

  it('two runs in one turn post two wakes, both covered by one re-dispatch', async () => {
    const id = await makeAutomation();
    await runAsA(id);
    await runAsA(id);
    const posted = await wakes();
    expect(posted).toHaveLength(2);
    const redispatched = await endOwnRun();
    expect(redispatched).toHaveLength(1);
    expect(redispatched[0]).toMatchObject({
      messageId: posted[1]!.id,
      coveredMessageIds: [posted[0]!.id, posted[1]!.id],
    });
  });

  it("refuses another agent's automation and one a person made", async () => {
    const theirs = await call(
      {
        op: 'create',
        name: 'Theirs',
        prompt: 'Their check.',
        when: { every: '1h' },
      },
      asAgentB,
      AGENT_B
    );
    const theirId = (JSON.parse(theirs.output) as { automation: { id: string } }).automation.id;
    expect(await runAsA(theirId)).toMatchObject({
      success: false,
      error: 'You can only run automations you created.',
    });
    const byPerson = await makeAutomation(null);
    expect((await runAsA(byPerson)).error).toBe('You can only run automations you created.');
    expect(await wakes()).toHaveLength(0);
  });

  it('refuses inside a run an automation started, so a test wake cannot start another', async () => {
    const id = await makeAutomation();
    const automated: ToolHandlerContext = {
      ...asAgentA,
      wakeOrigin: { kind: 'automation', automationId: id },
    };
    expect(await runAsA(id, automated)).toMatchObject({
      success: false,
      error: "Automations can't be run from a run an automation started.",
    });
    expect(await wakes()).toHaveLength(0);
  });

  it('allows 3 an hour per automation; a skipped run and people are not counted', async () => {
    const id = await makeAutomation();
    // A person's Run now is not counted.
    expect((await automationService.runNow(id)).run.status).toBe('succeeded');
    // A skipped run (previous one still going) posts nothing and is not counted.
    const [row] = await sql<{ schedule_id: string }>(
      `SELECT schedule_id FROM public.automations WHERE id = $1`,
      [id]
    );
    await sql(
      `INSERT INTO public.schedule_runs (id, schedule_id, scheduled_for, status)
       VALUES ('schedule_run-1111111111111-runningaa', $1, now() - interval '1 minute', 'running')`,
      [row!.schedule_id]
    );
    const skipped = JSON.parse((await runAsA(id)).output) as {
      run: { status: string; error?: string };
      note: string;
    };
    expect(skipped.run).toEqual({ status: 'skipped', error: 'Previous run is still going' });
    expect(skipped.note).toBe('Skipped (Previous run is still going): nothing was posted.');
    await sql(`DELETE FROM public.schedule_runs WHERE id = 'schedule_run-1111111111111-runningaa'`);

    for (let i = 0; i < 3; i += 1) {
      expect(JSON.parse((await runAsA(id)).output).run.status).toBe('succeeded');
    }
    const fourth = await runAsA(id);
    expect(fourth.success).toBe(false);
    expect(fourth.error).toMatch(
      /^You can run an automation at most 3 times an hour\. Try this one again after .+ P[DS]T\.$/
    );
    // 1 by the person + 3 by the agent.
    expect(await wakes()).toHaveLength(4);
    // People still have no limit.
    expect((await automationService.runNow(id)).run.status).toBe('succeeded');
    // The limit is per automation.
    const other = await makeAutomation();
    expect(JSON.parse((await runAsA(other)).output).run.status).toBe('succeeded');
  });
});

describe('automation tool: runs', () => {
  it('pages the run log newest first, with due times in the zone and in UTC', async () => {
    const id = await makeAutomation();
    for (let i = 0; i < 3; i += 1) await runAsA(id);
    const first = JSON.parse((await call({ op: 'runs', id, limit: 2 }, asAgentA)).output) as {
      id: string;
      name: string;
      tz: string;
      runs: Array<{ due_at: string; due_local: string; status: string; manual: boolean }>;
      next_cursor: string | null;
    };
    expect(first).toMatchObject({ id, name: 'Check the build', tz: LA });
    expect(first.runs).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));
    for (const run of first.runs) {
      expect(run).toEqual({
        due_at: expect.stringMatching(/Z$/),
        due_local: expect.stringMatching(/ P[DS]T$/),
        status: 'succeeded',
        manual: true,
      });
    }
    expect(Date.parse(first.runs[0]!.due_at)).toBeGreaterThanOrEqual(
      Date.parse(first.runs[1]!.due_at)
    );

    const second = JSON.parse(
      (await call({ op: 'runs', id, limit: 2, before: first.next_cursor }, asAgentA)).output
    ) as { runs: Array<{ due_at: string }>; next_cursor: string | null };
    expect(second.runs).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(Date.parse(second.runs[0]!.due_at)).toBeLessThanOrEqual(
      Date.parse(first.runs[1]!.due_at)
    );

    // Default page is 10; like list with mine false, any agent may read it.
    const byB = JSON.parse((await call({ op: 'runs', id }, asAgentB, AGENT_B)).output) as {
      runs: unknown[];
    };
    expect(byB.runs).toHaveLength(3);
  });

  it('checks limit, before and the id', async () => {
    const id = await makeAutomation();
    for (const limit of [0, 51, 2.5, 'ten']) {
      expect((await call({ op: 'runs', id, limit }, asAgentA)).error).toBe(
        'limit must be a whole number from 1 to 50.'
      );
    }
    expect((await call({ op: 'runs', id, before: 'nope' }, asAgentA)).error).toBe(
      'before must be the nextCursor of a previous page.'
    );
    expect((await call({ op: 'runs', id: 'automation-1111111111111-none' }, asAgentA)).error).toBe(
      'Automation automation-1111111111111-none not found.'
    );
    expect((await call({ op: 'runs' }, asAgentA)).error).toBe('id is required.');
  });
});
