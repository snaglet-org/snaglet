/**
 * Unattended wakes never wait for a confirmation, end to end: the real
 * dispatch, wave loop, turn loop and tool dispatch against PostgreSQL, with a
 * scripted agent (scenarioHarness) that calls an ask-first tool
 * (`get_current_datetime`, harmless) and replies "done".
 *
 * Automation and hook wakes follow their policy without a prompt (`skip`, the
 * default, skips the call with a tool error; `auto-approve-allowed` runs it)
 * and log an `[unattended] …` line; a person's send still prompts. Starts an
 * agent triggered, runs downstream of an unattended one, waves carrying a
 * person's message and chains with a `skip` hook are never auto-approved.
 */
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { getDb, Messages } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { HookRegistrations } from '@snaglet/db/tables/hook_registrations';
import type { UnattendedPolicy, UnattendedWake } from '@snaglet/shared/types';
import { generateId } from '@snaglet/shared/utils';

const mockHalted = new Set<string>();
jest.mock('@server/services/summary/summaryHalt', () => ({
  ...jest.requireActual<object>('@server/services/summary/summaryHalt'),
  isThreadSummaryHalted: (threadId: string) => mockHalted.has(threadId),
}));
jest.mock('@server/services/SocketService/dispatch/summaryHaltedWakes', () => ({
  ...jest.requireActual<object>('@server/services/SocketService/dispatch/summaryHaltedWakes'),
  liftSummaryHaltAndReplayWakes: async () => false,
}));

import { runWithActor } from '@server/realtime/actorContext';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import {
  postAgentMessageToThread,
  type PostedMessageDispatch,
} from '@server/services/ThreadDeliveryPolicyService';
import {
  runAtChainDepth,
  runCappedUnattended,
  runWithUnattended,
} from '@server/realtime/runContext';
import {
  listHeldWakes,
  resetHeldWakesForTests,
} from '@server/services/SocketService/dispatch/summaryHaltedWakes';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { automationService } from '@server/services/automations/AutomationService';
import { resolveToolConfirmation } from '@server/services/SocketService/confirmation';
import {
  dispatchToThread,
  redispatchPersistedMessage,
} from '@server/services/SocketService/dispatch/dispatchToThread';
import { resolveUnattendedWake } from '@server/services/SocketService/dispatch/unattendedWake';
import {
  createScenario,
  pinConversationCompaction,
  pinEmbeddingsUnavailable,
  waitFor,
  type Scenario,
} from './waveScenarios/scenarioHarness';

const TOOL = 'get_current_datetime';
const HOOK = 'test-unattended-hook';
const HOOK_B = 'test-unattended-hook-b';
const LA = 'America/Los_Angeles';
const SINCE = '2026-01-01T00:00:00.000Z';

pinConversationCompaction();
pinEmbeddingsUnavailable();

// The builtin tool rows the agent's tool access resolves against.
beforeAll(async () => {
  await toolRegistry.load();
  await toolRegistry.syncToDatabase();
});

let scenarios: Scenario[] = [];
let automationIds: string[] = [];

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await getDb().query<T>(text, params)).rows;
}

/**
 * One scripted agent that calls the ask-first tool once (after `delayMs`),
 * then replies "done".
 */
async function askingAgentThread(prefix: string, delayMs = 0): Promise<Scenario> {
  const scenario = await createScenario({
    prefix,
    agents: [
      {
        key: 'host',
        script: [
          { ...(delayMs ? { delayMs } : {}), toolCalls: [{ name: TOOL, input: {} }] },
          { reply: 'done' },
        ],
      },
    ],
  });
  await Agents.update(scenario.ids.host!, {
    toolAccessAllowList: [TOOL],
    toolOverrides: { [TOOL]: { requiresConfirmation: true } },
  });
  scenarios.push(scenario);
  return scenario;
}

async function replied(scenario: Scenario): Promise<boolean> {
  return (await scenario.assistantMessages()).some(
    (message) => message.agentId === scenario.ids.host && message.content === 'done'
  );
}

