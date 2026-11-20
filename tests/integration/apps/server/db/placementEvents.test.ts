/**
 * placement_events history against the real database. The per-model moveTo()
 * is the single chokepoint: a container-changing move records one row
 * (from/to/moved_by); a reorder within the same container records nothing;
 * creation records nothing (creates are not moves).
 *
 * moved_by references members(id), so PlacementEventModel.record() ignores the
 * caller's `movedBy` argument (often a raw user/agent id) and resolves the
 * acting member itself via currentActorMemberId(). The tests drive that two
 * ways: a forced resolver (as in attribution.test.ts) and the real
 * agent->member mapping through an ambient actor context.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import {
  Agents,
  Containers,
  Docs,
  Members,
  PlacementEvents,
  setActorMemberResolver,
} from '@snaglet/db';
import { runWithActor } from '@server/realtime/actorContext';
import { resolveCurrentActorMemberId } from '@server/realtime/actorMember';

const PREFIX = 'placement-test';
const A = `${PREFIX}-a`;
const B = `${PREFIX}-b`;
const DOC = `doc-${PREFIX}-mover`;
const AGENT = `agent-${PREFIX}`;

async function cleanup() {
  const pool = getDb();
  await pool.query(
    `DELETE FROM public.placement_events WHERE node_id LIKE 'doc-${PREFIX}-%' OR node_id LIKE '${PREFIX}-%'`
  );
  await pool.query(`DELETE FROM public.docs WHERE id LIKE 'doc-${PREFIX}-%'`);
  await pool.query(
    `DELETE FROM public.nodes WHERE id LIKE 'doc-${PREFIX}-%' OR id LIKE '${PREFIX}-%'`
  );
  await pool.query(`DELETE FROM public.members WHERE agent_id = $1`, [AGENT]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT]);
}

describe('placement_events on container-changing moves', () => {
  let member: { id: string };

  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: A, name: `${PREFIX} A` });
    await Containers.create({ id: B, name: `${PREFIX} B` });
    await Agents.create({ id: AGENT, name: `${PREFIX} agent` });
    member = await Members.ensureForAgent(AGENT);
  });

  afterEach(() => {
    // Never leak a forced resolver into the next test (or another file).
    setActorMemberResolver(null);
  });

  afterAll(async () => {
    setActorMemberResolver(null);
    await cleanup();
  });

  it('creating a doc records no placement event (a create is not a move)', async () => {
    await Docs.create({ id: DOC, title: 'mover', containerId: A });
    expect(await PlacementEvents.listByNode(DOC)).toHaveLength(0);
  });

  it('a container-changing move records one row with the correct from/to and moved_by resolved from the acting member', async () => {
    // moved_by is FK → members(id), so the forced resolver must return a real
    // member id.
    setActorMemberResolver(async () => member.id);
    await Docs.moveTo(DOC, B);
    const events = await PlacementEvents.listByNode(DOC);
    expect(events).toHaveLength(1);
    expect(events[0].fromContainerId).toBe(A);
    expect(events[0].toContainerId).toBe(B);
    expect(events[0].movedBy).toBe(member.id);
  });

  it('a moveTo() caller-supplied movedBy argument is ignored', async () => {
    // No resolver registered → currentActorMemberId() resolves to null, even
    // though the call passes a non-null 4th argument: raw actor ids passed by
    // callers must never reach the FK column.
    await Docs.moveTo(DOC, A, undefined, 'raw-agent-id-not-a-member');
    const events = await PlacementEvents.listByNode(DOC);
    expect(events[0].movedBy).toBeNull();
  });

  it('a reorder within the same container records nothing', async () => {
    await Docs.moveTo(DOC, A, 0); // same container, just a position change
    expect(await PlacementEvents.listByNode(DOC)).toHaveLength(2); // unchanged by the reorder
  });

  it('moving back to root records another event (to = null); moved_by null when unattributed', async () => {
    await Docs.moveTo(DOC, null);
    const events = await PlacementEvents.listByNode(DOC);
    expect(events).toHaveLength(3);
    // newest-first ordering
    expect(events[0].fromContainerId).toBe(A);
    expect(events[0].toContainerId).toBeNull();
    expect(events[0].movedBy).toBeNull();
  });

  it('container moves are recorded too', async () => {
    // Move container B under A — a container-changing move of a container node.
    await Containers.moveTo(B, A);
    const events = await PlacementEvents.listByNode(B);
    expect(events).toHaveLength(1);
    expect(events[0].fromContainerId).toBeNull();
    expect(events[0].toContainerId).toBe(A);
  });

  it('a workspace_move by an agent actor records moved_by = that agent members.id, not the raw agent id', async () => {
    // Wire the real actor->member seam (not a forced resolver) so this
    // exercises the end-to-end mapping the ID-space hazard is about.
    setActorMemberResolver(resolveCurrentActorMemberId);

    // DOC is currently at root (from the prior test); move it into B (nested
    // under A by the previous test — irrelevant to a doc move, no cycle risk).
    await runWithActor({ actorKind: 'agent', actorId: AGENT }, () => Docs.moveTo(DOC, B));

    const events = await PlacementEvents.listByNode(DOC);
    expect(events[0].fromContainerId).toBeNull();
    expect(events[0].toContainerId).toBe(B);
    expect(events[0].movedBy).toBe(member.id);
    expect(events[0].movedBy).not.toBe(AGENT);
  });

  it('the moved_by FK rejects a stamp that is not a real members.id', async () => {
    setActorMemberResolver(async () => 'member-does-not-exist');
    // DOC is currently in B (from the prior test); B → A is a container-changing
    // move, so record() attempts the (rejected) insert.
    await expect(Docs.moveTo(DOC, A)).rejects.toThrow();
  });
});
