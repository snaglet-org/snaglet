/**
 * node(op). Each op hands its handler exactly the input that alias validates.
 * move and rename are separate ops (so each alias id pins one op and access
 * rules stay op-level); a field belonging to the other op is refused before
 * anything runs. The permission block uses the real alias registry: allow/deny
 * naming move never covers rename and vice versa.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const log: string[] = [];
const calls: Record<string, unknown[]> = {};
function record(name: string, input: unknown) {
  log.push(name);
  (calls[name] ??= []).push(input);
}

jest.mock('@server/services/ToolService/handlers/workspace/getNode', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('get', input), { id: 'doc-1' })),
}));
jest.mock('@server/services/ToolService/handlers/workspace/verifyIds', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('verify', input), { verified: [] })),
}));
jest.mock('@server/services/ToolService/handlers/workspace/workspaceTreeOp', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('tree', input), 'tree-text')),
}));
jest.mock('@server/services/ToolService/handlers/workspace/archiveNode', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('archive', input), { success: true })),
}));
jest.mock('@server/services/ToolService/handlers/workspace/restoreNode', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('restore', input), { success: true })),
}));

jest.mock('@server/services/ToolService/handlers/workspace/moveNode', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('move', input), { output: 'moved' })),
}));
jest.mock('@server/services/ToolService/handlers/workspace/renameNode', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('rename', input), { output: 'renamed' })),
}));

import nodeTool from '@server/services/ToolService/tools/workspace/node/tool';
import definition from '@server/services/ToolService/tools/workspace/node/definition';
import { evaluateOpAccess, resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';

const run = (input: Record<string, unknown>) => nodeTool(input, {}, undefined);

beforeEach(() => {
  log.length = 0;
  for (const k of Object.keys(calls)) delete calls[k];
});

describe('node(op) dispatch', () => {
  it('get with id → get_node handler input (node_id), no op leaked', async () => {
    await run({ op: 'get', id: 'doc-1', include_children: true });
    expect(calls.get).toEqual([{ node_id: 'doc-1', include_children: true }]);
  });

  it('get with ids → verify_ids handler', async () => {
    await run({ op: 'get', ids: ['doc-1', 'doc-2'] });
    expect(calls.verify).toEqual([{ ids: ['doc-1', 'doc-2'] }]);
  });

  it('get refuses id and ids together', async () => {
    await expect(run({ op: 'get', id: 'doc-1', ids: ['doc-2'] })).rejects.toThrow('not both');
  });

  it('tree maps id → container_id and keeps scope/kinds', async () => {
    await run({ op: 'tree', id: 'container-1', kinds: ['doc'], scope: 'workspace' });
    expect(calls.tree).toEqual([
      { container_id: 'container-1', kinds: ['doc'], scope: 'workspace' },
    ]);
  });

  it('archive keeps kind container, defaults to node', async () => {
    await run({ op: 'archive', path: '/Snaglet/old', kind: 'container' });
    await run({ op: 'archive', id: 'doc-1' });
    expect(calls.archive).toEqual([
      { path: '/Snaglet/old', kind: 'container' },
      { id: 'doc-1', kind: 'node' },
    ]);
  });

  it('restore maps parent_id → container_id (null kept)', async () => {
    await run({ op: 'restore', id: 'doc-1', parent_id: null });
    expect(calls.restore).toEqual([{ node_id: 'doc-1', container_id: null }]);
  });

  it('refuses a missing or unknown op', async () => {
    await expect(run({ id: 'doc-1' })).rejects.toThrow('op is required');
    await expect(run({ op: 'delete', id: 'doc-1' })).rejects.toThrow('op is required');
  });
});

describe('node(op:move)', () => {
  it('maps to the move handler with its old field names', async () => {
    await run({ op: 'move', id: 'doc-1', parent_id: 'container-2', sort_order: 3 });
    expect(calls.move).toEqual([{ id: 'doc-1', new_parent_id: 'container-2', sort_order: 3 }]);
  });

  it('keeps null (root / flat) and parent_path', async () => {
    await run({ op: 'move', id: 'thread-1', kind: 'thread', parent_id: null });
    await run({ op: 'move', path: '/Snaglet/a', parent_path: '/' });
    expect(calls.move).toEqual([
      { id: 'thread-1', kind: 'thread', new_parent_id: null },
      { path: '/Snaglet/a', new_parent_path: '/' },
    ]);
  });

  it.each([{ title: 'New' }, { new_title: 'New' }, { validate_only: true }])(
    'refuses %j before anything runs',
    async (extra) => {
      await expect(
        run({ op: 'move', id: 'doc-1', parent_id: 'container-2', ...extra })
      ).rejects.toThrow('Nothing was changed');
      expect(log).toEqual([]);
    }
  );
});

describe('node(op:rename)', () => {
  it('maps to the rename handler (title → new_title, preview and labels kept)', async () => {
    await run({
      op: 'rename',
      id: 'doc-1',
      title: 'New',
      update_inline_labels: false,
      validate_only: true,
    });
    expect(calls.rename).toEqual([
      { id: 'doc-1', new_title: 'New', update_inline_labels: false, validate_only: true },
    ]);
  });

  it.each(['parent_id', 'parent_path', 'sort_order'])(
    'refuses placement field %s before anything runs',
    async (field) => {
      await expect(run({ op: 'rename', id: 'doc-1', title: 'New', [field]: 'x' })).rejects.toThrow(
        'Nothing was changed'
      );
      expect(log).toEqual([]);
    }
  );

  it.each(['thread'])('refuses a %s before anything runs', async (kind) => {
    await expect(run({ op: 'rename', id: `${kind}-1`, kind, title: 'New' })).rejects.toThrow(
      'docs, containers and images, not a thread'
    );
    expect(log).toEqual([]);
  });
});

describe('node access rules stay op-level (real alias registry)', () => {
  const opOf = (oldId: string, params: Record<string, unknown> = {}) =>
    transformToolAliasParams(resolveToolId(oldId), params).op as string;
  const MOVE_CALL = 'move';
  const RENAME_CALL = 'rename';
  const allowOnly = (entry: string) => ({ mode: 'allow_list', allowList: [entry], denyList: [] });
  const denyOnly = (entry: string) => ({ mode: 'deny_list', allowList: [], denyList: [entry] });

  it('old ids pin the split ops', () => {
    expect(opOf('move')).toBe(MOVE_CALL);
    expect(opOf('move_container')).toBe(MOVE_CALL);
    expect(opOf('rename', { new_title: 'T' })).toBe(RENAME_CALL);
  });

  it.each(['move', 'workspace_move'])('allow %s → move allowed, rename refused', (entry) => {
    expect(evaluateOpAccess(allowOnly(entry), 'node', MOVE_CALL).decision).toBe('allow');
    expect(evaluateOpAccess(allowOnly(entry), 'node', RENAME_CALL).decision).not.toBe('allow');
  });

  it.each(['move_container', 'container_move'])(
    'allow %s → container moves only; other kinds and rename refused',
    (entry) => {
      const as = (kind: string | null) => ({ callParams: { kind } });
      expect(evaluateOpAccess(allowOnly(entry), 'node', MOVE_CALL, as('container')).decision).toBe(
        'allow'
      );
      for (const kind of [null, 'doc', 'thread']) {
        expect(evaluateOpAccess(allowOnly(entry), 'node', MOVE_CALL, as(kind)).decision).toBe(
          'ask'
        );
      }
      expect(
        evaluateOpAccess(allowOnly(entry), 'node', RENAME_CALL, as('container')).decision
      ).not.toBe('allow');
    }
  );

  it.each(['archive_container', 'container_archive'])(
    'allow %s → container archives only',
    (entry) => {
      expect(
        evaluateOpAccess(allowOnly(entry), 'node', 'archive', {
          callParams: { kind: 'container' },
        }).decision
      ).toBe('allow');
      for (const kind of [null, 'node', 'doc']) {
        expect(
          evaluateOpAccess(allowOnly(entry), 'node', 'archive', { callParams: { kind } }).decision
        ).toBe('ask');
      }
    }
  );

  it('kind-scoped old ids still pin kind on the call itself', () => {
    for (const id of [
      'move_container',
      'container_move',
      'archive_container',
      'container_archive',
    ]) {
      const out = transformToolAliasParams(resolveToolId(id), { id: 'x', kind: 'doc' });
      expect(out.kind).toBe('container');
    }
  });

  it('a pin-less allow next to a kind-scoped one still covers every kind', () => {
    const access = { mode: 'allow_list', allowList: ['move_container', 'move'], denyList: [] };
    expect(
      evaluateOpAccess(access, 'node', MOVE_CALL, { callParams: { kind: 'doc' } }).decision
    ).toBe('allow');
  });

  it('a kind-scoped deny stays op-wide (deny never narrows)', () => {
    for (const kind of ['container', 'doc', null]) {
      expect(
        evaluateOpAccess(denyOnly('move_container'), 'node', MOVE_CALL, { callParams: { kind } })
          .decision
      ).toBe('deny');
    }
  });

  it.each(['rename', 'workspace_rename'])('allow %s → rename allowed, move refused', (entry) => {
    expect(evaluateOpAccess(allowOnly(entry), 'node', RENAME_CALL).decision).toBe('allow');
    expect(evaluateOpAccess(allowOnly(entry), 'node', MOVE_CALL).decision).not.toBe('allow');
  });

  it('deny rename → moves still work; deny move → renames still work', () => {
    expect(evaluateOpAccess(denyOnly('rename'), 'node', RENAME_CALL).decision).toBe('deny');
    expect(evaluateOpAccess(denyOnly('rename'), 'node', MOVE_CALL).decision).toBe('allow');
    expect(evaluateOpAccess(denyOnly('move'), 'node', MOVE_CALL).decision).toBe('deny');
    expect(evaluateOpAccess(denyOnly('move'), 'node', RENAME_CALL).decision).toBe('allow');
  });
});

describe('node definition', () => {
  const schema = definition.parameters_schema as {
    properties: Record<string, { enum?: string[] }>;
  };

  it('ops are get | tree | move | rename | archive | restore (no combined update)', () => {
    expect(schema.properties.op.enum).toEqual([
      'get',
      'tree',
      'move',
      'rename',
      'archive',
      'restore',
    ]);
  });

  it('is core, and no op is confirm-gated', () => {
    expect(definition.tier).toBe('core');
    expect(definition.destructive).toBeUndefined();
    expect(definition.destructiveOps).toEqual([]);
  });
});
