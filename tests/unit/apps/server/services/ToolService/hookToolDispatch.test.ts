import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createHandler = jest.fn(async () => 'created');
const runHandler = jest.fn(async () => 'ran');
const updateHook = jest.fn(async () => 'updated');
const enableHook = jest.fn(async () => 'enabled');
const disableHook = jest.fn(async () => 'disabled');
jest.mock('@server/services/ToolService/handlers/hooks/hook-create', () => ({
  __esModule: true,
  default: createHandler,
}));
jest.mock('@server/services/ToolService/handlers/hooks/hook-run', () => ({
  __esModule: true,
  default: runHandler,
}));
jest.mock('@server/services/ToolService/handlers/hooks/hook-manage', () => ({
  updateHook,
  enableHook,
  disableHook,
}));

import hook from '@server/services/ToolService/tools/hooks/hook/tool';
import { resolveToolId } from '@snaglet/shared/utils/toolAliases';

beforeEach(() => jest.clearAllMocks());

describe('hook(op) dispatcher', () => {
  it('routes each of the five ops to its handler', async () => {
    await hook(
      { op: 'create', name: 'a-hook', description: 'd', events: ['message:create'] },
      {},
      undefined
    );
    await hook({ op: 'run', hook_id_or_name: 'a-hook' }, {}, undefined);
    await hook({ op: 'update', name: 'a-hook', hook_source: 'src' }, {}, undefined);
    await hook({ op: 'enable', name: 'a-hook' }, {}, undefined);
    await hook({ op: 'disable', name: 'a-hook' }, {}, undefined);
    expect(createHandler).toHaveBeenCalledTimes(1);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(updateHook).toHaveBeenCalledTimes(1);
    expect(enableHook).toHaveBeenCalledTimes(1);
    expect(disableHook).toHaveBeenCalledTimes(1);
  });

  it('forwards op-stripped input unchanged', async () => {
    await hook({ op: 'run', hook_id_or_name: 'a-hook', force: true }, {}, undefined);
    expect(runHandler).toHaveBeenCalledWith(
      { hook_id_or_name: 'a-hook', force: true },
      {},
      undefined
    );
  });

  it('rejects missing, unknown, and cross-op fields', async () => {
    await expect(hook({ name: 'a-hook' }, {}, undefined)).rejects.toThrow('op is required');
    await expect(hook({ op: 'delete', name: 'a-hook' }, {}, undefined)).rejects.toThrow(
      'unsupported op'
    );
    await expect(
      hook({ op: 'enable', name: 'a-hook', hook_source: 'x' }, {}, undefined)
    ).rejects.toThrow('hook_source');
    await expect(hook({ op: 'update', name: 'a-hook' }, {}, undefined)).rejects.toThrow(
      'hook_source'
    );
    await expect(hook({ op: 'run' }, {}, undefined)).rejects.toThrow('hook_id_or_name');
    expect(enableHook).not.toHaveBeenCalled();
  });

  it('legacy ids route through the pinned alias to the same handlers', async () => {
    const run = resolveToolId('run_hook').transformParams?.({
      hook_id_or_name: 'a-hook',
      op: 'disable',
    });
    await hook(run as Record<string, unknown>, {}, undefined);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(disableHook).not.toHaveBeenCalled();
    const create = resolveToolId('create_hook').transformParams?.({
      name: 'a-hook',
      description: 'd',
      events: ['message:create'],
    });
    await hook(create as Record<string, unknown>, {}, undefined);
    expect(createHandler).toHaveBeenCalledTimes(1);
  });
});