/** Wait for the agent's reply: a run that waited on a prompt would never get there. */
async function waitForReply(scenario: Scenario, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await replied(scenario))) {
    if (Date.now() > until) throw new Error('the unattended run never replied');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function unattendedLines(scenario: Scenario): Promise<string[]> {
  return (await scenario.allMessages())
    .filter((m) => m.messageType === 'thread_event' && m.content.startsWith('[unattended]'))
    .map((m) => m.content);
}

function confirmationRequests(scenario: Scenario) {
  return scenario.events.filter((e) => e.type === 'socket:tool:confirmation_request');
}

function toolResults(scenario: Scenario) {
  return scenario.events.filter((e) => e.type === 'socket:tool:result');
}

async function makeAutomation(scenario: Scenario, policy?: UnattendedPolicy): Promise<string> {
  const automation = await automationService.create(
    {
      name: 'Test automation',
      prompt: 'Tell the time.',
      when: { every: '1h', tz: LA },
      calendarId: null,
      threadId: scenario.threadId,
      agentId: scenario.ids.host,
      ...(policy ? { unattendedPolicy: policy } : {}),
    },
    { kind: 'person' }
  );
  automationIds.push(automation.id);
  return automation.id;
}

/** Persist a message as a hook's `thread` op `send` does (the ghost agent, chain-stamped). */
async function postAsHook(scenario: Scenario, chain: readonly string[] = [HOOK]) {
  const messageId = generateId('message');
  const content = `@${scenario.names.host} tell the time`;
  await Messages.create({
    id: messageId,
    threadId: scenario.threadId,
    role: 'assistant',
    content,
    agentId: 'ghost',
    metadata: { chain: { depth: chain.length, hooks: [...chain] } },
  });
  return { messageId, content };
}

/** Post a message as the hook would and dispatch it inside the hook's chain. */
async function sendFromHook(scenario: Scenario, chain: readonly string[] = [HOOK]) {
  const { messageId, content } = await postAsHook(scenario, chain);
  return runAtChainDepth(
    chain.length,
    () =>
      dispatchToThread({
        threadId: scenario.threadId,
        senderId: 'ghost',
        messageId,
        message: content,
        source: 'tool',
      }),
    undefined,
    chain
  );
}

/** A person's message in the thread (persisted only; nothing dispatched). */
async function postAsPerson(scenario: Scenario, content = 'I am here.'): Promise<string> {
  const id = generateId('message');
  await Messages.create({
    id,
    threadId: scenario.threadId,
    role: 'user',
    content,
    userId: scenario.userId,
  });
  return id;
}

async function registerHook(policy: UnattendedPolicy, name = HOOK): Promise<void> {
  await sql(
    `INSERT INTO public.hook_registrations (id, name, source_path, unattended_policy)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET unattended_policy = EXCLUDED.unattended_policy`,
    [`hookreg-${name}`, name, `/tmp/${name}/hook.ts`, policy]
  );
}

const AGENT_ACTOR = (scenario: Scenario) => ({
  actorKind: 'agent' as const,
  actorId: scenario.ids.host!,
  actorName: scenario.names.host!,
});

/** The run ended with its reply and wrote exactly this `[unattended]` line. */
async function expectOneLine(scenario: Scenario, line: string): Promise<void> {
  await waitForReply(scenario);
  expect(confirmationRequests(scenario)).toEqual([]);
  expect(await unattendedLines(scenario)).toEqual([line]);
}

afterEach(async () => {
  for (const id of automationIds) {
    await waitFor(() => !automationService.isWakeLive(id), { label: 'automation wake settled' });
    const [row] = await sql<{ schedule_id: string | null }>(
      'SELECT schedule_id FROM public.automations WHERE id = $1',
      [id]
    );
    await sql('DELETE FROM public.automations WHERE id = $1', [id]);
    if (row?.schedule_id) {
      await sql('DELETE FROM public.schedules WHERE id = $1', [row.schedule_id]);
    }
  }
  automationIds = [];
  mockHalted.clear();
  resetHeldWakesForTests();
  await sql('DELETE FROM public.hook_registrations WHERE name = ANY($1)', [[HOOK, HOOK_B]]);
  for (const scenario of scenarios) {
    await sql('DELETE FROM public.agent_activity_log WHERE agent_id = $1', [scenario.ids.host]);
    await scenario.cleanup();
  }
  scenarios = [];
});

describe('an automation-started run with a tool that asks first', () => {
  it('skip (the default): the call is skipped, the run ends with its reply', async () => {
    const scenario = await askingAgentThread('unattendedskip');
    const automationId = await makeAutomation(scenario);
    expect((await automationService.get(automationId)).unattendedPolicy).toBe('skip');

    const { run } = await automationService.runNow(automationId);
    expect(run.status).toBe('succeeded');
    await waitForReply(scenario);

    expect(confirmationRequests(scenario)).toEqual([]);
    expect(toolResults(scenario)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          success: false,
          error: expect.stringContaining('skipped (unattended run'),
        }),
      }),
    ]);
    expect(await unattendedLines(scenario)).toEqual([
      `[unattended] skipped ${TOOL} · ${scenario.names.host} · automation "Test automation" · needs a person to confirm`,
    ]);
    const logged = await sql<{ tool: string; tool_output: { error?: string } }>(
      'SELECT tool, tool_output FROM public.agent_activity_log WHERE agent_id = $1',
      [scenario.ids.host]
    );
    expect(logged).toContainEqual({
      tool: TOOL,
      tool_output: { error: expect.stringContaining('needs a person to confirm') },
    });
  }, 60_000);

  it('auto-approve-allowed: the call runs without a prompt, the run ends with its reply', async () => {
    const scenario = await askingAgentThread('unattendedauto');
    const automationId = await makeAutomation(scenario, 'auto-approve-allowed');

    await automationService.runNow(automationId);
    await waitForReply(scenario);

    expect(confirmationRequests(scenario)).toEqual([]);
    expect(toolResults(scenario)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ success: true }) }),
    ]);
    expect(await unattendedLines(scenario)).toEqual([
      `[unattended] auto-approved ${TOOL} · ${scenario.names.host} · automation "Test automation"`,
    ]);
  }, 60_000);
});

