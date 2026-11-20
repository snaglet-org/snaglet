/**
 * table(op) — table_read / table_write / table_schema / table_delete as one
 * tool. Each op hands its handler exactly the input that alias takes (minus
 * `op`), and a field that belongs only to another op is refused before any
 * handler runs. The permission block uses the real alias registry: each alias
 * id (including table_list) pins exactly one op, so allow/deny naming one
 * never covers another.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const log: string[] = [];
const calls: Record<string, unknown[]> = {};
function record(name: string, input: unknown) {
  log.push(name);
  (calls[name] ??= []).push(input);
}

jest.mock('@server/services/ToolService/handlers/tables/tableRead', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('read', input), 'read')),
}));
jest.mock('@server/services/ToolService/handlers/tables/tableWrite', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('write', input), 'written')),
}));
jest.mock('@server/services/ToolService/handlers/tables/tableSchema', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('schema', input), 'schema')),
}));
jest.mock('@server/services/ToolService/handlers/tables/tableDelete', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('delete', input), 'deleted')),
}));

import tableTool from '@server/services/ToolService/tools/tables/table/tool';
import definition from '@server/services/ToolService/tools/tables/table/definition';
import { evaluateOpAccess, resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';

const run = (input: Record<string, unknown>) => tableTool(input, {}, undefined);

beforeEach(() => {
  log.length = 0;
  for (const k of Object.keys(calls)) delete calls[k];
});

describe('table(op) dispatch', () => {
  it('read → table_read handler input, unchanged minus op', async () => {
    await run({ op: 'read' });
    await run({ op: 'read', table: 'tasks', ids: ['a'] });
    await run({ op: 'read', sql: 'SELECT 1', limit: 5, max_cell: 100 });
    expect(calls.read).toEqual([
      {},
      { table: 'tasks', ids: ['a'] },
      { sql: 'SELECT 1', limit: 5, max_cell: 100 },
    ]);
  });

  it('read passes the structured row keys through; other ops refuse them', async () => {
    const structured = {
      table: 'tasks',
      where: [{ field: 'status', operator: 'is', value: 'todo' }],
      sort: [{ field: 'due', direction: 'asc' }],
      columns: ['status'],
      page: 2,
      limit: 10,
    };
    await run({ op: 'read', ...structured });
    expect(calls.read).toEqual([structured]);
    await expect(run({ op: 'write', table: 'tasks', insert: [], where: [] })).rejects.toThrow(
      /`where` belongs to op read/
    );
    await expect(run({ op: 'delete', table: 'tasks', ids: ['e1'], page: 1 })).rejects.toThrow(
      /`page` belongs to op read/
    );
  });

  it('read still passes the retired table_list `origin` through (ignored by the handler)', async () => {
    await run({ op: 'read', origin: 'x' });
    expect(calls.read).toEqual([{ origin: 'x' }]);
  });

  it('write → table_write handler input (insert/update unchanged)', async () => {
    const insert = [{ values: { name: 'a' }, id: 'u1', before: 'e0' }];
    const update = [{ id: 'e1', rev: 'r', values: { status: 'Done' } }];
    await run({ op: 'write', table: 'tasks', insert, update });
    expect(calls.write).toEqual([{ table: 'tasks', insert, update }]);
  });

  it('write passes repeat changes through; another op refuses them', async () => {
    const repeat = [{ id: 'e1', field: 'due', done: true }];
    await run({ op: 'write', table: 'tasks', repeat });
    expect(calls.write).toEqual([{ table: 'tasks', repeat }]);
    await expect(run({ op: 'delete', table: 'tasks', ids: ['e1'], repeat })).rejects.toThrow(
      /`repeat` belongs to op write/
    );
  });

  it('schema → table_schema handler input (fields/ops unchanged)', async () => {
    const fields = [{ name: 'due', type: 'date' }];
    const ops = [{ op: 'rename_table', name: 'todo' }];
    await run({ op: 'schema', table: 'tasks', fields });
    await run({ op: 'schema', table: 'tasks', ops });
    expect(calls.schema).toEqual([
      { table: 'tasks', fields },
      { table: 'tasks', ops },
    ]);
  });

  it('delete → table_delete handler input (ids, clear_links)', async () => {
    await run({ op: 'delete', table: 'tasks', ids: ['e1'], clear_links: true });
    expect(calls.delete).toEqual([{ table: 'tasks', ids: ['e1'], clear_links: true }]);
  });

  it('refuses a missing or unknown op', async () => {
    await expect(run({ table: 'tasks' })).rejects.toThrow('op is required');
    await expect(run({ op: 'bogus', sql: 'SELECT 1' })).rejects.toThrow('op is required');
    expect(log).toEqual([]);
  });

  it.each([
    ['read', { table: 'tasks', insert: [] }],
    ['read', { table: 'tasks', ops: [] }],
    ['read', { table: 'tasks', clear_links: true }],
    ['write', { table: 'tasks', ids: ['e1'] }],
    ['write', { table: 'tasks', sql: 'SELECT 1' }],
    ['write', { table: 'tasks', fields: [] }],
    ['schema', { table: 'tasks', update: [] }],
    ['schema', { table: 'tasks', ids: ['e1'] }],
    ['delete', { table: 'tasks', ids: ['e1'], insert: [] }],
    ['delete', { table: 'tasks', ids: ['e1'], ops: [{ op: 'delete_table' }] }],
    ['delete', { table: 'tasks', ids: ['e1'], sql: 'SELECT 1' }],
  ])('%s refuses another op’s field %j before anything runs', async (op, extra) => {
    await expect(run({ op, ...extra })).rejects.toThrow('Nothing was changed');
    expect(log).toEqual([]);
  });
});

describe('table access rules stay op-level (real alias registry)', () => {
  const opOf = (oldId: string, params: Record<string, unknown> = {}) =>
    transformToolAliasParams(resolveToolId(oldId), params).op as string;
  const allowOnly = (entry: string) => ({ mode: 'allow_list', allowList: [entry], denyList: [] });
  const denyOnly = (entry: string) => ({ mode: 'deny_list', allowList: [], denyList: [entry] });
  const verdict = (access: ReturnType<typeof allowOnly>, op: string) =>
    evaluateOpAccess(access as never, 'table', op).decision;
  const OPS = ['read', 'write', 'schema', 'delete'];

  it.each([
    ['table_read', 'read'],
    ['table_list', 'read'],
    ['table_write', 'write'],
    ['table_schema', 'schema'],
    ['table_delete', 'delete'],
  ])('%s pins table op %s (a conflicting op cannot be smuggled)', (oldId, op) => {
    expect(resolveToolId(oldId).id).toBe('table');
    expect(resolveToolId(oldId).op).toBe(op);
    expect(opOf(oldId, { op: 'delete' })).toBe(op);
    expect(opOf(oldId, { op: 'schema' })).toBe(op);
  });

  // Probe: every alias id × every op, allow and deny.
  it.each([
    ['table_read', 'read'],
    ['table_list', 'read'],
    ['table_write', 'write'],
    ['table_schema', 'schema'],
    ['table_delete', 'delete'],
  ])('allow %s grants only %s; deny %s blocks only %s', (oldId, pinned) => {
    for (const op of OPS) {
      if (op === pinned) {
        expect(verdict(allowOnly(oldId), op)).toBe('allow');
        expect(verdict(denyOnly(oldId), op)).toBe('deny');
      } else {
        expect(verdict(allowOnly(oldId), op)).not.toBe('allow');
        expect(verdict(denyOnly(oldId), op)).toBe('allow');
      }
    }
  });

  it('allow table_read refuses write, schema and delete', () => {
    for (const op of ['write', 'schema', 'delete']) {
      expect(verdict(allowOnly('table_read'), op)).not.toBe('allow');
    }
  });

  it('deny table_delete leaves read, write and schema working', () => {
    expect(verdict(denyOnly('table_delete'), 'delete')).toBe('deny');
    for (const op of ['read', 'write', 'schema']) {
      expect(verdict(denyOnly('table_delete'), op)).toBe('allow');
    }
  });

  it('the older removed table_* ids still return a removal message naming table', () => {
    for (const id of [
      'table_create',
      'table_rename',
      'table_field_create',
      'table_field_update',
      'table_entries_list',
      'table_entry_get',
      'table_entry_create',
      'table_entry_update',
    ]) {
      const resolved = resolveToolId(id);
      expect(resolved.removed).toMatch(/table \{op: "(read|write|schema)"/);
    }
  });

  it('database_* tools are not table ops (they stay their own tools)', () => {
    for (const id of ['database_query', 'database_execute', 'create_view']) {
      expect(resolveToolId(id).id).toBe(id);
    }
  });
});

describe('table definition', () => {
  const schema = definition.parameters_schema as {
    properties: Record<string, { enum?: string[] }>;
  };

  it('ops are read | fields | query | write | schema | delete', () => {
    expect(schema.properties.op.enum).toEqual([
      'read',
      'fields',
      'query',
      'write',
      'schema',
      'delete',
    ]);
  });

  it('is core, and only delete is confirm-gated (as table_delete was)', () => {
    expect(definition.tier).toBe('core');
    expect(definition.destructive).toBe(false);
    expect(definition.destructiveOps).toEqual(['delete']);
  });
});
