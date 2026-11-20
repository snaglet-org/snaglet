/**
 * agent(op), model(op), mcp(op) — entity tools with the verb as `op`.
 *
 * Dispatch: each op hands its handler its alias's input (minus `op`), and a
 * field that belongs only to another op is refused before any handler runs.
 * Permissions use the real alias registry: each alias id pins exactly one op,
 * and ids that also pin a view/scope/operation keep it pinned.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const calls: Record<string, unknown[]> = {};
function record(name: string, input: unknown) {
  (calls[name] ??= []).push(input);
  return Promise.resolve(name);
}

const handlerMock = (name: string) => ({
  __esModule: true,
  default: (input: unknown) => record(name, input),
});
jest.mock('@server/services/ToolService/handlers/agents/createAgent', () => handlerMock('create'));
jest.mock('@server/services/ToolService/handlers/agents/agentGet', () => handlerMock('get'));
jest.mock('@server/services/ToolService/handlers/agents/agentUpdate', () => handlerMock('update'));
jest.mock('@server/services/ToolService/handlers/agents/abortAgentRun', () => handlerMock('abort'));
jest.mock('@server/services/ToolService/handlers/agents/agentActivity', () =>
  handlerMock('activity')
);
jest.mock('@server/services/ToolService/handlers/agents/agentLifecycle', () => ({
  archiveAgent: (input: unknown) => record('archive', input),
  restoreAgent: (input: unknown) => record('restore', input),
}));
jest.mock('@server/services/ToolService/handlers/agents/listModels', () => handlerMock('list'));
jest.mock('@server/services/ToolService/handlers/agents/addModel', () => handlerMock('add'));
jest.mock('@server/services/ToolService/handlers/agents/mcp', () => ({
  listServers: (input: unknown) => record('mcp.list', input),
  getServer: (input: unknown) => record('mcp.get', input),
  createServer: (input: unknown) => record('mcp.create', input),
  updateServer: (input: unknown) => record('mcp.update', input),
  deleteServer: (input: unknown) => record('mcp.delete', input),
  restoreServer: (input: unknown) => record('mcp.restore', input),
  testServer: (input: unknown) => record('mcp.test', input),
  setServerCredential: (input: unknown) => record('mcp.set_credential', input),
}));

import agentTool from '@server/services/ToolService/tools/agents/agent/tool';
import agentDefinition from '@server/services/ToolService/tools/agents/agent/definition';
import modelTool from '@server/services/ToolService/tools/agents/model/tool';
import modelDefinition from '@server/services/ToolService/tools/agents/model/definition';
import mcpTool from '@server/services/ToolService/tools/agents/mcp/tool';
import mcpDefinition from '@server/services/ToolService/tools/agents/mcp/definition';
import { evaluateOpAccess, resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
});

const opEnum = (def: { parameters_schema: Record<string, unknown> }) =>
  (def.parameters_schema.properties as Record<string, { enum?: string[] }>).op.enum;

describe('agent(op) dispatch', () => {
  const run = (input: Record<string, unknown>) => agentTool(input, {}, undefined);

  it('ops are create | get | list | update | archive | restore | abort | activity', () => {
    expect(opEnum(agentDefinition)).toEqual([
      'create',
      'get',
      'list',
      'update',
      'archive',
      'restore',
      'abort',
      'activity',
    ]);
  });

  it('create passes fields through without op', async () => {
    await run({ op: 'create', name: 'N', role: 'R', skills: ['tdd'] });
    expect(calls.create).toEqual([{ name: 'N', role: 'R', skills: ['tdd'] }]);
  });

  it('get maps agent_id to `agent` and keeps view', async () => {
    await run({ op: 'get', agent_id: 'venus' });
    await run({ op: 'get', view: 'runtime_self' });
    expect(calls.get).toEqual([{ agent: 'venus' }, { view: 'runtime_self' }]);
  });

  it('get keeps the old get_agent roster form', async () => {
    await run({ op: 'get', listAll: true, includeArchived: true });
    expect(calls.get).toEqual([{ listAll: true, includeArchived: true }]);
  });

  it('list is the roster (listAll) with include_archived mapped', async () => {
    await run({ op: 'list' });
    await run({ op: 'list', include_archived: true });
    expect(calls.get).toEqual([{ listAll: true }, { listAll: true, includeArchived: true }]);
  });

  it('update / abort / activity / archive / restore reach their handlers', async () => {
    await run({ op: 'update', agent_id: 'a', add_skills: ['x'] });
    await run({ op: 'abort', agent_id: 'a', thread_id: 't' });
    await run({ op: 'activity', view: 'self_recent' });
    await run({ op: 'archive', agent_id: 'a' });
    await run({ op: 'restore', agent_id: 'a' });
    expect(calls.update).toEqual([{ agent_id: 'a', add_skills: ['x'] }]);
    expect(calls.abort).toEqual([{ agent_id: 'a', thread_id: 't' }]);
    expect(calls.activity).toEqual([{ view: 'self_recent' }]);
    expect(calls.archive).toEqual([{ op: 'archive', agent_id: 'a' }]);
    expect(calls.restore).toEqual([{ op: 'restore', agent_id: 'a' }]);
  });

  it('refuses a field that belongs only to another op, before any handler runs', async () => {
    await expect(run({ op: 'archive', agent_id: 'a', name: 'X' })).rejects.toThrow(
      /`name` belongs to op/
    );
    await expect(run({ op: 'create', name: 'N', role: 'R', add_skills: ['x'] })).rejects.toThrow(
      /`add_skills` belongs to op update/
    );
    expect(calls).toEqual({});
  });

  it('rejects a missing or unknown op', async () => {
    await expect(run({ name: 'N' })).rejects.toThrow(/op is required/);
    await expect(run({ op: 'delete', agent_id: 'a' })).rejects.toThrow(/op is required/);
  });
});

describe('model(op) dispatch', () => {
  const run = (input: Record<string, unknown>) => modelTool(input, {}, undefined);

  it('ops are list | add', () => {
    expect(opEnum(modelDefinition)).toEqual(['list', 'add']);
  });

  it('list and add reach their handlers without op', async () => {
    await run({ op: 'list', operation: 'models', provider_id: 'openai' });
    await run({ op: 'add', provider_id: 'openai', model_id: 'gpt-x' });
    expect(calls.list).toEqual([{ operation: 'models', provider_id: 'openai' }]);
    expect(calls.add).toEqual([{ provider_id: 'openai', model_id: 'gpt-x' }]);
  });

  it('refuses add fields on list', async () => {
    await expect(run({ op: 'list', model_id: 'gpt-x' })).rejects.toThrow(/belongs to op add/);
    expect(calls).toEqual({});
  });
});

describe('mcp(op) dispatch', () => {
  const run = (input: Record<string, unknown>) => mcpTool(input, {}, undefined);

  it('ops cover the whole server lifecycle', () => {
    expect(opEnum(mcpDefinition)).toEqual([
      'list',
      'get',
      'create',
      'update',
      'delete',
      'restore',
      'test',
      'set_credential',
    ]);
  });

  // restore only puts back, exactly, a server the caller deleted minutes ago.
  it('confirm-gates every write op, not the reads, test or restore', () => {
    expect(mcpDefinition.destructiveOps).toEqual(['create', 'update', 'delete', 'set_credential']);
  });

  it.each(['list', 'get', 'create', 'update', 'delete', 'restore', 'test', 'set_credential'])(
    'op %s reaches its handler',
    async (op) => {
      await run({ op, id: 'srv' });
      expect(Object.keys(calls)).toEqual([`mcp.${op}`]);
    }
  );

  it('refuses a secret outside set_credential and config outside create/update', async () => {
    await expect(run({ op: 'create', id: 's', name: 'S', secret: 'x' })).rejects.toThrow(
      /`secret` belongs to op set_credential/
    );
    await expect(run({ op: 'delete', id: 's', command: 'rm' })).rejects.toThrow(
      /`command` belongs to op/
    );
    expect(calls).toEqual({});
  });
});

describe('old ids are op-pinned aliases (real alias registry)', () => {
  it.each([
    ['create_agent', 'agent', 'create'],
    ['get_agent', 'agent', 'get'],
    ['update_agent', 'agent', 'update'],
    ['abort_agent_run', 'agent', 'abort'],
    ['agent_activity', 'agent', 'activity'],
    ['self_inspect', 'agent', 'get'],
    ['update_identity', 'agent', 'update'],
    ['my_activity', 'agent', 'activity'],
    ['run_history', 'agent', 'activity'],
    ['agent_recent_activity', 'agent', 'activity'],
    ['list_models', 'model', 'list'],
    ['add_model', 'model', 'add'],
    ['get_providers', 'model', 'list'],
    ['get_provider_models', 'model', 'list'],
    ['list_mcp_servers', 'mcp', 'list'],
    ['add_mcp_server', 'mcp', 'create'],
    ['update_mcp_server', 'mcp', 'update'],
  ])('%s → %s op %s, and the op cannot be smuggled', (oldId, id, op) => {
    const resolution = resolveToolId(oldId);
    expect(resolution).toMatchObject({ id, op });
    expect(transformToolAliasParams(resolution, { op: 'archive' }).op).toBe(op);
  });

  it('keeps the pinned discriminators the old ids carried', () => {
    const pinned = (id: string, params: Record<string, unknown>) =>
      transformToolAliasParams(resolveToolId(id), params);
    expect(pinned('self_inspect', { view: 'record' }).view).toBe('runtime_self');
    expect(pinned('update_identity', { scope: 'agent' }).scope).toBe('self');
    expect(pinned('my_activity', {}).view).toBe('self_recent');
    expect(pinned('run_history', {}).view).toBe('self_history');
    expect(pinned('agent_recent_activity', {}).view).toBe('agent');
    expect(pinned('get_providers', {}).operation).toBe('providers');
    expect(pinned('get_provider_models', {}).operation).toBe('models');
  });

  it('an allow rule naming an old id grants only its op', () => {
    const allowOnly = (entry: string) => ({ mode: 'allow_list', allowList: [entry], denyList: [] });
    const verdict = (entry: string, tool: string, op: string) =>
      evaluateOpAccess(allowOnly(entry) as never, tool, op).decision;
    expect(verdict('get_agent', 'agent', 'get')).toBe('allow');
    expect(verdict('get_agent', 'agent', 'update')).not.toBe('allow');
    expect(verdict('get_agent', 'agent', 'archive')).not.toBe('allow');
    expect(verdict('list_models', 'model', 'list')).toBe('allow');
    expect(verdict('list_models', 'model', 'add')).not.toBe('allow');
  });
});