describe('a hook-woken run follows the hook’s policy', () => {
  it('names the last hook in the chain and takes the strictest policy across it', async () => {
    const now = new Date(SINCE);
    expect(await resolveUnattendedWake({ hookChain: [] })).toBeUndefined();
    expect(await resolveUnattendedWake({ hookChain: ['test-unregistered-hook'], now })).toEqual({
      source: 'hook',
      id: 'test-unregistered-hook',
      name: 'test-unregistered-hook',
      policy: 'skip',
      since: SINCE,
    });
    await registerHook('auto-approve-allowed');
    expect(await resolveUnattendedWake({ hookChain: [HOOK] })).toMatchObject({
      source: 'hook',
      id: HOOK,
      policy: 'auto-approve-allowed',
    });
    // An unregistered or `skip` hook anywhere in the chain makes it skip.
    expect(
      await resolveUnattendedWake({ hookChain: ['test-unregistered-hook', HOOK] })
    ).toMatchObject({ id: HOOK, policy: 'skip' });
    await registerHook('skip', HOOK_B);
    expect(await resolveUnattendedWake({ hookChain: [HOOK_B, HOOK] })).toMatchObject({
      id: HOOK,
      policy: 'skip',
    });
    await registerHook('auto-approve-allowed', HOOK_B);
    expect(await resolveUnattendedWake({ hookChain: [HOOK_B, HOOK] })).toMatchObject({
      id: HOOK,
      policy: 'auto-approve-allowed',
    });
    // Capped, or downstream of an unattended run: skip whatever is stored.
    expect(await resolveUnattendedWake({ hookChain: [HOOK], capped: true })).toMatchObject({
      policy: 'skip',
    });
    const upstream: UnattendedWake = {
      source: 'automation',
      id: 'automation-1111111111111-aaaaaaaaa',
      name: 'Upstream',
      policy: 'auto-approve-allowed',
      since: SINCE,
    };
    expect(await resolveUnattendedWake({ hookChain: [], enclosing: upstream })).toMatchObject({
      source: 'automation',
      name: 'Upstream',
      policy: 'skip',
    });
  });

  it.each([
    ['skip', false, 'skipped', ' · needs a person to confirm'],
    ['auto-approve-allowed', true, 'auto-approved', ''],
  ] as const)(
    '%s: the run never waits and ends with its reply',
    async (policy, ran, verb, note) => {
      const scenario = await askingAgentThread(
        policy === 'skip' ? 'unattendedhookskip' : 'unattendedhookauto'
      );
      await registerHook(policy);

      const result = await sendFromHook(scenario);

      expect(result).toMatchObject({ ok: true, wakeCount: 1 });
      expect(await replied(scenario)).toBe(true);
      expect(confirmationRequests(scenario)).toEqual([]);
      expect(toolResults(scenario)).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ success: ran }) }),
      ]);
      expect(await unattendedLines(scenario)).toEqual([
        `[unattended] ${verb} ${TOOL} · ${scenario.names.host} · hook "${HOOK}"${note}`,
      ]);
    },
    60_000
  );
});

