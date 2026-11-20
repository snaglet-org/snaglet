import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runHookOnDemand = jest.fn();
jest.mock('@server/services/customHooks/runHookOnDemand', () => ({ runHookOnDemand }));

import execute from '@server/services/ToolService/handlers/hooks/hook-run';

const OK = {
  hookName: 'daily-digest',
  runs: [
    {
      nodeId: 'message-1',
      eventName: 'message:create',
      event: { id: 'message-1' },
      result: {
        ok: true,
        exitCode: 0,
        durationMs: 5,
        stdout: 'done\n',
        stderr: '',
        timedOut: false,
      },
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  runHookOnDemand.mockResolvedValue(OK as never);
});

describe('hook tool, op run', () => {
  it('maps an explicit message_id to the canonical UI resolver input', async () => {
    const output = await execute(
      { hook_id_or_name: 'daily-digest', message_id: 'message-1' },
      {},
      { agentId: 'calling-agent' }
    );

    expect(runHookOnDemand).toHaveBeenCalledWith(
      'daily-digest',
      {
        nodeIds: 'message-1',
        eventName: 'message:create',
        event: undefined,
        force: false,
      },
      { contextAgentId: 'calling-agent' }
    );
    expect(JSON.parse(output as string)).toEqual(OK);
  });

  it('preserves user-mode execution when no invoking agent context exists', async () => {
    await execute({ hook_id_or_name: 'daily-digest', message_id: 'message-1' }, {});

    expect(runHookOnDemand).toHaveBeenCalledWith(
      'daily-digest',
      expect.objectContaining({ nodeIds: 'message-1', eventName: 'message:create' }),
      { contextAgentId: undefined }
    );
  });

  it('accepts run_id and an explicit agent lifecycle event', async () => {
    await execute({ hook_id_or_name: 'audit', run_id: 'run-1' }, {});
    expect(runHookOnDemand).toHaveBeenLastCalledWith(
      'audit',
      expect.objectContaining({ nodeIds: 'run-1', eventName: 'run:end' }),
      { contextAgentId: undefined }
    );

    await execute({ hook_id_or_name: 'audit', agent_id: 'kiwi', event_name: 'agent:update' }, {});
    expect(runHookOnDemand).toHaveBeenLastCalledWith(
      'audit',
      expect.objectContaining({ nodeIds: 'kiwi', eventName: 'agent:update' }),
      { contextAgentId: undefined }
    );
  });

  it('passes force only when explicitly true', async () => {
    await execute({ hook_id_or_name: 'daily-digest', force: true }, {});
    expect(runHookOnDemand).toHaveBeenCalledWith(
      'daily-digest',
      expect.objectContaining({ force: true }),
      { contextAgentId: undefined }
    );
  });

  it('rejects multiple ids, id+payload, and mismatched id/event combinations before execution', async () => {
    await expect(
      execute({ hook_id_or_name: 'audit', message_id: 'message-1', run_id: 'run-1' }, {})
    ).rejects.toThrow('Pass exactly one mock entity ID');
    await expect(
      execute({ hook_id_or_name: 'audit', message_id: 'message-1', payload: { id: 'fake' } }, {})
    ).rejects.toThrow('mock entity ID or payload');
    await expect(
      execute({ hook_id_or_name: 'audit', message_id: 'message-1', event_name: 'run:end' }, {})
    ).rejects.toThrow('message_id cannot resolve run:end');
    await expect(execute({ hook_id_or_name: 'audit', table_id: 'table-1' }, {})).rejects.toThrow(
      'table_id requires entry_id'
    );
    await expect(
      execute({ hook_id_or_name: 'audit', message_id: 'message-1', entry_id: 'entry-1' }, {})
    ).rejects.toThrow('entry_id goes with table_id');
    await expect(
      execute(
        {
          hook_id_or_name: 'audit',
          table_id: 'table-1',
          entry_id: 'entry-1',
          event_name: 'doc:edit',
        },
        {}
      )
    ).rejects.toThrow('table_id cannot resolve doc:edit');
    expect(runHookOnDemand).not.toHaveBeenCalled();
  });
});
