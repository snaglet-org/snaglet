/**
 * Named-project scope against the real database. Unit tests prove the route
 * hands the resolved id to every lane; this file proves the recursive-CTE
 * filter actually confines results to that project.
 *
 *   Aurora (project)                    ← the one the user names
 *     └── Workstreams (plain container)
 *           └── Aurora Signals (project) ← nested project, included
 *   Borealis (project)                  ← decoy, must not leak
 *
 * Every project holds a doc with the same distinctive phrase, so any result
 * that crosses a project boundary is visible. Keyword mode throughout: this is
 * about the scope filter, not the embedder.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Containers, Docs, Projects, getDb } from '@snaglet/db';
import { workspaceSearchNodes } from '@server/services/search/nodeSearch';
import { resolveNamedProjectScope } from '@server/services/search/namedScope';

const PREFIX = 'namedscope-test';
const AURORA_ID = `${PREFIX}-aurora`;
const WORKSTREAMS_ID = `${PREFIX}-workstreams`;
const SIGNALS_ID = `${PREFIX}-signals`;
const BOREALIS_ID = `${PREFIX}-borealis`;
const TWIN_A_ID = `${PREFIX}-twin-a`;
const TWIN_B_ID = `${PREFIX}-twin-b`;

const AURORA_DOC_ID = `${PREFIX}-doc-aurora`;
const SIGNALS_DOC_ID = `${PREFIX}-doc-signals`;
const BOREALIS_DOC_ID = `${PREFIX}-doc-borealis`;

// Project names are deliberately not this repository's. A scope feature tuned
// to one workspace's vocabulary is not a scope feature.
const AURORA_NAME = `${PREFIX} Aurora`;
const SIGNALS_NAME = `${PREFIX} Aurora Signals`;
const BOREALIS_NAME = `${PREFIX} Borealis`;
const TWIN_NAME = `${PREFIX} Twin`;

/** Distinctive enough that a hit is never a coincidence. */
const SHARED_TITLE = 'Zephyr Reconciliation Protocol';

const CONTAINER_IDS = [
  AURORA_ID,
  WORKSTREAMS_ID,
  SIGNALS_ID,
  BOREALIS_ID,
  TWIN_A_ID,
  TWIN_B_ID,
] as const;
const DOC_IDS = [AURORA_DOC_ID, SIGNALS_DOC_ID, BOREALIS_DOC_ID] as const;

async function cleanup() {
  // containers/docs share their primary key with nodes and cascade from it.
  await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
    [...CONTAINER_IDS, ...DOC_IDS],
  ]);
}

