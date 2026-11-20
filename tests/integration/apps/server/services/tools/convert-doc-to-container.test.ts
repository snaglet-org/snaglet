/**
 * convert_doc_to_container — the sub-items graduation op (integration, real DB).
 *
 * Asserts the load-bearing invariants:
 *   - a new container is created in the doc's location, named after the doc,
 *     inheriting its sort_order;
 *   - the doc is moved inside as the overview doc (placement_events records it);
 *   - the doc id is unchanged (links/embeddings survive).
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Containers, Docs, PlacementEvents } from '@snaglet/db';
import { normalizeToolParams } from '@server/services/ToolService/lib/normalizeToolParams';
import definition from '@server/services/ToolService/tools/docs/doc/definition';
import handler from '@server/services/ToolService/handlers/docs/convertDocToContainer';

const PREFIX = 'convert-test';
const PARENT = `${PREFIX}-parent`;

interface ConvertResult {
  output: string;
  rawContent: {
    success: true;
    container: {
      id: string;
      name: string;
      parent_id: string | null;
      category: string | null;
      sort_order: number;
    };
    overview_doc: {
      id: string;
      title: string;
      container_id: string | null;
      sort_order: number;
    };
  };
}

async function convert(input: Record<string, unknown>): Promise<ConvertResult> {
  const normalized = normalizeToolParams(input, definition.param_aliases);
  const out = await handler(
    { ...normalized, doc_id: normalized.id ?? normalized.doc_id } as never,
    {} as never,
    {} as never
  );
  if (typeof out === 'string') throw new Error('expected structured result');
  return out as ConvertResult;
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(
    `DELETE FROM public.placement_events WHERE node_id LIKE 'doc-${PREFIX}-%' OR node_id LIKE '${PREFIX}-%'`
  );
  await pool.query(`DELETE FROM public.docs WHERE id LIKE 'doc-${PREFIX}-%'`);
  // Sub-containers first (children before parents) via a broad LIKE on both id shapes.
  await pool.query(`DELETE FROM public.containers WHERE id LIKE '${PREFIX}-%'`);
  await pool.query(
    `DELETE FROM public.nodes WHERE id LIKE 'doc-${PREFIX}-%' OR id LIKE '${PREFIX}-%'`
  );
}

describe('convert_doc_to_container', () => {
  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: PARENT, name: `${PREFIX} parent` });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('creates a container named after the doc, inheriting its sort_order', async () => {
    const docId = `doc-${PREFIX}-a`;
    await Docs.create({ id: docId, title: `${PREFIX} Alpha`, containerId: PARENT, sortOrder: 7 });

    const r = await convert({ doc_id: docId });

    expect(r.rawContent.container.name).toBe(`${PREFIX} Alpha`);
    expect(r.rawContent.container.parent_id).toBe(PARENT);
    expect(r.rawContent.container.sort_order).toBe(7);
    expect(r.rawContent.container.category).toBeNull();

    const containerRow = await Containers.findById(r.rawContent.container.id);
    expect(containerRow).not.toBeNull();
    expect(containerRow!.sortOrder).toBe(7);
  });

  it('moves the doc inside as the overview doc without changing its id', async () => {
    const docId = `doc-${PREFIX}-b`;
    await Docs.create({ id: docId, title: `${PREFIX} Bravo`, containerId: PARENT });

    const r = await convert({ doc_id: docId });

    // id stability — the doc id is unchanged; the container is a different node.
    expect(r.rawContent.overview_doc.id).toBe(docId);
    expect(r.rawContent.container.id).not.toBe(docId);

    // the doc now lives inside the new container
    const docRow = await Docs.findById(docId);
    expect(docRow!.containerId).toBe(r.rawContent.container.id);

    // placement_events recorded the move (PARENT -> new container)
    const events = await PlacementEvents.listByNode(docId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].toContainerId).toBe(r.rawContent.container.id);
    expect(events[0].fromContainerId).toBe(PARENT);
  });

  it('carries an optional category onto the new container', async () => {
    const docId = `doc-${PREFIX}-e`;
    await Docs.create({ id: docId, title: `${PREFIX} Echo`, containerId: PARENT });

    const r = await convert({ doc_id: docId, category: 'project' });

    expect(r.rawContent.container.category).toBe('project');
    expect(r.rawContent.container).not.toHaveProperty('phase');
  });

  it('rejects the retired status category', async () => {
    const docId = `doc-${PREFIX}-f`;
    await Docs.create({ id: docId, title: `${PREFIX} Foxtrot`, containerId: PARENT });

    await expect(convert({ doc_id: docId, category: 'status' })).rejects.toThrow(
      /`category` must be/
    );
  });

  it('rejects a missing doc', async () => {
    await expect(convert({ doc_id: `doc-${PREFIX}-does-not-exist` })).rejects.toThrow(/not found/);
  });
});
