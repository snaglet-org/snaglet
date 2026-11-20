import { describe, it, expect, afterAll } from '@jest/globals';
import { Containers } from '@snaglet/db/tables/containers';
import handler from '@server/services/ToolService/handlers/containers/createContainer';

/**
 * Integration test for workspace_create_container.
 *
 * Hits the real database. The tool's input contract:
 *   - `name`         (required) — container's display name
 *   - `parent_id`    (optional) — direct id of parent container
 *   - `parent_path`  (optional) — slash-delimited path to parent
 *   - `sort_order`   (optional) — explicit sibling sort order
 *
 * Returns `{ output, rawContent }`. `rawContent` shape:
 *   { success, container: { id, name, parent_id, sort_order, created_at }, link }
 */

type CreateContainerResult = {
  output: string;
  rawContent: {
    success: true;
    container: {
      id: string;
      name: string;
      parent_id: string | null;
      sort_order: number;
      created_at: Date;
    };
    link: string;
  };
};

async function call(input: Record<string, unknown>): Promise<CreateContainerResult> {
  const out = await handler(input as never, {} as never, {} as never);
  if (typeof out === 'string') {
    throw new Error('Expected structured ToolHandler result, got string');
  }
  return out as CreateContainerResult;
}

describe('workspace_create_container (integration)', () => {
  const createdIds: string[] = [];
  // Unique suffix per run keeps tests idempotent across reruns even when
  // afterAll cleanup misses (e.g. assertion failure mid-test).
  const suffix = `-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const n = (base: string) => `${base}${suffix}`;

  afterAll(async () => {
    // Children-first cleanup.
    for (let i = createdIds.length - 1; i >= 0; i--) {
      try {
        await Containers.delete(createdIds[i]);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it('creates a root-level container', async () => {
    const result = await call({ name: n('Test Root Container') });

    expect(result.rawContent.success).toBe(true);
    expect(result.rawContent.container.id).toMatch(/^container-/);
    expect(result.rawContent.container.name).toBe(n('Test Root Container'));
    expect(result.rawContent.container.parent_id).toBeNull();
    expect(typeof result.rawContent.container.sort_order).toBe('number');

    createdIds.push(result.rawContent.container.id);

    const row = await Containers.findById(result.rawContent.container.id);
    expect(row).toBeTruthy();
    expect(row!.name).toBe(n('Test Root Container'));
    expect(row!.parentId).toBeNull();
  });

  it('creates a nested container via parent_id', async () => {
    const parent = await call({ name: n('Parent Container') });
    createdIds.push(parent.rawContent.container.id);

    const child = await call({
      name: n('Child Container'),
      parent_id: parent.rawContent.container.id,
      sort_order: 5,
    });
    createdIds.push(child.rawContent.container.id);

    expect(child.rawContent.container.name).toBe(n('Child Container'));
    expect(child.rawContent.container.parent_id).toBe(parent.rawContent.container.id);
    expect(child.rawContent.container.sort_order).toBe(5);

    const row = await Containers.findById(child.rawContent.container.id);
    expect(row!.parentId).toBe(parent.rawContent.container.id);
    expect(row!.sortOrder).toBe(5);
  });

  it('creates a nested container via parent_path', async () => {
    const p1 = await call({ name: n('PathTest') });
    createdIds.push(p1.rawContent.container.id);

    const p2 = await call({
      name: n('SubFolder'),
      parent_id: p1.rawContent.container.id,
    });
    createdIds.push(p2.rawContent.container.id);

    const child = await call({
      name: n('PathChild'),
      parent_path: `/PathTest${suffix}/SubFolder${suffix}`,
    });
    createdIds.push(child.rawContent.container.id);

    expect(child.rawContent.container.name).toBe(n('PathChild'));
    expect(child.rawContent.container.parent_id).toBe(p2.rawContent.container.id);
  });

  it('rejects empty/whitespace name', async () => {
    await expect(call({ name: '' })).rejects.toThrow(/`name` is required/);
    await expect(call({ name: '   ' })).rejects.toThrow(/`name` is required/);
  });

  it('rejects missing parent_id', async () => {
    await expect(
      call({ name: n('Test Container'), parent_id: 'container-does-not-exist' })
    ).rejects.toThrow();
  });

  it('rejects missing parent_path', async () => {
    await expect(
      call({ name: n('Test Container'), parent_path: '/NonExistent/Path' })
    ).rejects.toThrow();
  });

  it('rejects both parent_id and parent_path', async () => {
    const parent = await call({ name: n('ConflictParent') });
    createdIds.push(parent.rawContent.container.id);

    await expect(
      call({
        name: 'X',
        parent_id: parent.rawContent.container.id,
        parent_path: `/ConflictParent${suffix}`,
      })
    ).rejects.toThrow();
  });

  it('auto-assigns sort_order to (max sibling + 1)', async () => {
    const parent = await call({ name: n('AutoSortParent') });
    createdIds.push(parent.rawContent.container.id);

    const c1 = await call({
      name: n('Child1'),
      parent_id: parent.rawContent.container.id,
      sort_order: 10,
    });
    createdIds.push(c1.rawContent.container.id);

    const c2 = await call({
      name: n('Child2'),
      parent_id: parent.rawContent.container.id,
    });
    createdIds.push(c2.rawContent.container.id);

    const row = await Containers.findById(c2.rawContent.container.id);
    expect(row!.sortOrder).toBe(11);
  });

  it('rejects duplicate sibling name (case-insensitive)', async () => {
    const parent = await call({ name: n('UniqParent') });
    createdIds.push(parent.rawContent.container.id);

    const c1 = await call({ name: n('Unique'), parent_id: parent.rawContent.container.id });
    createdIds.push(c1.rawContent.container.id);

    await expect(
      call({ name: n('UNIQUE'), parent_id: parent.rawContent.container.id })
    ).rejects.toThrow(/already exists at this level/);
  });
});
