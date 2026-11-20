/**
 * Run as: which agents a hook may act as, how the registry stores the
 * setting, and that a dispatched event carries it to the runner. The runner's
 * own handling (credential, child context, refusals) is in
 * hookRunner.runAs.test.ts.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/settings/settingsService', () => ({
  settingsService: { read: async () => true },
}));
jest.mock('@server/services/subagents/helperVisibility', () => ({
  isHelperThread: async () => false,
  isHelperAgent: async () => false,
  isKnownHelperThread: () => false,
  isKnownHelperAgent: () => false,
}));

import { Agents, type AgentRow } from '@snaglet/db/tables/agents';
import { HookRegistrations, type HookRegistrationRow } from '@snaglet/db/tables/hook_registrations';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import {
  checkHookRunAsAgent,
  hookRunAsProblem,
  resolveHookRunAsAgent,
} from '@server/services/customHooks/hookRunAs';
import {
  HookRegistryService,
  onDemandRunsAs,
} from '@server/services/customHooks/HookRegistryService';
import type { HookRunContext } from '@server/services/customHooks/hookRunner';
import { hooks, type HookEvent } from '@server/services/HookService';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';

function agent(over: Partial<AgentRow> & Pick<AgentRow, 'id' | 'name'>): AgentRow {
  return { archived: false, archivedAt: null, parentAgentId: null, ...over } as AgentRow;
}

const AGENTS: Record<string, AgentRow> = {
  [AGENT_A]: agent({ id: AGENT_A, name: 'Test Agent A' }),
  [AGENT_B]: agent({ id: AGENT_B, name: 'Test Agent B', archived: true, archivedAt: 'x' }),
  'test-helper': agent({ id: 'test-helper', name: 'Helper', parentAgentId: AGENT_A }),
  [GHOST_AGENT_ID]: agent({ id: GHOST_AGENT_ID, name: 'ghost' }),
};

function registrationRow(runAsAgentId: string | null): HookRegistrationRow {
  return {
    id: 'hook_1',
    name: 'test-hook',
    sourcePath: '/nonexistent/test-hook/hook.ts',
    enabled: true,
    runAsAgentId,
    runAsBuildHash: runAsAgentId ? 'build-a' : null,
    buildStatus: 'ready',
    sourceHash: null,
    buildHash: null,
    sdkHash: null,
    builtPath: null,
    lastError: null,
    lastBuiltAt: null,
    createdAt: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  jest.spyOn(Agents, 'findById').mockImplementation(async (id: string) => AGENTS[id] ?? null);
  jest
    .spyOn(Agents, 'findByName')
    .mockImplementation(
      async (name: string) =>
        Object.values(AGENTS).find(
          (row) => row.name.toLowerCase() === name.toLowerCase() && !row.parentAgentId
        ) ?? null
    );
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('hookRunAsProblem', () => {
  it('accepts an active top-level agent', () => {
    expect(hookRunAsProblem(AGENTS[AGENT_A], AGENT_A)).toBeNull();
  });

  it('names a missing, archived, helper or ghost agent', () => {
    expect(hookRunAsProblem(null, 'test-agent-gone')).toBe('no agent "test-agent-gone" exists');
    expect(hookRunAsProblem(AGENTS[AGENT_B], AGENT_B)).toBe('agent "Test Agent B" is archived');
    expect(hookRunAsProblem(AGENTS['test-helper'], 'test-helper')).toContain('subagent helper');
    expect(hookRunAsProblem(AGENTS[GHOST_AGENT_ID], GHOST_AGENT_ID)).toContain('ghost');
  });
});

describe('resolveHookRunAsAgent / checkHookRunAsAgent', () => {
  it('resolves an agent by id or by name', async () => {
    await expect(resolveHookRunAsAgent(AGENT_A)).resolves.toMatchObject({
      ok: true,
      agent: { id: AGENT_A },
    });
    await expect(resolveHookRunAsAgent(' test agent a ')).resolves.toMatchObject({
      ok: true,
      agent: { id: AGENT_A },
    });
  });

  it('refuses an archived or unknown agent', async () => {
    await expect(resolveHookRunAsAgent(AGENT_B)).resolves.toEqual({
      ok: false,
      problem: 'agent "Test Agent B" is archived',
    });
    await expect(resolveHookRunAsAgent('nobody')).resolves.toEqual({
      ok: false,
      problem: 'no agent "nobody" exists',
    });
  });

  it('re-checks at run time: an agent archived or deleted since is refused', async () => {
    await expect(checkHookRunAsAgent(AGENT_A)).resolves.toBeNull();
    await expect(checkHookRunAsAgent(AGENT_B)).resolves.toBe('agent "Test Agent B" is archived');
    await expect(checkHookRunAsAgent('test-agent-gone')).resolves.toBe(
      'no agent "test-agent-gone" exists'
    );
  });
});

describe('HookRegistryService.setRunAs', () => {
  it('stores the resolved agent id', async () => {
    const setRunAs = jest
      .spyOn(HookRegistrations, 'setRunAs')
      .mockResolvedValue(registrationRow(AGENT_A));
    const registry = new HookRegistryService({ dir: '/nonexistent/snaglet-test-hooks' });

    const row = await registry.setRunAs('test-hook', 'Test Agent A');

    expect(setRunAs).toHaveBeenCalledWith('test-hook', AGENT_A);
    expect(row?.runAsAgentId).toBe(AGENT_A);
  });

  it('clears it with null or a blank name', async () => {
    const setRunAs = jest
      .spyOn(HookRegistrations, 'setRunAs')
      .mockResolvedValue(registrationRow(null));
    const registry = new HookRegistryService({ dir: '/nonexistent/snaglet-test-hooks' });

    await registry.setRunAs('test-hook', null);
    await registry.setRunAs('test-hook', '  ');

    expect(setRunAs).toHaveBeenNthCalledWith(1, 'test-hook', null);
    expect(setRunAs).toHaveBeenNthCalledWith(2, 'test-hook', null);
  });

  it('refuses a hook with no ready build with a 409 (run as covers a build)', async () => {
    jest.spyOn(HookRegistrations, 'setRunAs').mockResolvedValue(null);
    jest
      .spyOn(HookRegistrations, 'findByName')
      .mockResolvedValue({ ...registrationRow(null), buildStatus: 'building' });
    const registry = new HookRegistryService({ dir: '/nonexistent/snaglet-test-hooks' });

    await expect(registry.setRunAs('test-hook', AGENT_A)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('refuses an archived, missing or ghost agent with a 400 and writes nothing', async () => {
    const setRunAs = jest.spyOn(HookRegistrations, 'setRunAs');
    const registry = new HookRegistryService({ dir: '/nonexistent/snaglet-test-hooks' });

    await expect(registry.setRunAs('test-hook', AGENT_B)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Can\'t run this hook as "test-agent-b": agent "Test Agent B" is archived.',
    });
    await expect(registry.setRunAs('test-hook', 'test-agent-gone')).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(registry.setRunAs('test-hook', GHOST_AGENT_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(setRunAs).not.toHaveBeenCalled();
  });
});

describe('HookRegistryService dispatch carries run as', () => {
  interface DispatchProbe {
    dispatch(
      reg: {
        name: string;
        dir: string;
        builtPath: string;
        filter: null;
        runAsAgentId: string | null;
        runAsBuildHash: string | null;
      },
      eventName: HookEvent,
      payload: unknown
    ): void;
  }

  async function contextFor(
    runAsAgentId: string | null,
    payload: Record<string, unknown>
  ): Promise<HookRunContext | undefined> {
    const registry = new HookRegistryService({ dir: '/nonexistent/snaglet-test-hooks' });
    const run = jest.spyOn(registry.getRunner(), 'run').mockResolvedValue(undefined);
    (registry as unknown as DispatchProbe).dispatch(
      {
        name: 'test-hook',
        dir: '/nonexistent',
        builtPath: '/nonexistent/hook.cjs',
        filter: null,
        runAsAgentId,
        runAsBuildHash: runAsAgentId ? 'build-a' : null,
      },
      'table_entry:update',
      payload
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return run.mock.calls[0]?.[0].context;
  }

  const rowEdit = { tableId: 'table-1111111111111-aaaaaaaaa', entryId: 'entry-1', changes: [] };

  it('a table-row hook set to run as an agent hands the runner that agent', async () => {
    const context = await contextFor(AGENT_A, rowEdit);
    expect(context?.runAsAgentId).toBe(AGENT_A);
    expect(context?.runAsBuildHash).toBe('build-a');
  });

  it('defaults to no run-as agent (the runner binds the system actor)', async () => {
    const context = await contextFor(null, rowEdit);
    expect(context).toBeDefined();
    expect(context?.runAsAgentId).toBeUndefined();
    expect(context?.agentId).toBeUndefined();
  });
});

describe('on-demand runs under run as', () => {
  it('act as the run-as agent only for a person or that agent, on an enabled hook', () => {
    expect(onDemandRunsAs(AGENT_A, true, undefined)).toBe(true);
    expect(onDemandRunsAs(AGENT_A, true, AGENT_A)).toBe(true);
    expect(onDemandRunsAs(AGENT_A, true, 'test-agent-c')).toBe(false);
    expect(onDemandRunsAs(AGENT_A, false, undefined)).toBe(false);
    expect(onDemandRunsAs(null, true, undefined)).toBe(false);
  });

  interface RegistrationProbe {
    registrations: Map<string, Record<string, unknown>>;
  }

  async function onDemandContext(
    callerAgentId: string | undefined,
    enabled = true
  ): Promise<HookRunContext | undefined> {
    const registry = new HookRegistryService({ dir: '/nonexistent/snaglet-test-hooks' });
    jest.spyOn(registry, 'registerHookFolder').mockResolvedValue(undefined);
    jest
      .spyOn(HookRegistrations, 'findByName')
      .mockResolvedValue({ ...registrationRow(AGENT_A), enabled });
    (registry as unknown as RegistrationProbe).registrations.set('test-hook', {
      name: 'test-hook',
      dir: '/nonexistent',
      builtPath: '/nonexistent/hook.cjs',
      repeatInChain: false,
      runAsAgentId: AGENT_A,
      runAsBuildHash: 'build-a',
    });
    const run = jest.spyOn(registry.getRunner(), 'runForTest').mockResolvedValue({
      ok: true,
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    await registry.runForTest({
      hookName: 'test-hook',
      eventName: 'schedule:fire',
      event: {},
      context: callerAgentId ? { agentId: callerAgentId } : {},
      ...(callerAgentId ? { callerAgentId } : {}),
    });
    return run.mock.calls[0]?.[0].context;
  }

  it('a person runs it as the run-as agent', async () => {
    expect((await onDemandContext(undefined))?.runAsAgentId).toBe(AGENT_A);
  });

  it('the run-as agent itself runs it as itself', async () => {
    expect((await onDemandContext(AGENT_A))?.runAsAgentId).toBe(AGENT_A);
  });

  it('another agent runs it as itself, never as the run-as agent', async () => {
    const context = await onDemandContext('test-agent-c');
    expect(context?.runAsAgentId).toBeUndefined();
    expect(context?.agentId).toBe('test-agent-c');
  });

  it('a disabled hook never runs under run as, not even for a person', async () => {
    expect((await onDemandContext(undefined, false))?.runAsAgentId).toBeUndefined();
  });
});

describe('agent deletion', () => {
  it('drops the run as of hooks that named the deleted agent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-test-run-as-delete-'));
    const registry = new HookRegistryService({ dir });
    try {
      await registry.start();
      const registrations = (
        registry as unknown as { registrations: Map<string, Record<string, unknown>> }
      ).registrations;
      registrations.set('test-hook', {
        name: 'test-hook',
        listeners: new Map(),
        runAsAgentId: AGENT_A,
        runAsBuildHash: 'build-a',
      });
      registrations.set('other-hook', {
        name: 'other-hook',
        listeners: new Map(),
        runAsAgentId: 'test-agent-c',
        runAsBuildHash: 'build-c',
      });

      hooks.emit('agent:delete', { id: AGENT_A });

      expect(registrations.get('test-hook')).toMatchObject({
        runAsAgentId: null,
        runAsBuildHash: null,
      });
      expect(registrations.get('other-hook')).toMatchObject({ runAsAgentId: 'test-agent-c' });
    } finally {
      registry.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
