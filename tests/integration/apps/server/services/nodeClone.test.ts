/**
 * The workspace node-clone service (copy/paste) against the real database:
 * doc, container (recursive, with node-reference remap), project and thread
 * (config only, no messages) clones, rollback of a mid-write failure, and the
 * node cap.
 *
 * Every seed id and paste target starts with `clone-test`, so one prefix
 * delete (cascading through nodes.container_id and nodes.project_id) removes
 * seeds and clones.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { getDb, Containers, Docs, Threads, ThreadParticipants, Messages, Users } from '@snaglet/db';
import { cloneNode, MAX_CLONE_NODES } from '@server/domains/clone/NodeCloneService';

const PREFIX = 'clone-test';

async function cleanup(): Promise<void> {
  // Cascades to every descendant clone via nodes.container_id ON DELETE CASCADE.
  await getDb().query(`DELETE FROM public.nodes WHERE id LIKE '${PREFIX}%'`);
}

beforeAll(cleanup);
afterEach(() => {
  jest.restoreAllMocks();
});

describe('cloneNode — doc', () => {
  const C = `${PREFIX}-doc-c`;

  // Inside the describe so it runs before the shared closeDatabase() teardown; getDbClient() throws after close.
  afterAll(cleanup);

  beforeAll(async () => {
    await Containers.create({ id: C, name: 'Doc Container' });
    await Docs.create({
      id: `${PREFIX}-doc-src`,
      title: 'Note',
      content: 'hello body',
      containerId: C,
    });
  });

  it('copies content verbatim, appends a (n) collision suffix, and appends sort_order', async () => {
    const first = await cloneNode({ sourceId: `${PREFIX}-doc-src`, targetContainerId: C });
    const firstDoc = await Docs.findById(first.root.id);
    expect(firstDoc).not.toBeNull();
    expect(firstDoc!.title).toBe('Note (1)');
    expect(firstDoc!.content).toBe('hello body');
    expect(firstDoc!.containerId).toBe(C);
    // Source landed at sort_order 1; the copy appends at MAX+1.
    expect(firstDoc!.sortOrder).toBe(2);
    expect(first.count).toBe(1);

    // A second paste sees both "Note" and "Note (1)" and lands on "(2)".
    const second = await cloneNode({ sourceId: `${PREFIX}-doc-src`, targetContainerId: C });
    const secondDoc = await Docs.findById(second.root.id);
    expect(secondDoc!.title).toBe('Note (2)');
    expect(secondDoc!.sortOrder).toBe(3);
  });
});

describe('cloneNode — container (recursive) + node-reference remap', () => {
  const GRP = `${PREFIX}-grp`;
  const EXT = `${PREFIX}-ext`;
  const SUB = `${PREFIX}-sub`;
  const NESTED = `${PREFIX}-nested`;
  const A = `${PREFIX}-doc-a`;
  const B = `${PREFIX}-doc-b`;
  const X = `${PREFIX}-doc-x`;

  // Nested for the same reason as the describe above.
  afterAll(cleanup);

  beforeAll(async () => {
    await Containers.create({ id: GRP, name: 'Group' });
    await Containers.create({ id: EXT, name: 'External' });
    // X lives outside the copied subtree.
    await Docs.create({ id: X, title: 'External Doc', content: 'ext', containerId: EXT });

    // Subtree to copy: SUB > { A, B, NESTED }. A references B (in-subtree, two
    // grammars) and X (out-of-subtree).
    await Containers.create({ id: SUB, name: 'Sub', parentId: GRP });
    await Containers.create({ id: NESTED, name: 'Nested', parentId: SUB, sortOrder: 7 });
    await Docs.create({ id: B, title: 'Bee', content: 'bee body', containerId: SUB });
    await Docs.create({
      id: A,
      title: 'Ay',
      content: `chip [Bee](${B}) and embed ![](${B}); bare ${B}. external [X](${X}) and bare ${X}.`,
      containerId: SUB,
    });
  });

  it('clones the whole subtree, preserves nesting/sort_order, and remaps only in-subtree refs', async () => {
    const result = await cloneNode({ sourceId: SUB, targetContainerId: GRP });
    // SUB + NESTED + A + B = 4 nodes.
    expect(result.count).toBe(4);

    const subClone = await Containers.findById(result.root.id);
    expect(subClone!.name).toBe('Sub (1)'); // collides with the original in GRP
    expect(subClone!.parentId).toBe(GRP);

    // Children of the cloned SUB.
    const childContainers = await Containers.listByParent(subClone!.id);
    const childDocs = await Docs.listByContainer(subClone!.id);
    const nestedClone = childContainers.find((c) => c.name === 'Nested');
    const aClone = childDocs.find((d) => d.title === 'Ay');
    const bClone = childDocs.find((d) => d.title === 'Bee');
    expect(nestedClone).toBeDefined();
    expect(aClone).toBeDefined();
    expect(bClone).toBeDefined();

    // Nested container keeps its original sort_order (7).
    expect(nestedClone!.sortOrder).toBe(7);

    // Fresh ids — not the originals.
    expect(aClone!.id).not.toBe(A);
    expect(bClone!.id).not.toBe(B);

    // In-subtree ref (B) re-points to the clone in both grammars + bare form;
    // the original B id is absent from the cloned content.
    expect(aClone!.content).toContain(`[Bee](${bClone!.id})`);
    expect(aClone!.content).toContain(`![](${bClone!.id})`);
    expect(aClone!.content).toContain(`bare ${bClone!.id}.`);
    expect(aClone!.content).not.toContain(B);

    // Out-of-subtree ref (X) is untouched.
    expect(aClone!.content).toContain(`[X](${X})`);
    expect(aClone!.content).toContain(`bare ${X}`);
  });
});

describe('cloneNode — thread (config-only)', () => {
  const TC = `${PREFIX}-thread-c`;
  const PLAIN = `${PREFIX}-thread-plain`;
  const SRC = `${PREFIX}-thread-src`;

  // Nested for the same reason as the describes above.
  afterAll(cleanup);

  beforeAll(async () => {
    await Containers.create({ id: TC, name: 'Thread Project', category: 'project' });
    await Containers.create({ id: PLAIN, name: 'Plain folder' });
    await Threads.create({
      id: SRC,
      title: 'Standup',
      projectId: TC,
      dispatchMode: 'mentioned',
      threadSystemPrompt: 'be brief',
    });
    // A user participant with per-participant overrides (no agent FK needed).
    const user = await Users.getOrCreateLocalUser();
    const participant = await ThreadParticipants.addUserParticipant({
      threadId: SRC,
      userId: String(user.id),
    });
    await getDb().query(
      `UPDATE public.thread_participants
          SET system_prompt_addendum = $2, tool_access_mode = 'deny_list'
        WHERE id = $1`,
      [participant.id, 'stay on topic']
    );
    // Seed a message to prove history is not carried over.
    await Messages.create({
      threadId: SRC,
      role: 'user',
      userId: String(user.id),
      content: 'history that should NOT clone',
    });
  });

  it('clones config + participants but no messages', async () => {
    const srcMsgs = await getDb().query(
      `SELECT count(*)::int AS n FROM public.messages WHERE thread_id = $1`,
      [SRC]
    );
    expect(srcMsgs.rows[0].n).toBe(1);

    // No target: the copy keeps the source's project.
    const result = await cloneNode({ sourceId: SRC });
    const clone = await Threads.findById(result.root.id);
    expect(clone).not.toBeNull();
    expect(clone!.title).toBe('Standup (1)');
    expect(clone!.dispatchMode).toBe('mentioned');
    expect(clone!.threadSystemPrompt).toBe('be brief');
    expect(clone!.projectId).toBe(TC);
    expect(result.root.parentId).toBe(TC);
    // A copy is a new thread: it starts at the top of the project's list.
    expect(clone!.sortOrder).toBe(0);
    expect(result.root.sortKey).toBe('0');
    expect((await Threads.listByProject(TC)).map((thread) => thread.id)).toEqual([clone!.id, SRC]);
    const { rows: spine } = await getDb().query<{ container_id: string | null }>(
      `SELECT container_id FROM public.nodes WHERE id = $1`,
      [clone!.id]
    );
    expect(spine[0]?.container_id).toBeNull();

    // Participant (member) + overrides carried over.
    const participants = await ThreadParticipants.listByThread(clone!.id);
    expect(participants).toHaveLength(1);
    expect(participants[0].systemPromptAddendum).toBe('stay on topic');
    expect(participants[0].toolAccessMode).toBe('deny_list');

    // History is not cloned.
    const cloneMsgs = await getDb().query(
      `SELECT count(*)::int AS n FROM public.messages WHERE thread_id = $1`,
      [result.root.id]
    );
    expect(cloneMsgs.rows[0].n).toBe(0);
  });

  it('pastes flat with a null target and refuses a non-project target', async () => {
    const flat = await cloneNode({ sourceId: SRC, targetContainerId: null });
    expect((await Threads.findById(flat.root.id))!.projectId).toBeNull();

    await expect(cloneNode({ sourceId: SRC, targetContainerId: PLAIN })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/not a project/),
    });
    expect(await Threads.listByProject(PLAIN)).toEqual([]);
  });
});

describe('cloneNode — DM thread', () => {
  const DM = `${PREFIX}-dm-src`;

  afterAll(cleanup);

  beforeAll(async () => {
    await Threads.create({
      id: DM,
      title: 'Test Agent A ↔ Test User',
      kind: 'dm',
      dmPairKey: `${PREFIX}-member-a:${PREFIX}-member-b`,
    });
  });

  it('refuses to copy a DM thread and writes nothing', async () => {
    const before = await getDb().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.threads`
    );
    await expect(cloneNode({ sourceId: DM, targetContainerId: null })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/direct message/i),
    });
    const after = await getDb().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.threads`
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('cloneNode — project (threads come along)', () => {
  const PARENT = `${PREFIX}-proj-parent`;
  const PROJ = `${PREFIX}-proj`;
  const THREAD = `${PREFIX}-proj-thread`;
  const DOC = `${PREFIX}-proj-doc`;

  // Nested for the same reason as the describes above.
  afterAll(cleanup);

  beforeAll(async () => {
    await Containers.create({ id: PARENT, name: 'Project Parent' });
    await Containers.create({ id: PROJ, name: 'Proj', parentId: PARENT, category: 'project' });
    await Docs.create({ id: DOC, title: 'Brief', content: 'body', containerId: PROJ });
    await Threads.create({ id: THREAD, title: 'Kickoff', projectId: PROJ });
  });

  it('clones the project as a project and scopes the cloned threads to the clone', async () => {
    const result = await cloneNode({ sourceId: PROJ, targetContainerId: PARENT });
    // PROJ + DOC + THREAD = 3 nodes.
    expect(result.count).toBe(3);

    const projClone = await Containers.findById(result.root.id);
    expect(projClone!.category).toBe('project');
    expect(projClone!.name).toBe('Proj (1)');

    const threads = await Threads.listByProject(projClone!.id);
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe('Kickoff');
    expect(threads[0].id).not.toBe(THREAD);
    // The original keeps its own thread.
    expect((await Threads.findById(THREAD))!.projectId).toBe(PROJ);
  });
});

describe('cloneNode — transaction rollback', () => {
  const RC = `${PREFIX}-rollback-c`;
  const SRC = `${PREFIX}-rollback-src`;

  // Nested for the same reason as the describes above.
  afterAll(cleanup);

  beforeAll(async () => {
    await Containers.create({ id: RC, name: 'Rollback Project', category: 'project' });
    await Threads.create({ id: SRC, title: 'Boom', projectId: RC });
    const user = await Users.getOrCreateLocalUser();
    await ThreadParticipants.addUserParticipant({ threadId: SRC, userId: String(user.id) });
  });

  it('rolls back every write when a row fails mid-transaction', async () => {
    const real = await ThreadParticipants.listByThread(SRC);
    // Poison the participant with a non-existent member so the participant
    // INSERT trips its FK mid-transaction (the thread node + row are written
    // first, so a successful commit would leave them behind).
    jest
      .spyOn(ThreadParticipants, 'listByThread')
      .mockResolvedValueOnce([{ ...real[0], memberId: `${PREFIX}-nonexistent-member` }]);

    const before = await getDb().query(
      `SELECT count(*)::int AS n FROM public.nodes WHERE type = 'thread' AND project_id = $1`,
      [RC]
    );
    expect(before.rows[0].n).toBe(1); // just the source

    await expect(cloneNode({ sourceId: SRC, targetContainerId: RC })).rejects.toThrow();

    const after = await getDb().query(
      `SELECT count(*)::int AS n FROM public.nodes WHERE type = 'thread' AND project_id = $1`,
      [RC]
    );
    // The half-written clone thread was rolled back — count unchanged.
    expect(after.rows[0].n).toBe(1);
  });
});

describe('cloneNode — node cap', () => {
  const CAPP = `${PREFIX}-cap-parent`;
  const CAP = `${PREFIX}-cap`;

  // Nested for the same reason as the describes above.
  afterAll(cleanup);

  beforeAll(async () => {
    await Containers.create({ id: CAPP, name: 'Cap Parent' });
    await Containers.create({ id: CAP, name: 'Cap', parentId: CAPP });
    await Docs.create({ id: `${PREFIX}-cap-d1`, title: 'D1', containerId: CAP });
    await Docs.create({ id: `${PREFIX}-cap-d2`, title: 'D2', containerId: CAP });
  });

  it('exposes a sane default cap', () => {
    expect(MAX_CLONE_NODES).toBe(200);
  });

  it('rejects a subtree that exceeds the cap, writing nothing', async () => {
    // CAP + D1 + D2 = 3 nodes; cap of 2 trips during discovery (pre-write).
    await expect(cloneNode({ sourceId: CAP }, { maxNodes: 2 })).rejects.toThrow(/paste limit/);

    // Nothing new landed under the parent (still just the original CAP).
    const containers = await Containers.listByParent(CAPP);
    expect(containers).toHaveLength(1);
  });
});
