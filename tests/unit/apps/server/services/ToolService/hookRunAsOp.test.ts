/**
 * hook(op:run_as) — the agent-facing way to set who a hook runs as. An agent
 * may name only itself, hook code can never change it, and a person at the
 * panel (no agent context) may name any active agent; the registry checks
 * the agent either way.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type Row = { name: string; runAsAgentId: string | null };
let row: Row | null;
const findByName = jest.fn(async () => row);
const setRunAs = jest.fn(async (_name: string, ref: string | null) => {
  if (row) row = { ...row, runAsAgentId: ref };
  return row;
});
const resolveHookRunAsAgent = jest.fn(async (ref: string) =>
  ref === 'test-agent-a' || ref === 'Test Agent A'
    ? { ok: true as const, agent: { id: 'test-agent-a', name: 'Test Agent A' } }
    : { ok: false as const, problem: `no agent "${ref}" exists` }
);

jest.mock('@snaglet/db/tables/hook_registrations', () => ({ HookRegistrations: { findByName } }));
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => ({ setRunAs }),
}));
jest.mock('@server/services/customHooks/HookWorkspaceService', () => ({
  hookWorkspaceService: { updateFiles: jest.fn() },
}));
jest.mock('@server/realtime/surfaces/hookRuns', () => ({ emitHookEnabledChanged: jest.fn() }));
jest.mock('@server/services/customHooks/hookRunAs', () => {
  const actual = jest.requireActual<typeof import('@server/services/customHooks/hookRunAs')>(
    '@server/services/customHooks/hookRunAs'
  );
  return {
    hookRunAsSaveError: actual.hookRunAsSaveError,
    resolveHookRunAsAgent: (ref: string) => resolveHookRunAsAgent(ref),
  };
});

import { setHookRunAs } from '@server/services/ToolService/handlers/hooks/hook-manage';
import hookTool from '@server/services/ToolService/tools/hooks/hook/tool';
import definition from '@server/services/ToolService/tools/hooks/hook/definition';

const parse = (out: unknown) => JSON.parse(out as string) as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  row = { name: 'test-hook', runAsAgentId: null };
});

describe('hook(op:run_as)', () => {
  it('lets an agent set a hook to run as itself, by id or name', async () => {
    const out = parse(
      await setHookRunAs(
        { name: 'test-hook', run_as: 'Test Agent A' },
        {},
        {
          agentId: 'test-agent-a',
        }
      )
    );
    expect(setRunAs).toHaveBeenCalledWith('test-hook', 'test-agent-a');
    expect(out).toMatchObject({ hook_name: 'test-hook', run_as: 'test-agent-a', changed: true });
  });

  it('refuses an agent naming another agent', async () => {
    resolveHookRunAsAgent.mockResolvedValueOnce({
      ok: true,
      agent: { id: 'test-agent-b', name: 'Test Agent B' },
    } as never);
    await expect(
      setHookRunAs({ name: 'test-hook', run_as: 'test-agent-b' }, {}, { agentId: 'test-agent-a' })
    ).rejects.toThrow('An agent can set a hook to run only as itself (test-agent-a)');
    expect(setRunAs).not.toHaveBeenCalled();
  });

  it('refuses a missing agent with the reason', async () => {
    await expect(
      setHookRunAs({ name: 'test-hook', run_as: 'nobody' }, {}, { agentId: 'test-agent-a' })
    ).rejects.toThrow('Can\'t run this hook as "nobody": no agent "nobody" exists.');
  });

  it('never lets hook code change it, not even to clear it', async () => {
    await expect(
      setHookRunAs(
        { name: 'test-hook', run_as: '' },
        {},
        {
          agentId: 'test-agent-a',
          hookOrigin: { kind: 'hook', hookName: 'test-hook' },
        }
      )
    ).rejects.toThrow('Hook code cannot change which agent a hook runs as');
    expect(setRunAs).not.toHaveBeenCalled();
  });

  it('clears it with an empty string or null', async () => {
    row = { name: 'test-hook', runAsAgentId: 'test-agent-a' };
    const out = parse(
      await setHookRunAs({ name: 'test-hook', run_as: '' }, {}, { agentId: 'test-agent-a' })
    );
    expect(setRunAs).toHaveBeenCalledWith('test-hook', null);
    expect(out).toMatchObject({ run_as: null, changed: true });
    await setHookRunAs({ name: 'test-hook', run_as: null }, {}, undefined);
    expect(setRunAs).toHaveBeenLastCalledWith('test-hook', null);
  });

  it("refuses an agent clearing another agent's run as (that would change its identity)", async () => {
    row = { name: 'test-hook', runAsAgentId: 'test-agent-b' };
    await expect(
      setHookRunAs({ name: 'test-hook', run_as: '' }, {}, { agentId: 'test-agent-a' })
    ).rejects.toThrow('an agent can clear only a run as that names itself');
    expect(setRunAs).not.toHaveBeenCalled();
  });

  it('leaves the agent check to the registry for a person at the panel', async () => {
    await setHookRunAs({ name: 'test-hook', run_as: 'test-agent-b' }, {}, undefined);
    expect(resolveHookRunAsAgent).not.toHaveBeenCalled();
    expect(setRunAs).toHaveBeenCalledWith('test-hook', 'test-agent-b');
  });

  it('needs run_as and a registered hook', async () => {
    await expect(setHookRunAs({ name: 'test-hook' }, {}, undefined)).rejects.toThrow(
      'run_as is required'
    );
    row = null;
    await expect(setHookRunAs({ name: 'test-hook', run_as: '' }, {}, undefined)).rejects.toThrow(
      'Hook "test-hook" is not registered'
    );
  });

  it('is routed by the hook tool and asks a guarded agent first', async () => {
    const out = parse(
      await hookTool(
        { op: 'run_as', name: 'test-hook', run_as: 'test-agent-a' },
        {},
        {
          agentId: 'test-agent-a',
        }
      )
    );
    expect(out.run_as).toBe('test-agent-a');
    expect(definition.destructiveOps).toContain('run_as');
  });
});
