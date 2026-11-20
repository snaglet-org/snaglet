import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const workspaceExists = jest.fn();
const listAllWorkspaces = jest.fn();
jest.mock('@server/services/customHooks/HookWorkspaceService', () => ({
  hookWorkspaceService: { exists: workspaceExists, listAll: listAllWorkspaces },
}));

const listRegistrations = jest.fn();
const runForTest = jest.fn();
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => ({ listRegistrations, runForTest }),
}));

const resolveHookInvocations = jest.fn();
jest.mock('@server/services/customHooks/resolveHookInvocation', () => ({
  resolveHookInvocations,
}));

import { runHookOnDemand } from '@server/services/customHooks/runHookOnDemand';

const ready = {
  id: 'hook-reg-1',
  name: 'daily-digest',
  enabled: true,
  buildStatus: 'ready',
};
const invocation = {
  nodeId: 'run-1',
  eventName: 'run:end',
  event: { runId: 'run-1', status: 'completed' },
  context: { agentId: 'kiwi', threadId: 'thread-1' },
};
const ok = {
  ok: true,
  exitCode: 0,
  durationMs: 4,
  stdout: 'done\n',
  stderr: '',
  timedOut: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  workspaceExists.mockReturnValue(true);
  listAllWorkspaces.mockReturnValue([{ hookName: 'daily-digest' }]);
  listRegistrations.mockResolvedValue([ready] as never);
  resolveHookInvocations.mockResolvedValue([invocation] as never);
  runForTest.mockResolvedValue(ok as never);
});

describe('runHookOnDemand', () => {
  it('resolves by registration id and executes the canonical resolved invocation', async () => {
    const result = await runHookOnDemand('hook-reg-1', {
      nodeIds: 'run-1',
      eventName: 'run:end',
    });

    expect(resolveHookInvocations).toHaveBeenCalledWith('daily-digest', {
      nodeIds: 'run-1',
      eventName: 'run:end',
    });
    expect(runForTest).toHaveBeenCalledWith({
      hookName: 'daily-digest',
      eventName: 'run:end',
      event: invocation.event,
      context: invocation.context,
    });
    expect(result).toEqual({
      hookName: 'daily-digest',
      runs: [
        {
          nodeId: invocation.nodeId,
          eventName: invocation.eventName,
          event: invocation.event,
          result: ok,
        },
      ],
    });
  });

  it('refuses a disabled hook unless force is explicit', async () => {
    listRegistrations.mockResolvedValue([{ ...ready, enabled: false }] as never);

    await expect(runHookOnDemand('daily-digest', {})).rejects.toThrow(
      'Hook "daily-digest" is disabled. Pass force: true'
    );
    expect(resolveHookInvocations).not.toHaveBeenCalled();
    expect(runForTest).not.toHaveBeenCalled();

    await runHookOnDemand('daily-digest', { force: true });
    expect(runForTest).toHaveBeenCalledTimes(1);
  });

  it('preserves the Hook Builder compatibility override for disabled hooks', async () => {
    listRegistrations.mockResolvedValue([{ ...ready, enabled: false }] as never);

    await runHookOnDemand('daily-digest', {}, { allowDisabled: true });

    expect(runForTest).toHaveBeenCalledTimes(1);
  });

  it('fails unknown hooks before payload resolution and lists near-name suggestions', async () => {
    workspaceExists.mockReturnValue(false);
    listAllWorkspaces.mockReturnValue([
      { hookName: 'daily-summary' },
      { hookName: 'weekly-digest' },
    ]);

    await expect(runHookOnDemand('daily-digset', {})).rejects.toThrow(
      /Hook not found: daily-digset\. Did you mean: daily-digest/
    );
    expect(resolveHookInvocations).not.toHaveBeenCalled();
    expect(runForTest).not.toHaveBeenCalled();
  });

  it('can bind child-dispatch agent identity over resolved context', async () => {
    await runHookOnDemand(
      'daily-digest',
      { nodeIds: 'run-1' },
      { contextAgentId: 'calling-agent' }
    );

    expect(runForTest).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { agentId: 'calling-agent', threadId: 'thread-1' },
      })
    );
  });
});
