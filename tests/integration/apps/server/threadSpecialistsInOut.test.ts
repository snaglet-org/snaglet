/**
 * Bringing a specialist into a thread and taking them out again, through the
 * real ToolExecutor and database: thread ops add_agents and remove_agents and
 * op leave change the roster, the removals write the same "left the thread"
 * line as the app's Remove button, and the refusals change nothing. update no
 * longer touches who is in the thread.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { sendToClient: jest.fn(), broadcastToChannel: jest.fn(), registerHandler: jest.fn() },
  addChannelObserver: jest.fn(),
}));

import { getDb, Agents, Threads } from '@snaglet/db';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Users } from '@snaglet/db/tables/users';
import { SkillAssignments } from '@snaglet/db/tables/skill_assignments';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { createLiveRoster } from '@server/services/SocketService/dispatch/liveRoster';

const PREFIX = 'specialists-io';
const LEAD = `${PREFIX}-lead`;
const NOVA = `${PREFIX}-nova`;
const ORION = `${PREFIX}-orion`;
const THREAD = `${PREFIX}-thread`;
let userId: string;

const agentTool = {
  agentId: LEAD,
  settings: {},
  requiresConfirmation: false,
  tool: {
    id: 'thread',
    name: 'Thread',
    description: 'thread',
    type: 'builtin',
    enabled: true,
    parameters_schema: {},
    config_json: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
} as Parameters<typeof toolExecutor.execute>[1];

const exec = (agentId: string, input: Record<string, unknown>) =>
  toolExecutor.execute(
    { name: 'thread', input },
    { ...agentTool, agentId },
    {
      agentId,
      threadId: THREAD,
    }
  );

async function agentParticipants(): Promise<string[]> {
  return (await ThreadParticipants.listByThread(THREAD))
    .map((p) => p.agentId)
    .filter((id): id is string => Boolean(id))
    .sort();
}

/** The roster line is written fire-and-forget, so wait for it. */
async function waitForLeftLines(count: number): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await getDb().query<{ content: string }>(
      `SELECT content FROM public.messages
        WHERE thread_id = $1 AND content LIKE '[participant removed%'
        ORDER BY created_at`,
      [THREAD]
    );
    if (rows.length >= count) return rows.map((r) => r.content);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

beforeAll(async () => {
  await toolRegistry.load();
  await Agents.create({ id: LEAD, name: 'Lead' });
  await Agents.create({ id: NOVA, name: 'Nova' });
  await Agents.create({ id: ORION, name: 'Orion' });
  const user = await Users.upsertUser({
    email: `${PREFIX}@test.local`,
    name: `${PREFIX} user`,
    authProvider: 'test',
    authProviderId: `${PREFIX}-auth`,
  });
  userId = user.id;
});

beforeEach(async () => {
  await getDb().query(`DELETE FROM public.nodes WHERE id = $1`, [THREAD]);
  await Threads.create({ id: THREAD, title: 'Pricing review' });
  await ThreadParticipants.addUserParticipant({ threadId: THREAD, userId });
  await ThreadParticipants.addParticipant({ threadId: THREAD, agentId: LEAD });
  await ThreadParticipants.addParticipant({ threadId: THREAD, agentId: NOVA });
});

