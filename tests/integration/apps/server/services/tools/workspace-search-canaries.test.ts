/**
 * workspace_search canaries — smoke alarms for the agent-search behaviors that
 * must hold on the node model. Seeded fixtures against the real test database
 * (ordinary tests, no snapshot/eval infrastructure).
 *
 * onnxruntime-node is stubbed in jest, so neither the local embedder (vector)
 * nor the cross-encoder (rerank/floor) run here: these canaries exercise the
 * lexical (FTS) and fuzzy (pg_trgm) channels.
 * The cross-encoder quality floor is covered as a unit test in
 * committedSearch.test.ts (mocked reranker), since it cannot run under the ort
 * stub.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import { Memories } from '@snaglet/db/tables/memories';
import { Threads } from '@snaglet/db/tables/threads';
import { fuzzyTitleCandidates } from '@server/services/search/ftsSearchNodes';
import searchTool from '@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch';

const RUN = Date.now();
async function call(input: Record<string, unknown>): Promise<string> {
  const out = await (
    searchTool as unknown as (i: unknown, s: unknown, c: unknown) => Promise<unknown>
  )(input, {}, {});
  return typeof out === 'string' ? out : JSON.stringify(out);
}

async function ageNode(id: string, days: number): Promise<void> {
  await getDb().query(
    `UPDATE public.nodes SET updated_at = now() - ($2 || ' days')::interval WHERE id = $1`,
    [id, String(days)]
  );
}

// Ids seeded once, cleaned up at the end.
const created: string[] = [];
let planDocId = '';
let threadId = '';
let archivedDocId = '';
let liveDocId = '';
let agentId = '';
let memoryId = '';
let projectId = '';
let taskAId = '';
let taskBId = '';
let refDocId = '';
let plainDocId = '';

describe('workspace_search canaries (seeded, real DB)', () => {
  beforeAll(async () => {
    // 1 — plan doc findable
    const home = await Containers.create({ name: `Canary Home ${RUN}` });
    created.push(home.id);
    const plan = await Docs.create({
      title: `Zorptastic rollout plan ${RUN}`,
      content: `The zorptastic rollout plan: sequencing and rollback for zorptastic.`,
      containerId: home.id,
    });
    planDocId = plan.id;

    // 2 — thread findable by (title) meaning
    // Thread search matches title by substring ILIKE on the whole query, so the
    // term + RUN must be contiguous in the title. Threads are not placed in
    // folders; a flat thread is the plain case.
    const thread = await Threads.create({
      id: `thread-canary-${RUN}`,
      title: `Zorptastic ${RUN} planning discussion`,
    });
    threadId = thread.id;

    // 3 — archived never surfaces without include_archived
    const arch = await Docs.create({
      title: `Florble archived note ${RUN}`,
      content: `florble notes that were shipped and archived.`,
      containerId: home.id,
    });
    archivedDocId = arch.id;
    await getDb().query(
      `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
      [archivedDocId]
    );
    const live = await Docs.create({
      title: `Florble live note ${RUN}`,
      content: `florble notes that are still live.`,
      containerId: home.id,
    });
    liveDocId = live.id;

    // 4 — typo'd memory key still recalls (fuzzy / pg_trgm)
    const agent = await Agents.create({ id: `agent-canary-${RUN}`, name: `Canary Agent ${RUN}` });
    agentId = agent.id;
    const mem = await Memories.create({
      id: `memory-canary-${RUN}`,
      agentId,
      key: `quibblesnort_config_${RUN}`,
      content: 'The quibblesnort config controls the widget.',
    });
    memoryId = mem.id;

    // 5 — two docs with identical content in sibling plain folders under a
    // project both surface. A folder confers no lifecycle, so nothing about
    // placement ranks one doc ahead of the other.
    const project = await Containers.create({ name: `Canary Project ${RUN}`, category: 'project' });
    projectId = project.id;
    const folderA = await Containers.create({ name: `Folder A ${RUN}`, parentId: project.id });
    const folderB = await Containers.create({ name: `Folder B ${RUN}`, parentId: project.id });
    created.push(project.id, folderA.id, folderB.id);
    const taskContent = `Track the wamplico deliverable — work item.`;
    const taskA = await Docs.create({
      title: `Wamplico task A ${RUN}`,
      content: taskContent,
      containerId: folderA.id,
    });
    const taskB = await Docs.create({
      title: `Wamplico task B ${RUN}`,
      content: taskContent,
      containerId: folderB.id,
    });
    taskAId = taskA.id;
    taskBId = taskB.id;

    // 6 — no container exempts its docs from ordinary freshness: both
    //     containers below are plain and neither protects its contents from
    //     staleness.
    const refCont = await Containers.create({ name: `Canary Former Reference ${RUN}` });
    const plainCont = await Containers.create({ name: `Canary Plain ${RUN}` });
    created.push(refCont.id, plainCont.id);
    const refDoc = await Docs.create({
      title: `Grindlewax reference ${RUN}`,
      content: `grindlewax canonical reference material.`,
      containerId: refCont.id,
    });
    const plainDoc = await Docs.create({
      title: `Grindlewax plain ${RUN}`,
      content: `grindlewax canonical reference material.`,
      containerId: plainCont.id,
    });
    refDocId = refDoc.id;
    plainDocId = plainDoc.id;
    // Both equally old (well past the possibly-stale threshold), so both get
    // the same stale treatment.
    await ageNode(refDocId, 300);
    await ageNode(plainDocId, 300);

    created.push(
      planDocId,
      threadId,
      archivedDocId,
      liveDocId,
      taskAId,
      taskBId,
      refDocId,
      plainDocId
    );
  });

  afterAll(async () => {
    const pool = getDb();
    for (const id of created) {
      await pool
        .query(`DELETE FROM public.nodes WHERE id = $1 OR container_id = $1`, [id])
        .catch((err: unknown) => console.warn('db cleanup failed:', err));
    }
    if (memoryId)
      await pool
        .query(`DELETE FROM public.nodes WHERE id = $1`, [memoryId])
        .catch((err: unknown) => console.warn('db cleanup failed:', err));
    if (agentId)
      await pool
        .query(`DELETE FROM public.agents WHERE id = $1`, [agentId])
        .catch((err: unknown) => console.warn('db cleanup failed:', err));
  });

  it('1 — a plan doc is findable', async () => {
    const out = await call({ query: `zorptastic ${RUN}` });
    expect(out).toContain(planDocId);
  });

  it('2 — a thread is findable through the keyword lane', async () => {
    // Threads are a navigation kind, not a content kind: they carry an authored
    // title and no body, so they advertise no semantic lane
    // (SEMANTIC_SEARCH_KINDS) and are absent from the default hybrid pool.
    // Structural thread lookup runs through keyword search over that title.
    const hybrid = await call({ query: `zorptastic ${RUN}` });
    expect(hybrid).not.toContain(threadId);

    const out = await call({ query: `zorptastic ${RUN}`, mode: 'keyword' });
    expect(out).toContain(threadId);
  });

  it('3 — an archived node never surfaces without include_archived, and does with it', async () => {
    const def = await call({ query: `florble ${RUN}` });
    expect(def).toContain(liveDocId);
    expect(def).not.toContain(archivedDocId);

    const dig = await call({ query: `florble ${RUN}`, include_archived: true });
    expect(dig).toContain(archivedDocId);
    // The label's `]` is markdown-escaped inside the link text (`[ARCHIVED\]`).
    expect(dig).toContain('[ARCHIVED');
  });

  it("4 — a typo'd memory key still recalls (fuzzy)", async () => {
    const hits = await fuzzyTitleCandidates({
      query: `quibblesnrt config ${RUN}`, // transposed/typo'd
      kinds: ['memory'],
      limit: 10,
      allowedContainerIds: null,
    });
    expect(hits.map((h) => h.id)).toContain(memoryId);
  });

  it('5 — identical docs in sibling folders under a project both surface', async () => {
    const out = await call({ query: `wamplico ${RUN}` });
    expect(out).toContain(taskAId);
    expect(out).toContain(taskBId);
    // No ordering assertion: a folder carries no lifecycle, so placement gives
    // nothing to rank by.
  });

  it('6 — no container annotation exempts a doc from freshness', async () => {
    const out = await call({ query: `grindlewax ${RUN}` });
    // Both docs surface; neither container confers a freshness advantage, so
    // no ranking order is asserted.
    expect(out).toContain(refDocId);
    expect(out).toContain(plainDocId);
  });
});
