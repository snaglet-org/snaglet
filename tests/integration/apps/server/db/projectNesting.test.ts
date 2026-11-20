/**
 * Project lineage via the category walk, against the real database. A project
 * is a container with `category='project'` and the container id is its
 * identity. Projects may nest, so lineage walks `nodes.container_id`:
 *
 *   PARENT (project)
 *     └── A (plain container)
 *           └── B (project)
 *
 * findProjectAncestor returns the nearest enclosing project (the node itself
 * when it is one), findProjectAncestorChain the nearest→root lineage,
 * findProjectAncestors the same for a batch, and findDescendantProjects every
 * project nested beneath one, itself included.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Containers, Projects, getDb } from '@snaglet/db';
import {
  findProjectAncestor,
  findProjectAncestorChain,
  findProjectAncestors,
} from '@server/services/ToolService/lib/findProjectAncestor';
import { findDescendantProjects } from '@server/services/ToolService/lib/findDescendantProjects';

const PREFIX = 'projnest-test';
const PARENT_ID = `${PREFIX}-parent`;
const A_ID = `${PREFIX}-a`;
const B_ID = `${PREFIX}-b`;
const B_PROJECT_NAME = `${PREFIX}-proj-b`;

async function cleanup() {
  // nodes.container_id is ON DELETE CASCADE and containers share their PK with
  // nodes, so removing the three container nodes drops their containers rows too.
  await getDb().query(`DELETE FROM public.nodes WHERE id IN ($1, $2, $3)`, [PARENT_ID, A_ID, B_ID]);
}

describe('project lineage — category walk over nested project containers', () => {
  beforeAll(async () => {
    await cleanup();
    // PARENT is a project container, created directly with category='project'.
    await Containers.create({ id: PARENT_ID, name: `${PREFIX}-parent`, category: 'project' });
    // A is a plain container nested in PARENT.
    await Containers.create({ id: A_ID, name: `${PREFIX}-a`, parentId: PARENT_ID });
    // B is a project container nested in A (a project is one from creation);
    // the Projects facade writes its facet and renames the container.
    await Containers.create({
      id: B_ID,
      name: `${PREFIX}-b`,
      parentId: A_ID,
      category: 'project',
    });
    await Projects.create({ containerId: B_ID, name: B_PROJECT_NAME });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('resolves the nearest enclosing project (including the node itself)', async () => {
    // B is a project → the walk (which seeds with the node itself) resolves to B.
    const forB = await findProjectAncestor(B_ID);
    // A project is its container: the project id is the container id.
    expect(forB?.projectId).toBe(B_ID);
    // Projects.create renamed the container, so the project name is B_PROJECT_NAME.
    expect(forB?.projectName).toBe(B_PROJECT_NAME);

    // A is a plain container → the nearest project ancestor is PARENT.
    const forA = await findProjectAncestor(A_ID);
    expect(forA?.projectId).toBe(PARENT_ID);
  });

  it('resolves a batch of nodes to their nearest project in one call', async () => {
    const batch = await findProjectAncestors([B_ID, A_ID, PARENT_ID, `${PREFIX}-missing`]);
    expect(batch.get(B_ID)?.projectId).toBe(B_ID);
    expect(batch.get(A_ID)?.projectId).toBe(PARENT_ID);
    expect(batch.get(PARENT_ID)?.projectId).toBe(PARENT_ID);
    // Unknown ids are simply absent, mirroring the single form's null.
    expect(batch.has(`${PREFIX}-missing`)).toBe(false);
  });

  it('returns the full nearest→root project lineage for a nested sub-project', async () => {
    // B → (A is plain, skipped) → PARENT: two project containers, nearest first.
    const chain = await findProjectAncestorChain(B_ID);
    expect(chain.map((p) => p.projectId)).toEqual([B_ID, PARENT_ID]);
  });

  it('rolls up every project container nested beneath a project (incl. itself)', async () => {
    // PARENT's subtree contains project containers PARENT (self) and B.
    const beneathParent = await findDescendantProjects(PARENT_ID);
    expect(new Set(beneathParent)).toEqual(new Set([PARENT_ID, B_ID]));

    // A leaf project sees only itself.
    expect(await findDescendantProjects(B_ID)).toEqual([B_ID]);
  });
});