describe('specialists in and out of a thread (real DB)', () => {
  it('the lead removes the specialist with remove_agents', async () => {
    const result = await exec(LEAD, { op: 'remove_agents', agent_ids: [NOVA] });

    expect(result.error ?? null).toBeNull();
    expect(result.success).toBe(true);
    expect(result.output).toContain(`Removed agents from thread 'Pricing review'`);
    expect(result.output).toContain(NOVA);
    expect(await agentParticipants()).toEqual([LEAD]);
    expect(await waitForLeftLines(1)).toEqual(['[participant removed · Nova left the thread]']);
  });

  it('the specialist leaves on its own, and can be added back', async () => {
    const left = await exec(NOVA, { op: 'leave' });
    expect(left.success).toBe(true);
    expect(left.output).toContain("You left thread 'Pricing review'");
    expect(await agentParticipants()).toEqual([LEAD]);
    expect(await waitForLeftLines(1)).toEqual(['[participant removed · Nova left the thread]']);

    const back = await exec(LEAD, { op: 'add_agents', agent_ids: [NOVA] });
    expect(back.success).toBe(true);
    expect(await agentParticipants()).toEqual([LEAD, NOVA].sort());
  });

  it('the last agent cannot leave, and a person cannot be removed', async () => {
    await exec(LEAD, { op: 'remove_agents', agent_ids: [NOVA] });

    const leave = await exec(LEAD, { op: 'remove_me' });
    expect(leave.success).toBe(false);
    expect(leave.error).toMatch(/only agent/);

    const person = await exec(LEAD, { op: 'remove_agents', agent_ids: [userId] });
    expect(person.success).toBe(false);
    expect(person.error).toMatch(/a person, not an agent/);

    const self = await exec(LEAD, { op: 'remove_agents', agent_ids: [LEAD] });
    expect(self.success).toBe(false);
    expect(self.error).toMatch(/can't remove yourself.*op "leave"/);

    expect(await agentParticipants()).toEqual([LEAD]);
    const humans = (await ThreadParticipants.listByThread(THREAD)).filter((p) => p.userId);
    expect(humans.map((p) => p.userId)).toEqual([userId]);
  });

  it('an agent that is not in the thread cannot remove anyone', async () => {
    await exec(LEAD, { op: 'remove_agents', agent_ids: [NOVA] });
    const outsider = await exec(NOVA, { op: 'remove_agents', agent_ids: [LEAD] });
    expect(outsider.success).toBe(false);
    expect(outsider.error).toMatch(/only remove agents from a thread you are in/);
    expect(await agentParticipants()).toEqual([LEAD]);
  });

  it('a run going on in the thread sees the tool’s add and remove on its next roster read', async () => {
    // What dispatch holds for a run that started with Lead and Nova.
    const roster = createLiveRoster({
      threadId: THREAD,
      ids: [LEAD, NOVA],
      names: new Map(),
      roles: new Map(),
    });

    expect((await exec(LEAD, { op: 'add_agents', agent_ids: [ORION] })).success).toBe(true);
    await roster.refreshIfChanged();
    expect([...roster.ids].sort()).toEqual([LEAD, NOVA, ORION].sort());
    expect(roster.resolve(ORION)).toBe(ORION);

    expect((await exec(NOVA, { op: 'leave' })).success).toBe(true);
    await roster.refreshIfChanged();
    expect([...roster.ids].sort()).toEqual([LEAD, ORION].sort());
    expect(roster.resolve(NOVA)).toBeUndefined();
  });

  it('an agent a person set up for the thread is refused, naming what is set', async () => {
    await ThreadParticipants.updateOverrides(THREAD, NOVA, {
      systemPromptAddendum: 'Only review pricing.',
    });
    await SkillAssignments.setMode(THREAD, NOVA, 'override');

    const refused = await exec(LEAD, { op: 'remove_agents', agent_ids: [NOVA] });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain(
      `${NOVA} has per-thread settings here (instructions, skills); a person removes them in the app`
    );
    expect(await agentParticipants()).toEqual([LEAD, NOVA].sort());
  });

  it('update refuses to add or remove agents, and changes nothing when asked to', async () => {
    for (const input of [
      { op: 'update', thread: { title: 'Renamed' }, agent_ids: [ORION] },
      { op: 'update', remove_agent_ids: [NOVA] },
    ]) {
      const refused = await exec(LEAD, input);
      expect(refused.success).toBe(false);
      expect(refused.error).toMatch(/op "add_agents".*op "remove_agents".*op "leave"/);
    }
    expect(await agentParticipants()).toEqual([LEAD, NOVA].sort());
    expect((await Threads.findById(THREAD))?.title).toBe('Pricing review');
  });

  it('an agent a person set up for the thread cannot leave on its own', async () => {
    await ThreadParticipants.updateModel(THREAD, NOVA, { disableModelFallback: true });
    await ThreadParticipants.updateOverrides(THREAD, NOVA, { maxDurationSeconds: 600 });

    const refused = await exec(NOVA, { op: 'leave' });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain(
      'You have per-thread settings here (model, limits); stay, a person removes you in the app'
    );
    expect(await agentParticipants()).toEqual([LEAD, NOVA].sort());
  });
});
