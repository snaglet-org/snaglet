/**
 * The `automation` tool through ToolExecutor against the real
 * database and tool catalog: the agent rules come from the tool context
 * (own thread and self only, nothing from an automated run, 3 per run), a
 * person (no agent context, or the panel acting as an agent) may set any
 * thread and agent, the agent's tool-access policy applies through the
 * action gateway, and the generic table writer refuses the Automations table.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: async () => ({ ok: true, reason: 'completed', wakeCount: 1, capHit: false }),
}));

import { Agents, Threads, ThreadParticipants, getDb } from '@snaglet/db';
import { AUTOMATIONS_TABLE_ID } from '@snaglet/shared/types';
import { runWithRunContext } from '@server/realtime/runContext';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { findResolvedAgentTool } from '@server/services/ToolService/lib/resolveAgentTool';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';
const THREAD_A = 'thread-1111111111111-tooleaaaa';
const THREAD_B = 'thread-1111111111111-toolebbbb';

const asAgent: ToolHandlerContext = { agentId: AGENT_A, threadId: THREAD_A };

async function run(
  input: Record<string, unknown>,
  context?: ToolHandlerContext,
  agentId = AGENT_A
) {
  const tools = await resolveAgentTools(agentId);
  const agentTool =
    findResolvedAgentTool(tools, 'automation') ??
    ({
      agentId: '',
      tool: { id: 'automation', name: 'Automation' },
      settings: {},
      requiresConfirmation: false,
    } as unknown as Parameters<typeof toolExecutor.execute>[1]);
  return toolExecutor.execute({ name: 'automation', input }, agentTool, context);
}

const create = (extra: Record<string, unknown> = {}) => ({
  op: 'create',
  name: 'Check the build',
  prompt: 'Look at the build and report.',
  when: { every: '1h' },
  ...extra,
});

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
  await Agents.create({
    id: AGENT_B,
    name: 'Test Agent B',
    ...model,
    toolAccessMode: 'deny_list',
    toolAccessDenyList: ['automation'],
  });
  await Threads.create({ id: THREAD_A, title: 'Thread A' });
  await Threads.create({ id: THREAD_B, title: 'Thread B' });
  await ThreadParticipants.addParticipant({ threadId: THREAD_A, agentId: AGENT_A });
  await ThreadParticipants.addParticipant({ threadId: THREAD_B, agentId: AGENT_A });
  await ThreadParticipants.addParticipant({ threadId: THREAD_B, agentId: AGENT_B });
});

beforeEach(async () => {
  await getDb().query(`DELETE FROM public.automations`);
  await getDb().query(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
});

describe('automation tool', () => {
  afterAll(async () => {
    await getDb().query(`DELETE FROM public.automations`);
    await getDb().query(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
  });

  it('is a registered builtin with a short description', () => {
    const definition = toolRegistry.getDefinition('automation');
    expect(definition).toMatchObject({ id: 'automation', tier: 'standard', type: 'builtin' });
    expect(definition!.description.length).toBeLessThan(500);
  });

  it('creates a wake for the calling agent in its own thread, recording the run', async () => {
    const result = await runWithRunContext(
      { threadId: THREAD_A, runId: 'run-1111111111111-toolaaaaa' },
      () => run(create(), asAgent)
    );
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output) as {
      automation: Record<string, unknown>;
      when_input: unknown;
    };
    expect(out.automation).toMatchObject({
      status: 'active',
      when: 'every hour',
      thread_id: THREAD_A,
      agent_id: AGENT_A,
      // An Every goes on the Default calendar too.
      calendar_id: expect.any(String),
    });
    expect(out.when_input).toEqual({ every: '1h' });
    const { rows } = await getDb().query(
      `SELECT created_by_agent_id, created_run_id FROM public.automations`
    );
    expect(rows).toEqual([
      { created_by_agent_id: AGENT_A, created_run_id: 'run-1111111111111-toolaaaaa' },
    ]);

    const listed = await run({ op: 'list' }, asAgent);
    expect(JSON.parse(listed.output).automations).toHaveLength(1);
  });

  it('get returns complete detail without changing the stored record or scheduling a wake', async () => {
    const made = await run(create(), asAgent);
    expect(made.success).toBe(true);
    const id = JSON.parse(made.output).automation.id as string;
    const before = await getDb().query(`SELECT * FROM public.automations WHERE id = $1`, [id]);
    const schedules = await getDb().query(
      `SELECT * FROM public.schedules WHERE action_kind = 'automation'`
    );
    const result = await run({ op: 'get', id }, asAgent);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).automation).toMatchObject({
      id,
      name: 'Check the build',
      prompt: 'Look at the build and report.',
      agent_id: AGENT_A,
      agent_name: 'Test Agent A',
      thread_id: THREAD_A,
      thread_title: 'Thread A',
      status: 'active',
      when: 'every hour',
      schedule: { kind: 'interval', everyMs: 3_600_000, anchor: expect.any(String) },
      next_run_at: expect.any(String),
      next_run_local: expect.any(String),
      last_run: null,
      running: false,
    });
    expect(
      (await getDb().query(`SELECT * FROM public.automations WHERE id = $1`, [id])).rows
    ).toEqual(before.rows);
    expect(
      (await getDb().query(`SELECT * FROM public.schedules WHERE action_kind = 'automation'`)).rows
    ).toEqual(schedules.rows);
    expect(
      (
        await getDb().query(`SELECT * FROM public.schedule_runs WHERE schedule_id = $1`, [
          before.rows[0].schedule_id,
        ])
      ).rows
    ).toHaveLength(0);
  });

  it('get accepts person-created wakes for the caller but never returns another agent record', async () => {
    const own = await run(create({ thread_id: THREAD_A, agent_id: AGENT_A }));
    const ownId = JSON.parse(own.output).automation.id as string;
    expect((await run({ op: 'get', id: ownId }, asAgent)).success).toBe(true);
    const other = await run(create({ thread_id: THREAD_B, agent_id: AGENT_B }));
    const id = JSON.parse(other.output).automation.id as string;
    const refused = await run({ op: 'get', id }, asAgent);
    expect(refused.success).toBe(false);
    expect(refused.error).toBe('You can only read automations that wake you.');
    expect(refused.output).not.toContain('Look at the build and report.');
    expect((await run({ op: 'get', id })).success).toBe(true);
    const missing = await run({ op: 'get', id: 'automation-1111111111111-none' }, asAgent);
    expect(missing.error).toBe('Automation automation-1111111111111-none not found.');
    expect((await run({ op: 'get', automation_id: ownId }, asAgent)).error).toBe('id is required.');
  });

  it('returns the exact error texts for agent rules and bad input', async () => {
    const other = await run(create({ thread_id: THREAD_B }), asAgent);
    expect(other).toMatchObject({
      success: false,
      error: 'Agents can only schedule wakes in their own thread.',
    });
    const someoneElse = await run(create({ agent_id: AGENT_B }), asAgent);
    expect(someoneElse.error).toBe('Agents can only schedule wakes for themselves.');
    const floor = await run(create({ when: { every: '5m' } }), asAgent);
    expect(floor.error).toBe(
      'every must be at least 15m for agents (1m for people). Down to 5m works with a window of at most 2h: add window_start and window_end, e.g. "05:05" and "06:00".'
    );
    const windowed = await run(
      create({ when: { every: '5m', window_start: '05:05', window_end: '06:00', tz: 'UTC' } }),
      asAgent
    );
    expect(windowed.success).toBe(true);
    expect(JSON.parse(windowed.output).automation.when).toBe(
      'every 5 minutes from 5:05 AM to 6:00 AM (UTC)'
    );
    const halfWindow = await run(
      create({ when: { every: '15m', window_start: '05:05' } }),
      asAgent
    );
    expect(halfWindow.error).toBe(
      'A window needs both window_start and window_end, e.g. {every:"5m", window_start:"05:05", window_end:"06:00"}.'
    );
    const withAt = await run(
      create({
        when: { every: '15m', at: '2030-01-01T05:05', window_start: '05:05', window_end: '06:00' },
      }),
      asAgent
    );
    expect(withAt.error).toBe('every with a window runs from window_start each day; leave out at.');
    const shape = await run(create({ when: { in: '2h', every: '1h' } }), asAgent);
    expect(shape.error).toBe('when must have exactly one of in, at, repeat, every, first_open.');
    const missing = await run({ op: 'pause', id: 'automation-1111111111111-none' }, asAgent);
    expect(missing.error).toBe('Automation automation-1111111111111-none not found.');
    const op = await run({ op: 'delete' }, asAgent);
    expect(op.error).toMatch(/^op is required and must be one of create \| list/);
  });

  it('calendar_id null is no calendar; left out, create uses the Default one and update keeps it', async () => {
    const made = await run(create({ when: { in: '2h' }, calendar_id: null }), asAgent);
    expect(made.success).toBe(true);
    const id = JSON.parse(made.output).automation.id as string;
    expect(JSON.parse(made.output).automation.calendar_id).toBeNull();

    const renamed = await run({ op: 'update', id, name: 'Renamed' }, asAgent);
    expect(JSON.parse(renamed.output).automation.calendar_id).toBeNull();

    const onDefault = await run(create({ when: { in: '3h' } }), asAgent);
    const defaultId = JSON.parse(onDefault.output).automation.calendar_id as string;
    expect(defaultId).toEqual(expect.any(String));
    const moved = await run({ op: 'update', id, calendar_id: defaultId }, asAgent);
    expect(JSON.parse(moved.output).automation.calendar_id).toBe(defaultId);
    const off = await run({ op: 'update', id, calendar_id: null }, asAgent);
    expect(JSON.parse(off.output).automation.calendar_id).toBeNull();

    const blank = await run({ op: 'update', id, calendar_id: '' }, asAgent);
    expect(blank.error).toBe('calendar_id must be a calendar id, or null for no calendar.');

    // An Every takes a calendar like any other, and keeps it when the timing changes.
    const every = await run(
      { op: 'update', id, when: { every: '1h' }, calendar_id: defaultId },
      asAgent
    );
    expect(JSON.parse(every.output).automation).toMatchObject({
      when: 'every hour',
      calendar_id: defaultId,
    });
    const slower = await run({ op: 'update', id, when: { every: '2h' } }, asAgent);
    expect(JSON.parse(slower.output).automation.calendar_id).toBe(defaultId);
    const none = await run(create({ calendar_id: null }), asAgent);
    expect(JSON.parse(none.output).automation.calendar_id).toBeNull();
  });

  it('every with at anchors the interval; every with in is still refused', async () => {
    const made = await run(
      create({ when: { every: '15m', at: '2030-01-01T00:07', tz: 'UTC' } }),
      asAgent
    );
    expect(made.success).toBe(true);
    const created = JSON.parse(made.output).automation;
    expect(created).toMatchObject({
      when: 'every 15 minutes',
      next_run_at: '2030-01-01T00:07:00.000Z',
    });
    const bad = await run(create({ when: { every: '15m', in: '1h' } }), asAgent);
    expect(bad.error).toBe('when must have exactly one of in, at, repeat, every, first_open.');
  });

  it('caps creation at 3 per run', async () => {
    const ctx = { threadId: THREAD_A, runId: 'run-1111111111111-toolcapaa' };
    for (let i = 0; i < 3; i += 1) {
      expect((await runWithRunContext(ctx, () => run(create(), asAgent))).success).toBe(true);
    }
    const fourth = await runWithRunContext(ctx, () => run(create(), asAgent));
    expect(fourth.error).toBe('You can create at most 3 automations per run.');
  });

  it('refuses every write from a run an automation started, but still lists', async () => {
    const made = JSON.parse((await run(create(), asAgent)).output).automation.id as string;
    const automated: ToolHandlerContext = {
      ...asAgent,
      wakeOrigin: { kind: 'automation', automationId: made },
    };
    const refusal = "Automations can't be created or changed from a run an automation started.";
    for (const input of [
      create(),
      { op: 'update', id: made, name: 'Changed' },
      { op: 'pause', id: made },
      { op: 'resume', id: made },
      { op: 'cancel', id: made },
    ]) {
      const result = await run(input, automated);
      expect(result).toMatchObject({ success: false, error: refusal });
    }
    expect((await run({ op: 'list' }, automated)).success).toBe(true);
  });

  it('lets a person set any thread and agent (no agent context, or the panel acting as one)', async () => {
    const needsIds = await run(create());
    expect(needsIds.error).toBe('thread_id is required.');
    const bySomeone = await run(create({ thread_id: THREAD_B, agent_id: AGENT_B }));
    expect(bySomeone.success).toBe(true);
    const actAs = await run(
      create({ thread_id: THREAD_B, agent_id: AGENT_A, when: { every: '1m' } }),
      {
        agentId: AGENT_A,
        bypassToolAccess: true,
      }
    );
    expect(actAs.success).toBe(true);
    // An agent cannot change what a person made.
    const id = JSON.parse(bySomeone.output).automation.id as string;
    const pause = await run({ op: 'pause', id }, asAgent);
    expect(pause.error).toBe('You can only change automations you created.');
  });

  it.each(['list', 'get'])(
    "applies the agent's tool-access policy to %s through the action gateway",
    async (op) => {
      const made = await run(create(), asAgent);
      const id = JSON.parse(made.output).automation.id as string;
      const tools = await resolveAgentTools(AGENT_B);
      expect(findResolvedAgentTool(tools, 'automation')).toBeUndefined();
      const action = findResolvedAgentTool(tools, 'action')!;
      const blocked = await toolExecutor.execute(
        { name: 'action', input: { tool: 'automation', op, id } },
        action,
        { agentId: AGENT_B, threadId: THREAD_B }
      );
      expect(blocked.success).toBe(false);
      expect(blocked.error).toMatch(/unavailable or not permitted|Blocked by tool-access policy/);

      const allowed = await toolExecutor.execute(
        { name: 'action', input: { tool: 'automation', op, id } },
        findResolvedAgentTool(await resolveAgentTools(AGENT_A), 'action')!,
        asAgent
      );
      expect(allowed.success).toBe(true);
    }
  );

  it('the generic table writer refuses the Automations table', async () => {
    const tools = await resolveAgentTools(AGENT_A);
    const table = findResolvedAgentTool(tools, 'table')!;
    const result = await toolExecutor.execute(
      {
        name: 'table',
        input: { op: 'write', table: AUTOMATIONS_TABLE_ID, insert: [{ values: { name: 'x' } }] },
      },
      table,
      asAgent
    );
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/Use the automation tool\./);
  });
});