describe('a person’s run is unchanged', () => {
  it('still prompts, and goes on once the person approves', async () => {
    const scenario = await askingAgentThread('unattendedattended');

    const sending = scenario.send(`@${scenario.names.host} tell the time`);
    await waitFor(() => confirmationRequests(scenario).length === 1, {
      timeoutMs: 30_000,
      label: 'confirmation prompt',
    });
    const [request] = confirmationRequests(scenario);
    await resolveToolConfirmation(
      scenario.threadId,
      String(request!.payload['callId']),
      'approve_once'
    );
    await sending;

    expect(await replied(scenario)).toBe(true);
    expect(toolResults(scenario)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ success: true }) }),
    ]);
    expect(await unattendedLines(scenario)).toEqual([]);
  }, 60_000);
});

describe('a start an agent triggers is never auto-approved', () => {
  it("an agent's Run now of an auto-approve automation skips (and marks the wake)", async () => {
    const scenario = await askingAgentThread('unattendedagentrun');
    const agent = {
      kind: 'agent' as const,
      agentId: scenario.ids.host!,
      threadId: scenario.threadId,
      runId: null,
    };
    const created = await automationService.create(
      {
        name: 'Test automation',
        prompt: 'Tell the time.',
        when: { every: '1h', tz: LA },
        threadId: scenario.threadId,
        agentId: scenario.ids.host,
      },
      agent
    );
    automationIds.push(created.id);
    await automationService.update(
      created.id,
      { unattendedPolicy: 'auto-approve-allowed' },
      { kind: 'person' }
    );

    await runWithActor(AGENT_ACTOR(scenario), () => automationService.runNow(created.id, agent));

    await expectOneLine(
      scenario,
      `[unattended] skipped ${TOOL} · ${scenario.names.host} · automation "Test automation" · needs a person to confirm`
    );
    const [seed] = await sql<{ metadata: { automation?: { agentStarted?: boolean } } }>(
      `SELECT metadata FROM public.messages WHERE thread_id = $1 AND metadata ? 'automation'`,
      [scenario.threadId]
    );
    expect(seed?.metadata.automation?.agentStarted).toBe(true);
  }, 60_000);

  it.each([
    ["from an agent's tool call (its thread send)", 'unattendedagentsend', 'agent'],
    ['from a capped hook run (an agent ran the hook)', 'unattendedcapped', 'capped'],
  ] as const)(
    'a hook message dispatched %s skips',
    async (_label, prefix, how) => {
      const scenario = await askingAgentThread(prefix);
      await registerHook('auto-approve-allowed');

      await (how === 'agent'
        ? runWithActor(AGENT_ACTOR(scenario), () => sendFromHook(scenario))
        : runCappedUnattended(() => sendFromHook(scenario)));

      await expectOneLine(
        scenario,
        `[unattended] skipped ${TOOL} · ${scenario.names.host} · hook "${HOOK}" · needs a person to confirm`
      );
    },
    60_000
  );

  it('a run downstream of an unattended one (a helper, a send) carries the marker, as skip', async () => {
    const scenario = await askingAgentThread('unattendeddownstream');
    const upstream: UnattendedWake = {
      source: 'automation',
      id: 'automation-1111111111111-aaaaaaaaa',
      name: 'Upstream',
      policy: 'auto-approve-allowed',
      since: SINCE,
    };

    await runWithUnattended(upstream, () => scenario.send(`@${scenario.names.host} go`));

    await expectOneLine(
      scenario,
      `[unattended] skipped ${TOOL} · ${scenario.names.host} · automation "Upstream" · needs a person to confirm`
    );
  }, 60_000);
});

