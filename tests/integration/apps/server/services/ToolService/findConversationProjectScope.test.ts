/**
 * find_conversation project scope against the real database.
 *
 * `mapThreadsToProjects` decides which result threads get the caller's-project
 * boost, and `resolveCallerProject` decides what that project is. Both must
 * agree with findProjectAncestor, including its archived-project rule:
 *
 *   P (project, active)                 ← threads here map to P
 *     └── Folder (plain container)
 *           └── Sub (project, archived) ← its thread climbs to P, not dropped
 *   flat thread (project_id NULL)       ← absent from the map
 *
 * The archive cascade also archives Sub's thread; the mapping is
 * about scope, not liveness, so the archived thread still resolves.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Containers, Threads, getDb } from '@snaglet/db';
import {
  mapThreadsToProjects,
  resolveCallerProject,
} from '@server/services/ToolService/handlers/search/findConversation/projectScope';

const PREFIX = 'fcscope-test';
const PROJECT_ID = `${PREFIX}-p`;
const FOLDER_ID = `${PREFIX}-folder`;
const SUB_ID = `${PREFIX}-sub`;
const THREAD_IN_P = `${PREFIX}-t-p`;
const THREAD_IN_SUB = `${PREFIX}-t-sub`;
const THREAD_FLAT = `${PREFIX}-t-flat`;

async function cleanup() {
  // containers/threads share their primary key with nodes and cascade from it.
  // Delete deepest-first, one row per statement: the archived sub-project
  // counts as "independently archived" under its live folder, so a single
  // multi-row DELETE would have the orphan-null trigger update a row the same
  // statement is already deleting.
  for (const id of [THREAD_IN_SUB, THREAD_IN_P, THREAD_FLAT, SUB_ID, FOLDER_ID, PROJECT_ID]) {
    await getDb().query(`DELETE FROM public.nodes WHERE id = $1`, [id]);
  }
}

describe('find_conversation project scope', () => {
  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: PROJECT_ID, name: `${PREFIX} P`, category: 'project' });
    await Containers.create({ id: FOLDER_ID, name: `${PREFIX} Folder`, parentId: PROJECT_ID });
    await Containers.create({
      id: SUB_ID,
      name: `${PREFIX} Sub`,
      parentId: FOLDER_ID,
      category: 'project',
    });
    await Threads.create({ id: THREAD_IN_P, title: 'In P', projectId: PROJECT_ID });
    await Threads.create({ id: THREAD_IN_SUB, title: 'In Sub', projectId: SUB_ID });
    await Threads.create({ id: THREAD_FLAT, title: 'Flat' });
    // Archive the sub-project after its thread exists (an archived project
    // refuses new threads). The cascade archives the thread too.
    await getDb().query(
      `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
      [SUB_ID]
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  it('maps a thread to its own active project', async () => {
    const map = await mapThreadsToProjects([THREAD_IN_P]);
    expect(map.get(THREAD_IN_P)).toBe(PROJECT_ID);
  });

  it('climbs past an archived sub-project to the enclosing active project', async () => {
    const map = await mapThreadsToProjects([THREAD_IN_SUB]);
    expect(map.get(THREAD_IN_SUB)).toBe(PROJECT_ID);
  });

  it('leaves a flat thread out of the map', async () => {
    const map = await mapThreadsToProjects([THREAD_FLAT, THREAD_IN_P, `${PREFIX}-missing`]);
    expect(map.has(THREAD_FLAT)).toBe(false);
    expect(map.has(`${PREFIX}-missing`)).toBe(false);
    expect(map.get(THREAD_IN_P)).toBe(PROJECT_ID);
  });

  it('returns an empty map for no ids', async () => {
    expect((await mapThreadsToProjects([])).size).toBe(0);
  });

  it('resolveCallerProject agrees with the batch mapping', async () => {
    await expect(resolveCallerProject(THREAD_IN_SUB)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      projectName: `${PREFIX} P`,
    });
    await expect(resolveCallerProject(THREAD_FLAT)).resolves.toBeNull();
    await expect(resolveCallerProject(null)).resolves.toBeNull();
  });
});
