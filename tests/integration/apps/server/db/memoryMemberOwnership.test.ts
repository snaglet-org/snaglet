/**
 * User/member-owned memories against the real database, with no MemoryService
 * mocks: a user actor with no agent context (ToolValidation.resolveMemoryOwner
 * via getCurrentActor() → resolveCurrentActorMemberId()) can store, recall and
 * forget; recall never leaks between agent and member owners; forget by query
 * deletes only the caller's rows; the agent-run path (ctx.agentId) works with
 * no actor; and no actor at all throws "requires agent context".
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Agents, Members, Memories } from '@snaglet/db';
import { Users } from '@snaglet/db/tables/users';
import { runWithActor } from '@server/realtime/actorContext';
import memoryStoreTool from '@server/services/ToolService/handlers/memory/memoryStore';
import memoryRecallTool from '@server/services/ToolService/handlers/memory/memoryRecall';
import memoryForgetTool from '@server/services/ToolService/handlers/memory/memoryForget';

const PREFIX = 'mem-owner-test';
const AGENT_ID = `agent-${PREFIX}`;

let userId: string;

const asAgent = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithActor({ actorKind: 'agent', actorId: AGENT_ID }, fn);
const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithActor({ actorKind: 'user', actorId: userId }, fn);

describe('user/member-owned memories (real DB)', () => {
  beforeAll(async () => {
    await Agents.create({ id: AGENT_ID, name: `${PREFIX} agent` });
    const user = await Users.upsertUser({
      email: `${PREFIX}@test.local`,
      name: `${PREFIX} user`,
      authProvider: 'test',
      authProviderId: `${PREFIX}-auth`,
    });
    userId = user.id;
    // Users.upsertUser already calls Members.ensureForUser — confirm the
    // bridge fired, since the whole feature hinges on a real member row
    // existing for resolveCurrentActorMemberId to find.
    expect(await Members.findByUser(userId)).not.toBeNull();
  });

  afterAll(async () => {
    const pool = getDb();
    // Deleting the agent/user cascades their member row (members.agent_id /
    // members.user_id FKs), which in turn cascades their owned
    // memories (memories_member_id_fkey).
    await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
    await pool.query(`DELETE FROM public.users WHERE id = $1`, [userId]);
  });

  it('memory_store + memory_recall round-trip for a user actor with no agent context', async () => {
    const stored = await asUser(() =>
      memoryStoreTool(
        { key: 'fav-palette', content: 'The user likes teal-and-violet gradients.' },
        {},
        {}
      )
    );
    expect(stored).toContain('Memory stored');

    const recalled = await asUser(() =>
      memoryRecallTool({ query: 'teal-and-violet gradients' }, {}, {})
    );
    expect(recalled).toContain('teal-and-violet gradients');
  });

  it("memory_forget (by query) removes only the user's own memory", async () => {
    await asUser(() =>
      memoryStoreTool({ key: 'temp-note', content: 'Ephemeral zorkmid placeholder note.' }, {}, {})
    );
    const forgotten = await asUser(() =>
      memoryForgetTool({ query: 'zorkmid placeholder' }, {}, {})
    );
    expect(forgotten).toContain('Forgot 1 memory');

    const recalledAfter = await asUser(() =>
      memoryRecallTool({ query: 'zorkmid placeholder' }, {}, {})
    );
    expect(recalledAfter).not.toContain('zorkmid');
  });

  it('memory_forget by id hides cross-owner memories and lets each owner delete its own', async () => {
    await asUser(() =>
      memoryStoreTool({ key: 'member-id-delete', content: 'Member-owned delete target.' }, {}, {})
    );
    await memoryStoreTool(
      { key: 'agent-id-delete', content: 'Agent-owned delete target.' },
      {},
      { agentId: AGENT_ID }
    );

    const member = await Members.findByUser(userId);
    if (!member) throw new Error('Expected member created for test user');
    const memberMemory = await Memories.findByKey({ memberId: member.id }, 'member-id-delete');
    const agentMemory = await Memories.findByKey({ agentId: AGENT_ID }, 'agent-id-delete');
    if (!memberMemory || !agentMemory) throw new Error('Expected both test memories to exist');

    const nonexistentId = `memory-${PREFIX}-missing`;
    const agentMismatch = await memoryForgetTool(
      { memory_id: memberMemory.id },
      {},
      { agentId: AGENT_ID }
    );
    const memberMismatch = await asUser(() =>
      memoryForgetTool({ memory_id: agentMemory.id }, {}, {})
    );
    const nonexistent = await memoryForgetTool(
      { memory_id: nonexistentId },
      {},
      { agentId: AGENT_ID }
    );

    expect(agentMismatch).toBe(nonexistent);
    expect(memberMismatch).toBe(nonexistent);
    expect(nonexistent).toBe('Forgot 0 memory(ies).');
    expect(await Memories.findById(memberMemory.id)).not.toBeNull();
    expect(await Memories.findById(agentMemory.id)).not.toBeNull();

    await expect(
      asUser(() => memoryForgetTool({ memory_id: memberMemory.id }, {}, {}))
    ).resolves.toBe('Forgot 1 memory(ies).');
    await expect(
      memoryForgetTool({ memory_id: agentMemory.id }, {}, { agentId: AGENT_ID })
    ).resolves.toBe('Forgot 1 memory(ies).');
    expect(await Memories.findById(memberMemory.id)).toBeNull();
    expect(await Memories.findById(agentMemory.id)).toBeNull();
  });

  it('agent path: store + recall via ctx.agentId work with no actor', async () => {
    const stored = await memoryStoreTool(
      { key: 'agent-plan', content: 'Agent internal note about the quokka migration plan.' },
      {},
      { agentId: AGENT_ID }
    );
    expect(stored).toContain('Memory stored');

    const recalled = await memoryRecallTool(
      { query: 'quokka migration plan' },
      {},
      { agentId: AGENT_ID }
    );
    expect(recalled).toContain('quokka migration plan');
  });

  it("cross-ownership isolation: the agent's recall never surfaces the user's memory, and vice versa", async () => {
    // Deliberately overlapping keywords ("trivia secret") in both owners'
    // content — this is the real proof: if the SQL owner filter (agent_id /
    // member_id) were broken, the wrong owner's row would also match this
    // query text and leak into results.
    await asUser(() =>
      memoryStoreTool({ key: 'user-secret', content: 'User-only wombat trivia secret.' }, {}, {})
    );
    await asAgent(() =>
      memoryStoreTool(
        { key: 'agent-secret', content: 'Agent-only pangolin trivia secret.' },
        {},
        { agentId: AGENT_ID }
      )
    );

    const agentRecall = await memoryRecallTool(
      { query: 'trivia secret', limit: 10 },
      {},
      { agentId: AGENT_ID }
    );
    expect(agentRecall).toContain('pangolin');
    expect(agentRecall).not.toContain('wombat');

    const userRecall = await asUser(() =>
      memoryRecallTool({ query: 'trivia secret', limit: 10 }, {}, {})
    );
    expect(userRecall).toContain('wombat');
    expect(userRecall).not.toContain('pangolin');
  });

  it('throws the standard error when there is no actor at all (no agent context, no ambient actor)', async () => {
    await expect(memoryStoreTool({ key: 'k', content: 'c' }, {}, {})).rejects.toThrow(
      'memory (create) requires agent context'
    );
  });
});