describe('someone else in the wave caps it at skip', () => {
  it("an agent-caused hook's send queued on a busy thread stays capped after the queue", async () => {
    // An agent writes a row → the hook fires capped → it posts into the
    // agent's own busy thread → the wake waits for the post-run redispatch,
    // which runs in a fresh context. The cap rides on the message's stamp.
    await registerHook('auto-approve-allowed');
    const scenario = await askingAgentThread('unattendedqueued');
    const session = `session-unattendedqueued-${Date.now()}`;
    expect(activeRunTracker.startSession(session, scenario.threadId)).toBe(true);

    let settled: PostedMessageDispatch | undefined;
    const { messageId } = await runAtChainDepth(
      1,
      () =>
        runCappedUnattended(() =>
          postAgentMessageToThread({
            threadId: scenario.threadId,
            agentId: 'ghost',
            content: `@${scenario.names.host} tell the time`,
            onDispatchSettled: (outcome) => (settled = outcome),
          })
        ),
      undefined,
      [HOOK]
    );
    await waitFor(() => settled !== undefined, { label: 'queued dispatch settled' });
    expect(settled).toMatchObject({ result: { reason: 'queued_for_post_run' } });
    const [row] = await sql<{ metadata: { chain?: { capped?: boolean } } }>(
      'SELECT metadata FROM public.messages WHERE id = $1',
      [messageId]
    );
    expect(row?.metadata.chain).toEqual({ depth: 1, hooks: [HOOK], capped: true });

    activeRunTracker.takeSkippedSeeds(session);
    activeRunTracker.finishSession(session);
    await redispatchPersistedMessage({
      threadId: scenario.threadId,
      threadName: 'queued',
      messageId,
      coveredMessageIds: [messageId],
      undeliveredCount: 1,
      reason: 'test',
    });

    await expectOneLine(
      scenario,
      `[unattended] skipped ${TOOL} · ${scenario.names.host} · hook "${HOOK}" · needs a person to confirm`
    );
  }, 60_000);

  it('a redispatch covering a hook message and a person message skips', async () => {
    await registerHook('auto-approve-allowed');
    const mixed = await askingAgentThread('unattendedredispatchmixed');
    const personId = await postAsPerson(mixed, `@${mixed.names.host} and also this`);
    const hookMessage = await postAsHook(mixed);
    await redispatchPersistedMessage({
      threadId: mixed.threadId,
      threadName: 'mixed',
      messageId: hookMessage.messageId,
      coveredMessageIds: [personId, hookMessage.messageId],
      undeliveredCount: 2,
      reason: 'test',
    });
    await expectOneLine(
      mixed,
      `[unattended] skipped ${TOOL} · ${mixed.names.host} · hook "${HOOK}" · needs a person to confirm`
    );
  }, 60_000);

  it('control: a queued message from a hook run a schedule started (uncapped stamp) approves', async () => {
    await registerHook('auto-approve-allowed');
    const scenario = await askingAgentThread('unattendedredispatchcontrol');
    const hookOnly = await postAsHook(scenario);
    await redispatchPersistedMessage({
      threadId: scenario.threadId,
      threadName: 'control',
      messageId: hookOnly.messageId,
      coveredMessageIds: [hookOnly.messageId],
      undeliveredCount: 1,
      reason: 'test',
    });
    await expectOneLine(
      scenario,
      `[unattended] auto-approved ${TOOL} · ${scenario.names.host} · hook "${HOOK}"`
    );
  }, 60_000);

  it('a person posting while an auto-approve run is going stops its approvals', async () => {
    const scenario = await askingAgentThread('unattendedmidrun', 1_000);
    await registerHook('auto-approve-allowed');

    const sending = sendFromHook(scenario);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await postAsPerson(scenario);
    await sending;

    await expectOneLine(
      scenario,
      `[unattended] skipped ${TOOL} · ${scenario.names.host} · hook "${HOOK}" · someone else posted in this thread, so nothing is auto-approved`
    );
  }, 60_000);

  it('a capped message counts as someone else, even from the ghost or the agent itself', async () => {
    const scenario = await askingAgentThread('unattendedcappedrow');
    const since = new Date(Date.now() - 1_000).toISOString();
    const others = () =>
      Messages.hasMessageFromOthersSince(scenario.threadId, since, scenario.ids.host!, 'ghost');

    await postAsHook(scenario); // an uncapped hook message (the ghost)
    await Messages.create({
      id: generateId('message'),
      threadId: scenario.threadId,
      role: 'assistant',
      content: 'my own reply',
      agentId: scenario.ids.host!,
    });
    expect(await others()).toBe(false);

    await Messages.create({
      id: generateId('message'),
      threadId: scenario.threadId,
      role: 'assistant',
      content: 'my own capped send',
      agentId: scenario.ids.host!,
      metadata: { chain: { depth: 1, hooks: [HOOK], capped: true } },
    });
    expect(await others()).toBe(true);
  });

  it("an agent woken by another agent's @mention in the wave is not auto-approved", async () => {
    await registerHook('auto-approve-allowed');
    const prefix = 'unattendedpeer';
    const scenario = await createScenario({
      prefix,
      dispatchMode: 'mentioned',
      agents: [
        { key: 'lead', script: [{ reply: `@${prefix}-host your turn` }] },
        {
          key: 'host',
          script: [{ toolCalls: [{ name: TOOL, input: {} }] }, { reply: 'done' }],
        },
      ],
    });
    await Agents.update(scenario.ids.host!, {
      toolAccessAllowList: [TOOL],
      toolOverrides: { [TOOL]: { requiresConfirmation: true } },
    });
    scenarios.push(scenario);

    // The hook wakes only the lead; the lead's reply wakes the host.
    const messageId = generateId('message');
    const content = `@${scenario.names.lead} start`;
    await Messages.create({
      id: messageId,
      threadId: scenario.threadId,
      role: 'assistant',
      content,
      agentId: 'ghost',
      metadata: { chain: { depth: 1, hooks: [HOOK] } },
    });
    await runAtChainDepth(
      1,
      () =>
        dispatchToThread({
          threadId: scenario.threadId,
          senderId: 'ghost',
          messageId,
          message: content,
          source: 'tool',
        }),
      undefined,
      [HOOK]
    );

    await expectOneLine(
      scenario,
      `[unattended] skipped ${TOOL} · ${scenario.names.host} · hook "${HOOK}" · someone else posted in this thread, so nothing is auto-approved`
    );
  }, 60_000);
});

