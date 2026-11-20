/**
 * workspace_orient's "recently touched" scope against the real database.
 *
 * Threads are not in the folder tree, so the subtree walk alone would never
 * see them. `loadRecentInScope` must pick a thread up through `project_id`:
 *
 *   P (project)
 *     ├── Folder (plain container)
 *     │     └── Doc
 *     ├── thread scoped to P           ← via project_id
 *     └── Nested (project)
 *           └── thread scoped to Nested ← nested project's thread, via project_id
 *   Q (project) + its thread           ← another project, must not leak
 *   flat thread                        ← no project, must not appear
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Containers, Docs, Threads, getDb } from '@snaglet/db';
import { loadRecentInScope } from '@server/services/ToolService/handlers/trivial/workspaceOrient';

const PREFIX = 'orient-recent-test';
const P_ID = `${PREFIX}-p`;
const FOLDER_ID = `${PREFIX}-folder`;
const DOC_ID = `${PREFIX}-doc`;
const NESTED_ID = `${PREFIX}-nested`;
const Q_ID = `${PREFIX}-q`;
const THREAD_P = `${PREFIX}-t-p`;
const THREAD_NESTED = `${PREFIX}-t-nested`;
const THREAD_Q = `${PREFIX}-t-q`;
const THREAD_FLAT = `${PREFIX}-t-flat`;

async function cleanup() {
  await getDb().query(`DELETE FROM public.nodes WHERE id LIKE $1`, [`${PREFIX}-%`]);
}

describe('workspace_orient loadRecentInScope', () => {
  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: P_ID, name: `${PREFIX} P`, category: 'project' });
    await Containers.create({ id: FOLDER_ID, name: `${PREFIX} Folder`, parentId: P_ID });
    await Docs.create({ id: DOC_ID, title: `${PREFIX} Doc`, containerId: FOLDER_ID });
    await Containers.create({
      id: NESTED_ID,
      name: `${PREFIX} Nested`,
      parentId: P_ID,
      category: 'project',
    });
    await Containers.create({ id: Q_ID, name: `${PREFIX} Q`, category: 'project' });
    await Threads.create({ id: THREAD_P, title: 'In P', projectId: P_ID });
    await Threads.create({ id: THREAD_NESTED, title: 'In Nested', projectId: NESTED_ID });
    await Threads.create({ id: THREAD_Q, title: 'In Q', projectId: Q_ID });
    await Threads.create({ id: THREAD_FLAT, title: 'Flat' });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('includes the project subtree plus the threads scoped to it (nested projects too)', async () => {
    const ids = (await loadRecentInScope(P_ID, 50)).map((row) => row.id);
    expect(ids).toEqual(
      expect.arrayContaining([P_ID, FOLDER_ID, DOC_ID, NESTED_ID, THREAD_P, THREAD_NESTED])
    );
    expect(ids).not.toContain(THREAD_Q);
    expect(ids).not.toContain(THREAD_FLAT);
  });

  it('scopes to the nested project alone when seeded there', async () => {
    const ids = (await loadRecentInScope(NESTED_ID, 50)).map((row) => row.id);
    expect(ids).toContain(THREAD_NESTED);
    expect(ids).not.toContain(THREAD_P);
    expect(ids).not.toContain(DOC_ID);
  });

  it('labels a thread row by its title and honors the limit', async () => {
    const rows = await loadRecentInScope(Q_ID, 1);
    expect(rows).toHaveLength(1);
    const thread = (await loadRecentInScope(Q_ID, 50)).find((row) => row.id === THREAD_Q);
    expect(thread).toMatchObject({ type: 'thread', label: 'In Q' });
  });
});
