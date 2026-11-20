/**
 * User-authored hooks never receive a subagent helper's own events:
 * its thread's messages and runs, its thread and agent lifecycle, its tool
 * assignments. What a helper does to visible work still fires. Covers the
 * event classifier, the HookRegistryService dispatch gate and the bus's
 * recent-event ring. The helper predicates are stubbed; their database
 * behavior is covered by the subagents integration suites.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const HELPER_THREAD = 'thread-2222222222222-bbbbbbbbb';
const VISIBLE_THREAD = 'thread-1111111111111-aaaaaaaaa';
const HELPER_AGENT = 'subagent-11111111-1111-4111-8111-111111111111';
const VISIBLE_AGENT = 'test-agent-a';

const isHelperThread = jest.fn(async (id: string | null | undefined) => id === HELPER_THREAD);
const isHelperAgent = jest.fn(async (id: string | null | undefined) => id === HELPER_AGENT);
const known = new Set<string>();

jest.mock('@server/services/subagents/helperVisibility', () => ({
  isHelperThread: (id: string | null | undefined) => isHelperThread(id),
  isHelperAgent: (id: string | null | undefined) => isHelperAgent(id),
  isKnownHelperThread: (id: string | null | undefined) => !!id && known.has(id),
  isKnownHelperAgent: (id: string | null | undefined) => !!id && known.has(id),
}));
jest.mock('@server/services/settings/settingsService', () => ({
  settingsService: { read: async () => true },
}));

import { isHelperHookEvent } from '@server/services/hooks/helperEvents';
import { hooks, type HookEvent } from '@server/services/HookService';
import { HookRegistryService } from '@server/services/customHooks/HookRegistryService';

describe('isHelperHookEvent', () => {
  it.each<[HookEvent, Record<string, unknown>]>([
    ['message:create', { id: 'message-1', threadId: HELPER_THREAD, role: 'agent', text: 'hi' }],
    ['message:create', { id: 'message-1', threadId: VISIBLE_THREAD, agentId: HELPER_AGENT }],
    ['run:end', { runId: 'run-1', threadId: HELPER_THREAD, status: 'completed' }],
    ['run:end', { runId: 'run-1', agentId: HELPER_AGENT, status: 'failed' }],
    ['thread:create', { id: HELPER_THREAD, createdBy: { kind: 'agent' }, participants: [] }],
    [
      'thread:update',
      { id: HELPER_THREAD, changed: ['title'], participantAgentIds: [], removedAgentIds: [] },
    ],
    ['thread:delete', { id: HELPER_THREAD }],
    ['thread:move', { id: HELPER_THREAD, fromProjectId: null, toProjectId: null }],
    ['agent:create', { id: HELPER_AGENT, createdBy: { kind: 'agent' } }],
    ['agent:update', { id: HELPER_AGENT, changed: ['role'] }],
    ['agent:delete', { id: HELPER_AGENT }],
    ['agent_tool:assign', { agentId: HELPER_AGENT, toolIds: ['tool-1'] }],
    [
      'schedule:fire',
      { scheduleId: 's', runId: 'r', scheduledFor: 'now', threadId: HELPER_THREAD },
    ],
  ])('drops %s belonging to a helper', async (event, payload) => {
    await expect(isHelperHookEvent(event, payload)).resolves.toBe(true);
  });

  it.each<[HookEvent, Record<string, unknown>]>([
    ['message:create', { id: 'message-1', threadId: VISIBLE_THREAD, agentId: VISIBLE_AGENT }],
    ['run:end', { runId: 'run-1', threadId: VISIBLE_THREAD, agentId: VISIBLE_AGENT }],
    // A helper creating a visible thread or doc, or signaling, is
    // visible work: the event still fires.
    ['thread:create', { id: VISIBLE_THREAD, agentId: HELPER_AGENT, participants: [] }],
    ['doc:create', { id: 'doc-1111111111111-aaaaaaaaa', title: 'x', createdBy: HELPER_AGENT }],
    ['hook:signal', { name: 'done', data: null, hookName: null, agentId: HELPER_AGENT }],
    // `id` names the thread only on thread events.
    ['doc:rename', { id: HELPER_THREAD, oldTitle: 'a', newTitle: 'b' }],
  ])('keeps %s that is not a helper’s own', async (event, payload) => {
    await expect(isHelperHookEvent(event, payload)).resolves.toBe(false);
  });
});

describe('HookRegistryService dispatch', () => {
  interface DispatchProbe {
    dispatch(
      reg: { name: string; dir: string; builtPath: string; filter: null },
      eventName: HookEvent,
      payload: unknown
    ): void;
  }

  async function dispatched(eventName: HookEvent, payload: unknown): Promise<number> {
    const registry = new HookRegistryService({ dir: '/nonexistent/snaglet-test-hooks' });
    const run = jest.spyOn(registry.getRunner(), 'run').mockResolvedValue(undefined);
    const reg = { name: 'test-hook-a', dir: '/nonexistent', builtPath: '/nonexistent/hook.mjs' };
    (registry as unknown as DispatchProbe).dispatch({ ...reg, filter: null }, eventName, payload);
    // settings read → helper check → hand-off are all microtasks.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return run.mock.calls.length;
  }

  it('never runs a hook for a helper thread message or a helper agent', async () => {
    expect(
      await dispatched('message:create', { id: 'm', threadId: HELPER_THREAD, role: 'agent' })
    ).toBe(0);
    expect(
      await dispatched('agent:create', { id: HELPER_AGENT, createdBy: { kind: 'agent' } })
    ).toBe(0);
  });

  it('still runs it for visible work', async () => {
    expect(
      await dispatched('message:create', { id: 'm', threadId: VISIBLE_THREAD, role: 'agent' })
    ).toBe(1);
  });
});

describe('recent-event ring', () => {
  beforeEach(() => known.clear());

  it('leaves out events known to be a helper’s', () => {
    hooks.emit('message:create', {
      id: 'message-ring-visible',
      threadId: VISIBLE_THREAD,
      role: 'agent',
      text: 'visible',
    });
    hooks.emit('message:create', {
      id: 'message-ring-helper',
      threadId: HELPER_THREAD,
      role: 'agent',
      text: 'helper',
    });
    known.add(HELPER_THREAD);
    const ids = hooks.recent('message:create').map((entry) => (entry.payload as { id: string }).id);
    expect(ids).toContain('message-ring-visible');
    expect(ids).not.toContain('message-ring-helper');
  });

  it('asks about each recorded event so the answer is known by the time it is read', () => {
    isHelperThread.mockClear();
    hooks.emit('message:create', {
      id: 'message-ring-warm',
      threadId: HELPER_THREAD,
      role: 'agent',
      text: 'helper',
    });
    expect(isHelperThread).toHaveBeenCalledWith(HELPER_THREAD);
  });
});
