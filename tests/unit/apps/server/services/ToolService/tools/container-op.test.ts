/**
 * container(op) — one tool for create_container / update_container. Each op
 * hands its handler exactly the input that alias validates, and a field that
 * belongs only to the other op is refused before any handler runs.
 * `container_id` / `container_path` keep their op-specific meanings (create:
 * the parent; update: the target). The permission block uses the real alias
 * registry: each alias id pins exactly one op.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const calls: Record<string, unknown[]> = {};
function record(name: string, input: unknown) {
  (calls[name] ??= []).push(input);
}

jest.mock('@server/services/ToolService/handlers/containers/createContainer', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('create', input), 'created')),
}));
jest.mock('@server/services/ToolService/handlers/containers/updateContainer', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('update', input), 'updated')),
}));

import containerTool from '@server/services/ToolService/tools/containers/container/tool';
import definition from '@server/services/ToolService/tools/containers/container/definition';
import { evaluateOpAccess, resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';

const run = (input: Record<string, unknown>) => containerTool(input, {}, undefined);

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
});

describe('container(op) dispatch', () => {
  it('create → create_container handler input unchanged, no op', async () => {
    await run({
      op: 'create',
      name: 'N',
      parent_path: '/Snaglet',
      category: 'project',
      folder_path: '/p',
      github_url: 'g',
      sort_order: 2,
    });
    expect(calls.create).toEqual([
      {
        name: 'N',
        parent_path: '/Snaglet',
        category: 'project',
        folder_path: '/p',
        github_url: 'g',
        sort_order: 2,
      },
    ]);
  });

  it('update → update_container handler input (container_id/container_path, present facets only)', async () => {
    await run({ op: 'update', id: 'c-1', description: 'd', folder_path: null });
    await run({ op: 'update', path: '/Snaglet/x', github_url: '' });
    expect(calls.update).toEqual([
      { container_id: 'c-1', description: 'd', folder_path: null },
      { container_path: '/Snaglet/x', github_url: '' },
    ]);
  });

  it('create: container_id means the parent (passed through to create_container)', async () => {
    await run({ op: 'create', name: 'N', container_id: 'parent-1' });
    await run({ op: 'create', name: 'N', container_path: '/Snaglet' });
    expect(calls.create).toEqual([
      { name: 'N', container_id: 'parent-1' },
      { name: 'N', container_path: '/Snaglet' },
    ]);
    expect(calls.update).toBeUndefined();
  });

  it('update: container_id means the target (and wins over id)', async () => {
    await run({ op: 'update', container_id: 'target-1', description: 'd' });
    await run({ op: 'update', container_path: '/Snaglet/t', description: 'd' });
    await run({ op: 'update', container_id: 'target-1', id: 'other', description: 'd' });
    expect(calls.update).toEqual([
      { container_id: 'target-1', description: 'd' },
      { container_path: '/Snaglet/t', description: 'd' },
      { container_id: 'target-1', description: 'd' },
    ]);
    expect(calls.create).toBeUndefined();
  });

  it('refuses a missing or unknown op', async () => {
    await expect(run({ name: 'N' })).rejects.toThrow(/op is required/);
    await expect(run({ op: 'delete', id: 'c-1' })).rejects.toThrow(/create, update/);
    expect(calls).toEqual({});
  });

  it.each([
    ['create', { name: 'N', description: 'd' }, 'description'],
    ['create', { name: 'N', id: 'c-1' }, 'id'],
    ['create', { name: 'N', path: '/Snaglet' }, 'path'],
    ['update', { id: 'c-1', parent_id: 'p' }, 'parent_id'],
    ['update', { id: 'c-1', parent_path: '/Snaglet' }, 'parent_path'],
    ['update', { id: 'c-1', name: 'N' }, 'name'],
    ['update', { id: 'c-1', category: 'project' }, 'category'],
    ['update', { id: 'c-1', sort_order: 1 }, 'sort_order'],
  ])('op %s refuses %j (field %s) before any handler runs', async (op, fields, field) => {
    await expect(run({ op, ...fields })).rejects.toThrow(
      new RegExp(`\`${field}\` belongs to op .*Nothing was changed`)
    );
    expect(calls).toEqual({});
  });
});

describe('container access rules stay op-level (real alias registry)', () => {
  const allowOnly = (entry: string) => ({ mode: 'allow_list', allowList: [entry], denyList: [] });
  const denyOnly = (entry: string) => ({ mode: 'deny_list', allowList: [], denyList: [entry] });
  const verdict = (access: ReturnType<typeof allowOnly>, op: string) =>
    evaluateOpAccess(access as never, 'container', op).decision;

  it.each([
    ['create_container', 'create'],
    ['workspace_create_container', 'create'],
    ['update_container', 'update'],
    ['workspace_update_container', 'update'],
  ])('%s pins container op %s (a conflicting op cannot be smuggled)', (oldId, op) => {
    const resolution = resolveToolId(oldId);
    expect(resolution.id).toBe('container');
    expect(resolution.op).toBe(op);
    const other = op === 'create' ? 'update' : 'create';
    expect(transformToolAliasParams(resolution, { op: other }).op).toBe(op);
  });

  it('allow create_container refuses update', () => {
    expect(verdict(allowOnly('create_container'), 'create')).toBe('allow');
    expect(verdict(allowOnly('create_container'), 'update')).not.toBe('allow');
  });

  it('allow update_container refuses create', () => {
    expect(verdict(allowOnly('update_container'), 'update')).toBe('allow');
    expect(verdict(allowOnly('update_container'), 'create')).not.toBe('allow');
  });

  it('deny either leaves the other working', () => {
    expect(verdict(denyOnly('create_container'), 'create')).toBe('deny');
    expect(verdict(denyOnly('create_container'), 'update')).toBe('allow');
    expect(verdict(denyOnly('update_container'), 'update')).toBe('deny');
    expect(verdict(denyOnly('update_container'), 'create')).toBe('allow');
  });

  it('move/archive of containers stay on node', () => {
    expect(resolveToolId('move_container')).toMatchObject({ id: 'node', op: 'move' });
    expect(resolveToolId('archive_container')).toMatchObject({ id: 'node', op: 'archive' });
  });
});

describe('container definition', () => {
  const schema = definition.parameters_schema as {
    properties: Record<string, { enum?: string[] }>;
  };

  it('ops are create | update', () => {
    expect(schema.properties.op.enum).toEqual(['create', 'update']);
  });

  it('is core and nothing is confirm-gated (neither old tool was destructive)', () => {
    expect(definition.tier).toBe('core');
    expect(definition.destructive).toBeUndefined();
    expect(definition.destructiveOps).toEqual([]);
  });

  it('schema shows id/path only; container_id/container_path stay hidden', () => {
    expect(schema.properties).toHaveProperty('id');
    expect(schema.properties).toHaveProperty('path');
    expect(schema.properties).not.toHaveProperty('container_id');
    expect(schema.properties).not.toHaveProperty('container_path');
    expect(definition.param_aliases).toBeUndefined();
  });
});
