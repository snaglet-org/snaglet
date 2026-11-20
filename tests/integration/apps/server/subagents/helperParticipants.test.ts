/**
 * A retired subagent helper leaves no thread_participants row behind, against
 * the real database with dispatch stubbed (no model calls):
 *
 * - retiring a helper that was also a participant in another thread removes
 *   that row (same transaction as its thread delete);
 * - the idle sweep's orphan path does the same for a helper whose row is gone;
 * - the boot cleanup removes rows left by already-retired helpers, and
 *   leaves a live helper's and any regular agent's rows (archived or not)
 *   alone; it is idempotent and runs in boot recovery.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

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

import { Agents, Threads, ThreadParticipants, getDb } from '@snaglet/db';
import { Subagents, type SubagentRow } from '@snaglet/db/tables/subagents';
import { subagentService } from '@server/services/subagents/SubagentService';
import { threadRosterVersion } from '@server/services/SocketService/dispatch/rosterVersion';

const ORCH = 'test-agent-a';
const REGULAR = 'test-agent-b';
const ARCHIVED = 'test-agent-c';
const PARENT = 'thread-1111111111111-parentaaa';
const OTHER = 'thread-1111111111111-otheraaaa';

let fastModel = '';
let helperCount = 0;

function startHelper(name: string): Promise<SubagentRow> {
  helperCount += 1;
  return subagentService.start({
    orchestratorAgentId: ORCH,
    parentThreadId: PARENT,
    name: `${name} ${helperCount}`,
    model: fastModel,
    brief: `Brief for ${name}.`,
  });
}

/** Agent ids listed as participants of a thread. */
async function participantsOf(threadId: string): Promise<string[]> {
  return (await ThreadParticipants.listByThread(threadId)).map((p) => p.agentId ?? '').sort();
}

/** A retired helper whose participant row was left behind: archived, row deleted, still listed in OTHER. */
async function leftoverHelper(name: string): Promise<SubagentRow> {
  const sub = await startHelper(name);
  expect(await subagentService.retire(sub, 'done')).toBe(true);
  await ThreadParticipants.addParticipant({ threadId: OTHER, agentId: sub.agentId });
  return sub;
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
  const providerId = rows[0]!.provider_id;
  const [fast, strong] = rows[0]!.model_ids as [string, string];
  fastModel = fast;

  for (const [id, name] of [
    [ORCH, 'Test Agent A'],
    [REGULAR, 'Test Agent B'],
    [ARCHIVED, 'Test Agent C'],
  ] as const) {
    await Agents.create({ id, name, providerId, modelId: strong });
  }
  await Threads.create({ id: PARENT, title: 'Parent' });
  await Threads.create({ id: OTHER, title: 'Other' });
  await ThreadParticipants.addParticipant({ threadId: PARENT, agentId: ORCH });
  await ThreadParticipants.addParticipant({ threadId: OTHER, agentId: REGULAR });
  // A regular agent archived while still in a thread keeps its row: that may be intended.
  await ThreadParticipants.addParticipant({ threadId: OTHER, agentId: ARCHIVED });
  await Agents.archive(ARCHIVED);
  subagentService.init({ recoverAfterRestart: false });
});

afterAll(() => {
  subagentService.shutdown();
});

describe('a retired helper leaves no participant rows (real DB)', () => {
  it('retire removes the helper from another thread it was a participant in', async () => {
    const scout = await startHelper('Scout');
    await ThreadParticipants.addParticipant({ threadId: OTHER, agentId: scout.agentId });
    expect(await participantsOf(OTHER)).toContain(scout.agentId);
    const versionBefore = threadRosterVersion(OTHER);

    expect(await subagentService.retire(scout, 'removed')).toBe(true);

    // A run going on in OTHER re-reads its roster and stops routing to it.
    expect(threadRosterVersion(OTHER)).toBeGreaterThan(versionBefore);

    expect(await ThreadParticipants.listByAgent(scout.agentId)).toEqual([]);
    expect(await participantsOf(OTHER)).toEqual([REGULAR, ARCHIVED]);
    expect(await participantsOf(PARENT)).toEqual([ORCH]);
    expect((await Agents.findById(scout.agentId))!.archived).toBe(true);
  });

  it('the sweep takes an orphaned helper out of other threads as it archives it', async () => {
    const orphan = await startHelper('Orphan');
    await ThreadParticipants.addParticipant({ threadId: OTHER, agentId: orphan.agentId });
    // Its row went with a deleted parent thread; the agent is still live.
    await getDb().query(`DELETE FROM public.subagents WHERE id = $1`, [orphan.id]);
    const versionBefore = threadRosterVersion(OTHER);

    await subagentService.sweep();

    expect(threadRosterVersion(OTHER)).toBeGreaterThan(versionBefore);

    expect(await ThreadParticipants.listByAgent(orphan.agentId)).toEqual([]);
    expect((await Agents.findById(orphan.agentId))!.archived).toBe(true);
    expect(await participantsOf(OTHER)).toEqual([REGULAR, ARCHIVED]);
  });

  it('the boot cleanup removes leftover helper rows only, and is idempotent', async () => {
    const reader = await leftoverHelper('Reader');
    const keeper = await startHelper('Keeper');
    await ThreadParticipants.addParticipant({ threadId: OTHER, agentId: keeper.agentId });
    expect(await participantsOf(OTHER)).toEqual(
      [REGULAR, ARCHIVED, reader.agentId, keeper.agentId].sort()
    );

    expect(await subagentService.removeRetiredHelperParticipants()).toBe(1);

    // The live helper and both regular agents (one archived) keep their rows.
    expect(await participantsOf(OTHER)).toEqual([REGULAR, ARCHIVED, keeper.agentId].sort());
    expect(await participantsOf(PARENT)).toEqual([ORCH]);
    expect(await subagentService.removeRetiredHelperParticipants()).toBe(0);
    expect(await participantsOf(OTHER)).toEqual([REGULAR, ARCHIVED, keeper.agentId].sort());

    expect(await subagentService.retire((await Subagents.findById(keeper.id))!, 'removed')).toBe(
      true
    );
    expect(await participantsOf(OTHER)).toEqual([REGULAR, ARCHIVED]);
  });

  it('boot recovery runs the cleanup', async () => {
    const left = await leftoverHelper('Writer');
    expect(await participantsOf(OTHER)).toContain(left.agentId);

    await subagentService.recoverAfterRestart();

    expect(await participantsOf(OTHER)).toEqual([REGULAR, ARCHIVED]);
  });
});
