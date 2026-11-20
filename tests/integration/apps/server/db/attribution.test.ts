/**
 * Attribution stamps (created_by / last_edited_by) for docs and containers,
 * against the real database. Create stamps created_by; a content or title edit
 * stamps last_edited_by; metadata-only edits, layout updates and moves do not.
 * Both columns reference members(id), so the ambient actor (an agent or user
 * id) must resolve to its members.id: the tests drive the injected resolver
 * (setActorMemberResolver), exercise the real one (resolveCurrentActorMemberId),
 * and check the FK rejects a stamp that is not a real member.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Agents, Members, Docs, Containers, setActorMemberResolver } from '@snaglet/db';
import { runWithActor } from '@server/realtime/actorContext';
import { resolveCurrentActorMemberId } from '@server/realtime/actorMember';

const PREFIX = 'attr-test';
const AGENT_A = `agent-${PREFIX}-a`;
const AGENT_B = `agent-${PREFIX}-b`;

let memberA: string;
let memberB: string;

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.docs WHERE id LIKE 'doc-${PREFIX}-%'`);
  await pool.query(`DELETE FROM public.containers WHERE id LIKE '${PREFIX}-%'`);
  await pool.query(
    `DELETE FROM public.nodes WHERE id LIKE 'doc-${PREFIX}-%' OR id LIKE '${PREFIX}-%'`
  );
  await pool.query(`DELETE FROM public.members WHERE agent_id IN ($1, $2)`, [AGENT_A, AGENT_B]);
  await pool.query(`DELETE FROM public.agents WHERE id IN ($1, $2)`, [AGENT_A, AGENT_B]);
}

describe('doc + container attribution stamps', () => {
  beforeAll(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_A, name: `${PREFIX} Agent A` });
    await Agents.create({ id: AGENT_B, name: `${PREFIX} Agent B` });
    memberA = (await Members.ensureForAgent(AGENT_A)).id;
    memberB = (await Members.ensureForAgent(AGENT_B)).id;
  });

  afterEach(() => {
    // Never leak a forced resolver into the next test (or another file).
    setActorMemberResolver(null);
  });

  afterAll(async () => {
    setActorMemberResolver(null);
    await cleanup();
  });

  // docs
  it('doc create stamps created_by from the resolved actor; last_edited_by null', async () => {
    setActorMemberResolver(async () => memberA);
    const doc = await Docs.create({ id: `doc-${PREFIX}-1`, title: 't', content: 'c' });
    expect(doc.createdBy).toBe(memberA);
    expect(doc.lastEditedBy).toBeNull();
  });

  it('a content edit stamps last_edited_by; created_by unchanged', async () => {
    setActorMemberResolver(async () => memberA);
    const doc = await Docs.create({ id: `doc-${PREFIX}-2`, title: 't', content: 'c' });
    setActorMemberResolver(async () => memberB);
    const edited = await Docs.update(doc.id, { content: 'c2' });
    expect(edited?.createdBy).toBe(memberA);
    expect(edited?.lastEditedBy).toBe(memberB);
  });

  it('a title edit stamps last_edited_by', async () => {
    setActorMemberResolver(async () => memberB);
    const doc = await Docs.create({ id: `doc-${PREFIX}-3`, title: 't', content: 'c' });
    const edited = await Docs.update(doc.id, { title: 't2' });
    expect(edited?.lastEditedBy).toBe(memberB);
  });

  it('a metadata-only edit does not stamp last_edited_by', async () => {
    setActorMemberResolver(async () => memberA);
    const doc = await Docs.create({ id: `doc-${PREFIX}-4`, title: 't', content: 'c' });
    const edited = await Docs.update(doc.id, { priority: 'high' });
    expect(edited?.lastEditedBy).toBeNull();
  });

  it('a doc move does not stamp last_edited_by', async () => {
    setActorMemberResolver(async () => memberA);
    const container = await Containers.create({ id: `${PREFIX}-move-c`, name: 'c' });
    const doc = await Docs.create({ id: `doc-${PREFIX}-5`, title: 't', content: 'c' });
    setActorMemberResolver(async () => memberB);
    const moved = await Docs.moveTo(doc.id, container.id);
    expect(moved?.lastEditedBy).toBeNull();
  });

  // containers
  it('container create stamps created_by; last_edited_by null', async () => {
    setActorMemberResolver(async () => memberA);
    const c = await Containers.create({ id: `${PREFIX}-c1`, name: 'c' });
    expect(c.createdBy).toBe(memberA);
    expect(c.lastEditedBy).toBeNull();
  });

  it('a container rename stamps last_edited_by on every edit', async () => {
    setActorMemberResolver(async () => memberA);
    const c = await Containers.create({ id: `${PREFIX}-c2`, name: 'c' });
    setActorMemberResolver(async () => memberB);
    const renamed = await Containers.update(c.id, { name: 'c-renamed' });
    expect(renamed?.createdBy).toBe(memberA);
    expect(renamed?.lastEditedBy).toBe(memberB);
    // A second content edit re-stamps with the new ambient actor.
    setActorMemberResolver(async () => memberA);
    const renamedAgain = await Containers.update(c.id, { name: 'c-renamed-again' });
    expect(renamedAgain?.lastEditedBy).toBe(memberA);
  });

  it('a container description edit stamps last_edited_by', async () => {
    setActorMemberResolver(async () => memberA);
    const c = await Containers.create({ id: `${PREFIX}-c2b`, name: 'c' });
    setActorMemberResolver(async () => memberB);
    const described = await Containers.update(c.id, { description: 'what this container is for' });
    expect(described?.createdBy).toBe(memberA);
    expect(described?.lastEditedBy).toBe(memberB);
    expect(described?.description).toBe('what this container is for');
  });

  it('a container x/y layout-only update does not stamp last_edited_by', async () => {
    setActorMemberResolver(async () => memberA);
    const c = await Containers.create({ id: `${PREFIX}-c3`, name: 'c' });
    const moved = await Containers.update(c.id, { x: 5, y: 6 });
    expect(moved?.lastEditedBy).toBeNull();
  });

  it('a container move does not stamp last_edited_by', async () => {
    setActorMemberResolver(async () => memberA);
    const parent = await Containers.create({ id: `${PREFIX}-c4p`, name: 'p' });
    const child = await Containers.create({ id: `${PREFIX}-c4c`, name: 'c' });
    setActorMemberResolver(async () => memberB);
    const moved = await Containers.moveTo(child.id, parent.id);
    expect(moved?.lastEditedBy).toBeNull();
  });

  // actor → member resolution (the ID-space hazard)
  it('resolves an agent actor to its members.id (not the raw agent id)', async () => {
    const resolved = await runWithActor({ actorKind: 'agent', actorId: AGENT_A }, () =>
      resolveCurrentActorMemberId()
    );
    expect(resolved).toBe(memberA);
    expect(resolved).not.toBe(AGENT_A);
  });

  it('resolves to null for an unbound (system) actor', async () => {
    expect(await resolveCurrentActorMemberId()).toBeNull();
  });

  // FK enforcement
  it('rejects a stamp that is not a real members.id (FK → members)', async () => {
    setActorMemberResolver(async () => 'member-does-not-exist');
    await expect(
      Docs.create({ id: `doc-${PREFIX}-fk`, title: 't', content: 'c' })
    ).rejects.toThrow();
  });
});
