/**
 * doc(op) — one tool for get_doc / create_doc / edit_doc / delete_doc. Each op
 * hands its handler exactly the input that alias validates, and a field that
 * belongs only to another op is refused before any handler runs. The
 * permission block uses the real alias registry: each alias id pins exactly
 * one op, so allow/deny naming one never covers another.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const log: string[] = [];
const calls: Record<string, unknown[]> = {};
function record(name: string, input: unknown) {
  log.push(name);
  (calls[name] ??= []).push(input);
}

jest.mock('@server/services/ToolService/handlers/docs/getDoc', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('get', input), { id: 'doc-1' })),
}));
jest.mock('@server/services/ToolService/handlers/docs/outlineDoc', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('outline', input), { headings: [] })),
}));
jest.mock('@server/services/ToolService/handlers/docs/createDoc', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('create', input), 'created')),
}));
jest.mock('@server/services/ToolService/handlers/docs/editDoc', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('update', input), 'edited')),
}));
jest.mock('@server/services/ToolService/handlers/docs/deleteDoc', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('delete', input), 'deleted')),
}));

jest.mock('@server/services/WorkspaceService/pathResolver', () => ({
  resolveDocByPath: jest.fn(async (path: string) => `resolved:${path}`),
}));
jest.mock('@server/services/ToolService/handlers/docs/duplicateDoc', () => ({
  __esModule: true,
  default: jest.fn(
    async (input: unknown) => (
      record('duplicate', input),
      { output: 'duplicate', rawContent: { preserved: true } }
    )
  ),
}));
jest.mock('@server/services/ToolService/handlers/docs/diffDoc', () => ({
  __esModule: true,
  default: jest.fn(
    async (input: unknown) => (
      record('diff', input),
      { output: 'diff', rawContent: { preserved: true } }
    )
  ),
}));
jest.mock('@server/services/ToolService/handlers/docs/convertDocToContainer', () => ({
  __esModule: true,
  default: jest.fn(
    async (input: unknown) => (
      record('convert-to-container', input),
      { output: 'convert-to-container', rawContent: { preserved: true } }
    )
  ),
}));
jest.mock('@server/services/ToolService/handlers/docs/history/snapshot', () => ({
  __esModule: true,
  default: jest.fn(
    async (input: unknown) => (
      record('snapshot', input),
      { output: 'snapshot', rawContent: { preserved: true } }
    )
  ),
}));
jest.mock('@server/services/ToolService/handlers/docs/history/list', () => ({
  __esModule: true,
  default: jest.fn(
    async (input: unknown) => (
      record('list-snapshots', input),
      { output: 'list-snapshots', rawContent: { preserved: true } }
    )
  ),
}));
jest.mock('@server/services/ToolService/handlers/docs/history/restore', () => ({
  __esModule: true,
  default: jest.fn(
    async (input: unknown) => (
      record('restore', input),
      { output: 'restore', rawContent: { preserved: true } }
    )
  ),
}));
jest.mock('@server/services/ToolService/handlers/docs/history/delete', () => ({
  __esModule: true,
  default: jest.fn(
    async (input: unknown) => (
      record('delete-snapshot', input),
      { output: 'delete-snapshot', rawContent: { preserved: true } }
    )
  ),
}));
import docTool from '@server/services/ToolService/tools/docs/doc/tool';
import definition from '@server/services/ToolService/tools/docs/doc/definition';
import { evaluateOpAccess, resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';

const run = (input: Record<string, unknown>) => docTool(input, {}, undefined);

beforeEach(() => {
  log.length = 0;
  for (const k of Object.keys(calls)) delete calls[k];
});

describe('doc(op) dispatch', () => {
  it('get → get_doc handler input (doc_id/doc_path), result serialized', async () => {
    const out = await run({ op: 'get', id: 'doc-1', raw: true });
    expect(calls.get).toEqual([{ doc_id: 'doc-1', raw: true }]);
    expect(out).toBe(JSON.stringify({ id: 'doc-1' }));
    await run({ op: 'get', path: '/Snaglet/a', include_archived: true });
    expect(calls.get[1]).toEqual({ doc_path: '/Snaglet/a', include_archived: true });
  });

  it("outline → the outline handler with the bare id, refusing other ops' fields", async () => {
    const out = await run({ op: 'outline', id: 'doc-1#h=setup', include_archived: true });
    expect(calls.outline).toEqual([{ doc_id: 'doc-1', include_archived: true }]);
    expect(out).toBe(JSON.stringify({ headings: [] }));
    await run({ op: 'outline', path: '/Snaglet/a' });
    expect(calls.outline[1]).toEqual({ doc_path: '/Snaglet/a' });
    await expect(run({ op: 'outline', id: 'doc-1', edits: [] })).rejects.toThrow(
      'belongs to op update'
    );
  });

  it('create → create_doc handler input unchanged (legacy container_id passes through), no op', async () => {
    await run({ op: 'create', title: 'T', content: 'x', parent_path: '/Snaglet', sort_order: 2 });
    await run({ op: 'create', title: 'T', container_id: 'container-1' });
    expect(calls.create).toEqual([
      { title: 'T', content: 'x', parent_path: '/Snaglet', sort_order: 2 },
      { title: 'T', container_id: 'container-1' },
    ]);
  });

  it('update → edit_doc handler input (doc_id, edits, flags)', async () => {
    const edits = [{ old_text: 'a', new_text: 'b' }];
    await run({
      op: 'update',
      id: 'doc-1',
      edits,
      validate_only: true,
      create_backup: false,
      raw: true,
    });
    expect(calls.update).toEqual([
      { doc_id: 'doc-1', edits, validate_only: true, create_backup: false, raw: true },
    ]);
  });

  it('delete → delete_doc handler input (doc_id, force, dry_run)', async () => {
    await run({ op: 'delete', path: '/Snaglet/a', force: true, dry_run: true });
    expect(calls.delete).toEqual([{ doc_path: '/Snaglet/a', force: true, dry_run: true }]);
  });

  it('refuses a missing or unknown op', async () => {
    await expect(run({ id: 'doc-1' })).rejects.toThrow('op is required');
    await expect(run({ op: 'history', id: 'doc-1' })).rejects.toThrow('op is required');
    expect(log).toEqual([]);
  });

  it.each([
    ['update', { id: 'doc-1', edits: [], force: true }],
    ['update', { id: 'doc-1', edits: [], title: 'T' }],
    ['create', { title: 'T', edits: [] }],
    ['create', { title: 'T', id: 'doc-1' }],
    ['get', { id: 'doc-1', edits: [] }],
    ['get', { id: 'doc-1', dry_run: true }],
    ['delete', { id: 'doc-1', edits: [] }],
    ['delete', { id: 'doc-1', validate_only: true }],
  ])('%s refuses another op’s field %j before anything runs', async (op, extra) => {
    await expect(run({ op, ...extra })).rejects.toThrow('Nothing was changed');
    expect(log).toEqual([]);
  });
});

describe('doc access rules stay op-level (real alias registry)', () => {
  const opOf = (oldId: string, params: Record<string, unknown> = {}) =>
    transformToolAliasParams(resolveToolId(oldId), params).op as string;
  const allowOnly = (entry: string) => ({ mode: 'allow_list', allowList: [entry], denyList: [] });
  const denyOnly = (entry: string) => ({ mode: 'deny_list', allowList: [], denyList: [entry] });
  const verdict = (access: ReturnType<typeof allowOnly>, op: string) =>
    evaluateOpAccess(access as never, 'doc', op).decision;

  it.each([
    ['get_doc', 'get'],
    ['workspace_get_doc', 'get'],
    ['create_doc', 'create'],
    ['workspace_create_doc', 'create'],
    ['edit_doc', 'update'],
    ['workspace_edit_doc', 'update'],
    ['delete_doc', 'delete'],
    ['workspace_delete_doc', 'delete'],
  ])('%s pins doc op %s (a conflicting op cannot be smuggled)', (oldId, op) => {
    expect(resolveToolId(oldId).id).toBe('doc');
    expect(resolveToolId(oldId).op).toBe(op);
    expect(opOf(oldId, { op: 'delete' })).toBe(op);
  });

  it('old doc_id/doc_path names carry over to id/path', () => {
    expect(transformToolAliasParams(resolveToolId('edit_doc'), { doc_id: 'd' })).toMatchObject({
      id: 'd',
    });
    expect(transformToolAliasParams(resolveToolId('get_doc'), { doc_path: '/a' })).toMatchObject({
      path: '/a',
    });
  });

  it('allow edit_doc refuses delete (and create/get)', () => {
    expect(verdict(allowOnly('edit_doc'), 'update')).toBe('allow');
    for (const op of ['delete', 'create', 'get']) {
      expect(verdict(allowOnly('edit_doc'), op)).not.toBe('allow');
    }
  });

  it('allow get_doc refuses update', () => {
    expect(verdict(allowOnly('get_doc'), 'get')).toBe('allow');
    expect(verdict(allowOnly('get_doc'), 'update')).not.toBe('allow');
    expect(verdict(allowOnly('get_doc'), 'delete')).not.toBe('allow');
  });

  it('deny delete_doc leaves update (and get/create) working', () => {
    expect(verdict(denyOnly('delete_doc'), 'delete')).toBe('deny');
    for (const op of ['update', 'get', 'create']) {
      expect(verdict(denyOnly('delete_doc'), op)).toBe('allow');
    }
  });
});

describe('doc definition', () => {
  const schema = definition.parameters_schema as {
    properties: Record<string, { enum?: string[] }>;
  };

  it('exposes all document and snapshot operations', () => {
    expect(schema.properties.op.enum).toEqual([
      'get',
      'outline',
      'create',
      'update',
      'delete',
      'duplicate',
      'diff',
      'snapshot',
      'list-snapshots',
      'restore',
      'delete-snapshot',
      'convert-to-container',
    ]);
  });

  it('is core, and only delete is confirm-gated (as delete_doc was)', () => {
    expect(definition.tier).toBe('core');
    expect(definition.destructive).toBeUndefined();
    expect(definition.destructiveOps).toEqual(['delete']);
  });
});

describe('expanded doc operations preserve handler contracts', () => {
  it.each([
    [
      'duplicate',
      { id: 'd', new_title: 'copy', target_container_id: null, sort_order: 1.5 },
      { source_id: 'd', new_title: 'copy', target_container_id: null, sort_order: 1.5 },
    ],
    ['duplicate', { source_id: 'd', source_path: '/a' }, { source_id: 'd', source_path: '/a' }],
    [
      'duplicate',
      { source_path: '/a', allow_archived: true },
      { source_path: '/a', allow_archived: true },
    ],
    [
      'diff',
      { id: 'd', from_content: '', context_lines: 0 },
      { doc_id: 'd', from_content: '', context_lines: 0 },
    ],
    [
      'diff',
      { from_snapshot_id: 's1', to_snapshot_id: 's2' },
      { from_snapshot_id: 's1', to_snapshot_id: 's2' },
    ],
    [
      'snapshot',
      { path: '/a', label: 'L', reason: 'R' },
      { doc_path: '/a', label: 'L', reason: 'R' },
    ],
    [
      'list-snapshots',
      { doc_id: 'd', include_content: false, limit: 5 },
      { doc_id: 'd', include_content: false, limit: 5 },
    ],
    [
      'restore',
      { snapshot_id: 's', create_safety_snapshot: false, validate_only: true },
      { snapshot_id: 's', create_safety_snapshot: false, validate_only: true },
    ],
    ['delete-snapshot', { snapshot_id: 's', id: 'd' }, { snapshot_id: 's', doc_id: 'd' }],
    [
      'convert-to-container',
      { id: 'd', category: 'project' },
      { doc_id: 'd', category: 'project' },
    ],
  ])(
    '%s forwards only its handler input and preserves the result envelope',
    async (op, input, expected) => {
      expect(await run({ op, ...input })).toEqual({ output: op, rawContent: { preserved: true } });
      expect(calls[op]).toEqual([expected]);
    }
  );

  it.each(['diff', 'restore', 'delete-snapshot', 'convert-to-container'])(
    '%s resolves canonical path for id-only handlers',
    async (op) => {
      await run({ op, path: '/a' });
      expect(calls[op]).toEqual([{ doc_id: 'resolved:/a' }]);
      await expect(run({ op, id: 'd', path: '/a' })).rejects.toThrow('Cannot specify both');
    }
  );

  it.each([
    ['snapshot', { snapshot_id: 's' }],
    ['snapshot', { limit: 1 }],
    ['list-snapshots', { reason: 'R' }],
    ['restore', { force: false }],
    ['delete-snapshot', { create_safety_snapshot: false }],
    ['delete', { snapshot_id: 's' }],
    ['diff', { allow_archived: false }],
    ['duplicate', { category: 'project' }],
    ['convert-to-container', { edits: [] }],
    ['get', { source_id: 'd' }],
    ['create', { label: 'L' }],
    ['update', { from_content: '' }],
  ])('%s rejects foreign fields even if false/empty', async (op, input) => {
    await expect(run({ op, ...input })).rejects.toThrow('Nothing was changed');
    expect(log).toEqual([]);
  });

  it('legacy doc_id/doc_path work directly as well as through parameter normalization', async () => {
    await run({ op: 'get', doc_id: 'd' });
    await run({ op: 'update', doc_path: '/a', edits: [] });
    expect(calls.get).toEqual([{ doc_id: 'd' }]);
    expect(calls.update).toEqual([{ doc_path: '/a', edits: [] }]);
  });
});