describe('the marker across a summary halt and a hook code change', () => {
  it('a wake held by a summary halt keeps its marker for the replay', async () => {
    const scenario = await askingAgentThread('unattendedheld');
    await registerHook('auto-approve-allowed');
    mockHalted.add(scenario.threadId);

    const held = await sendFromHook(scenario);
    expect(held).toMatchObject({ reason: 'held_for_summary_halt', wakeCount: 0 });
    const [wake] = listHeldWakes(scenario.threadId);
    expect(wake?.unattended).toMatchObject({
      source: 'hook',
      id: HOOK,
      policy: 'auto-approve-allowed',
    });

    // Replayed later from a context with no hook chain: still the hook's run.
    mockHalted.delete(scenario.threadId);
    await dispatchToThread(wake!);
    await expectOneLine(
      scenario,
      `[unattended] auto-approved ${TOOL} · ${scenario.names.host} · hook "${HOOK}"`
    );
  }, 60_000);

  it("a hook's new code or bundle puts its policy back to skip; the same build keeps it", async () => {
    const built = { buildStatus: 'ready' as const, sourceHash: 'source-a', buildHash: 'bundle-a' };
    await registerHook('auto-approve-allowed');
    await HookRegistrations.setBuildState(HOOK, built);
    await HookRegistrations.setUnattendedPolicy(HOOK, 'auto-approve-allowed');

    const same = await HookRegistrations.setBuildState(HOOK, built);
    expect(same?.unattendedPolicy).toBe('auto-approve-allowed');
    const failed = await HookRegistrations.setBuildState(HOOK, {
      buildStatus: 'failed',
      lastError: 'syntax error',
    });
    expect(failed?.unattendedPolicy).toBe('auto-approve-allowed');

    // hook.ts changed.
    const newSource = await HookRegistrations.setBuildState(HOOK, {
      ...built,
      sourceHash: 'source-b',
    });
    expect(newSource?.unattendedPolicy).toBe('skip');

    // hook.ts unchanged, but the bundle changed (a sibling import it pulls in).
    await HookRegistrations.setUnattendedPolicy(HOOK, 'auto-approve-allowed');
    const newBundle = await HookRegistrations.setBuildState(HOOK, {
      ...built,
      sourceHash: 'source-b',
      buildHash: 'bundle-b',
    });
    expect(newBundle?.unattendedPolicy).toBe('skip');
  });
});
