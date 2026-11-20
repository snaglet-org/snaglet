/**
 * Memories.hybridSearch `projectScope` (auto-recall project filter), against
 * the real database.
 *
 * A memory's project is derived: source_thread_id → nodes.project_id. With a
 * scope, a memory is a candidate only when it is agent-global (no source
 * thread, or source thread flat) or its source thread's project is in
 * `allowedProjectIds`. Without a scope the search is unscoped (explicit
 * memory-tool recall).
 *
 * Every arm (keyword-only, vector-only, hybrid) is executed so the extra
 * parameter placement is exercised in each SQL statement.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Agents, Containers, Memories, Threads, getDb } from '@snaglet/db';

const PREFIX = 'mem-project-scope-test';
const AGENT_ID = `agent-${PREFIX}`;

const PROJECT = 'container-3333333333333-memscope1';
const SUBPROJECT = 'container-3333333333333-memscope2';
const OTHER_PROJECT = 'container-3333333333333-memscope3';

const T_PROJECT = 'thread-3333333333333-memscopeA';
const T_SUB = 'thread-3333333333333-memscopeB';
const T_OTHER = 'thread-3333333333333-memscopeC';
const T_FLAT = 'thread-3333333333333-memscopeD';
const T_DELETED = 'thread-3333333333333-memscopeE';

const M = {
  project: `memory-${PREFIX}-project`,
  sub: `memory-${PREFIX}-sub`,
  other: `memory-${PREFIX}-other`,
  flat: `memory-${PREFIX}-flat`,
  global: `memory-${PREFIX}-global`,
};
// Source thread hard-deleted: memories_source_thread_id_fkey is ON DELETE
// CASCADE, so the memory goes with it, never an orphan.
const M_DELETED_SOURCE = `memory-${PREFIX}-deleted-source`;

// Shared keyword so every row matches the keyword arm.
const WORD = 'zephyrquokka';

async function ids(projectScope?: { allowedProjectIds: string[] }): Promise<string[]> {
  const rows = await Memories.hybridSearch(null, WORD, AGENT_ID, {
    limit: 20,
    ...(projectScope ? { projectScope } : {}),
  });
  return rows.map((r) => r.id).sort();
}

describe('Memories.hybridSearch projectScope (real DB)', () => {
  beforeAll(async () => {
    await Agents.create({ id: AGENT_ID, name: `${PREFIX} agent` });
    await Containers.create({ id: PROJECT, name: `${PREFIX} project`, category: 'project' });
    await Containers.create({
      id: SUBPROJECT,
      name: `${PREFIX} subproject`,
      category: 'project',
      parentId: PROJECT,
    });
    await Containers.create({ id: OTHER_PROJECT, name: `${PREFIX} other`, category: 'project' });

    await Threads.create({ id: T_PROJECT, title: 'p', projectId: PROJECT });
    await Threads.create({ id: T_SUB, title: 's', projectId: SUBPROJECT });
    await Threads.create({ id: T_OTHER, title: 'o', projectId: OTHER_PROJECT });
    await Threads.create({ id: T_FLAT, title: 'f' });
    await Threads.create({ id: T_DELETED, title: 'd', projectId: OTHER_PROJECT });

    const mk = (id: string, sourceThreadId: string | null) =>
      Memories.create({
        id,
        agentId: AGENT_ID,
        key: id,
        content: `${WORD} probe for ${id}`,
        sourceThreadId,
      });
    await mk(M.project, T_PROJECT);
    await mk(M.sub, T_SUB);
    await mk(M.other, T_OTHER);
    await mk(M.flat, T_FLAT);
    await mk(M.global, null);
    await mk(M_DELETED_SOURCE, T_DELETED);
    await getDb().query(`DELETE FROM public.nodes WHERE id = $1`, [T_DELETED]);
  });

  afterAll(async () => {
    const pool = getDb();
    await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
    await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
      [T_PROJECT, T_SUB, T_OTHER, T_FLAT, T_DELETED],
    ]);
    await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
      [SUBPROJECT, OTHER_PROJECT],
    ]);
    await pool.query(`DELETE FROM public.nodes WHERE id = $1`, [PROJECT]);
  });

  it('without a scope returns every memory (explicit recall unchanged)', async () => {
    expect(await ids()).toEqual(Object.values(M).sort());
  });

  it('deleting a source thread cascades its memories (no orphan-global case)', async () => {
    const { rows } = await getDb().query(`SELECT 1 FROM public.memories WHERE id = $1`, [
      M_DELETED_SOURCE,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('single project: own + global (no source / flat source); never another project', async () => {
    expect(await ids({ allowedProjectIds: [PROJECT] })).toEqual(
      [M.project, M.flat, M.global].sort()
    );
  });

  it('nested project family: parent + subproject both allowed', async () => {
    const family = [PROJECT, SUBPROJECT];
    expect(await ids({ allowedProjectIds: family })).toEqual(
      [M.project, M.sub, M.flat, M.global].sort()
    );
    // From the subproject's side the family is the same set; the other
    // project still never leaks in.
    expect(await ids({ allowedProjectIds: [SUBPROJECT, PROJECT] })).not.toContain(M.other);
  });

  it('a project named in the query can be allowed explicitly', async () => {
    expect(await ids({ allowedProjectIds: [PROJECT, OTHER_PROJECT] })).toContain(M.other);
  });

  it('empty allowed set = agent-global memories only', async () => {
    expect(await ids({ allowedProjectIds: [] })).toEqual([M.flat, M.global].sort());
  });

  it('vector-only and hybrid arms execute with the scope parameter', async () => {
    const vec = new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    // No embedding rows exist for these memories, so the vector arm returns
    // nothing; the point is that each SQL statement binds the scope param.
    await expect(
      Memories.hybridSearch(vec, '', AGENT_ID, { projectScope: { allowedProjectIds: [PROJECT] } })
    ).resolves.toEqual([]);
    const hybrid = await Memories.hybridSearch(vec, WORD, AGENT_ID, {
      limit: 20,
      projectScope: { allowedProjectIds: [PROJECT] },
    });
    expect(hybrid.map((r) => r.id)).not.toContain(M.other);
    expect(hybrid.map((r) => r.id)).toContain(M.project);
  });
});