// The hooks live inside a describe so they unwind before the shared database
// teardown. At file level, the cleanup query runs against an already-closed pool.
describe('named-project scope', () => {
  beforeAll(async () => {
    await cleanup();

    await Containers.create({ id: AURORA_ID, name: AURORA_NAME, category: 'project' });
    await Containers.create({
      id: WORKSTREAMS_ID,
      name: `${PREFIX} Workstreams`,
      parentId: AURORA_ID,
    });
    // A project nested two levels down. A project is created as one — the
    // category is fixed at creation; Projects.create then writes its facet.
    await Containers.create({
      id: SIGNALS_ID,
      name: SIGNALS_NAME,
      parentId: WORKSTREAMS_ID,
      category: 'project',
    });
    await Projects.create({ containerId: SIGNALS_ID, name: SIGNALS_NAME });
    await Containers.create({ id: BOREALIS_ID, name: BOREALIS_NAME, category: 'project' });

    // Two projects sharing a name, differing only in case.
    await Containers.create({ id: TWIN_A_ID, name: TWIN_NAME, category: 'project' });
    await Containers.create({ id: TWIN_B_ID, name: TWIN_NAME.toUpperCase(), category: 'project' });

    await Docs.create({ id: AURORA_DOC_ID, title: SHARED_TITLE, containerId: AURORA_ID });
    await Docs.create({ id: SIGNALS_DOC_ID, title: SHARED_TITLE, containerId: SIGNALS_ID });
    await Docs.create({ id: BOREALIS_DOC_ID, title: SHARED_TITLE, containerId: BOREALIS_ID });
  });

  afterAll(async () => {
    await cleanup();
  });

  describe('resolving a name against real project rows', () => {
    it('finds the project a quoted name refers to', async () => {
      const resolved = await resolveNamedProjectScope(`${SHARED_TITLE} in "${AURORA_NAME}"`);

      expect(resolved).toMatchObject({
        status: 'resolved',
        projectId: AURORA_ID,
        projectName: AURORA_NAME,
        residualQuery: SHARED_TITLE,
      });
    });

    it('resolves a nested project by name, not just a top-level one', async () => {
      const resolved = await resolveNamedProjectScope(`${SHARED_TITLE} in "${SIGNALS_NAME}"`);

      expect(resolved).toMatchObject({ status: 'resolved', projectId: SIGNALS_ID });
    });

    it('reports a name that matches no project', async () => {
      const resolved = await resolveNamedProjectScope(`${SHARED_TITLE} in "${PREFIX} Nowhere"`);

      expect(resolved).toEqual({ status: 'not_found', name: `${PREFIX} Nowhere` });
    });

    it('refuses two projects whose names differ only by case', async () => {
      const resolved = await resolveNamedProjectScope(`${SHARED_TITLE} in "${TWIN_NAME}"`);

      expect(resolved).toMatchObject({ status: 'ambiguous', name: TWIN_NAME });
      expect(resolved.status === 'ambiguous' && resolved.matches).toHaveLength(2);
    });

    it('does not resolve a plain container — only projects are scopes', async () => {
      // "Workstreams" is a container inside Aurora, not a project. Treating it
      // as one would narrow the search to a subtree the user never named.
      const resolved = await resolveNamedProjectScope(`${SHARED_TITLE} in "${PREFIX} Workstreams"`);

      expect(resolved.status).toBe('not_found');
    });

    it('leaves an unresolvable unquoted phrase alone', async () => {
      const resolved = await resolveNamedProjectScope('reconciliation notes in progress');

      expect(resolved).toEqual({ status: 'none' });
    });
  });

  describe('the resolved id actually confines the search', () => {
    const scopedDocIds = async (projectId: string) => {
      const result = await workspaceSearchNodes({
        query: SHARED_TITLE,
        kind: 'doc',
        scope: { project_id: projectId },
        mode: 'keyword',
        limit: 20,
        rerank: false,
      });
      return result.hits.map((hit) => hit.node_id);
    };

    it('includes the named project and its nested projects', async () => {
      const ids = await scopedDocIds(AURORA_ID);

      expect(ids).toContain(AURORA_DOC_ID);
      // Two containers below the named project, behind a plain container.
      expect(ids).toContain(SIGNALS_DOC_ID);
    });

    it('excludes an identically-titled doc in another project', async () => {
      const ids = await scopedDocIds(AURORA_ID);

      expect(ids).not.toContain(BOREALIS_DOC_ID);
    });

    it('scopes to the nested project alone when that is what was named', async () => {
      const ids = await scopedDocIds(SIGNALS_ID);

      expect(ids).toContain(SIGNALS_DOC_ID);
      expect(ids).not.toContain(AURORA_DOC_ID);
      expect(ids).not.toContain(BOREALIS_DOC_ID);
    });

    it('finds all three unscoped, proving the exclusions were the scope', async () => {
      // Without this, every assertion above would also pass if the query simply
      // matched nothing.
      const result = await workspaceSearchNodes({
        query: SHARED_TITLE,
        kind: 'doc',
        scope: { container_id: 'root' },
        mode: 'keyword',
        limit: 50,
        rerank: false,
      });
      const ids = result.hits.map((hit) => hit.node_id);

      expect(ids).toEqual(expect.arrayContaining([AURORA_DOC_ID, SIGNALS_DOC_ID, BOREALIS_DOC_ID]));
    });
  });
});
