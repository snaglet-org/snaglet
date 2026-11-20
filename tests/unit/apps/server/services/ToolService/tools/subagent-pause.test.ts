/**
 * The subagent tool's pause, stop and remove ops: how `for` / `until` reach
 * the service as a resume time, and what the orchestrator is told back.
 */
const mockPause = jest.fn();
const mockRemove = jest.fn();

jest.mock('@server/services/subagents/SubagentService', () => ({
  SUBAGENT_WAIT_MAX_MS: 240_000,
  SubagentError: jest.requireActual('@server/services/subagents/errors').SubagentError,
  subagentService: { pause: mockPause, remove: mockRemove },
}));

import subagentTool from '@server/services/ToolService/tools/agents/subagent/tool';
import { describeResumeTime } from '@server/services/subagents/subagentText';

const ctx = { agentId: 'test-agent-a', threadId: 'thread-1111111111111-aaaaaaaaa' } as never;
const NOW = Date.parse('2026-10-13T12:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
  return { id: 'subagent-1', name: 'Echo', status: 'stopped', resumeAt: null, ...over };
}

describe('subagent tool: pause / stop / remove', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
    mockPause.mockResolvedValue({ sub: row(), interrupted: true, done: true });
    mockRemove.mockResolvedValue({ sub: row(), interrupted: false, removed: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stop pauses with no timer, as the calling orchestrator', async () => {
    const out = await subagentTool({ op: 'stop', name: 'Echo' }, {}, ctx);
    expect(mockPause).toHaveBeenCalledWith({
      parentThreadId: 'thread-1111111111111-aaaaaaaaa',
      ref: 'Echo',
      by: { kind: 'orchestrator', agentId: 'test-agent-a' },
      resumeAt: null,
    });
    expect(out).toContain('Paused Echo (its run was stopped).');
    expect(out).toContain('op:send with name "Echo" to resume or redirect it');
  });

  it('pause with for or until passes the resume time', async () => {
    await subagentTool({ op: 'pause', name: 'Echo', for: '15m' }, {}, ctx);
    expect(mockPause.mock.calls[0]![0].resumeAt.toISOString()).toBe('2026-10-13T12:15:00.000Z');

    mockPause.mockResolvedValue({ sub: row(), interrupted: false, done: true });
    const out = await subagentTool(
      { op: 'pause', name: 'Echo', until: '2026-10-13T15:00:00Z' },
      {},
      ctx
    );
    expect(mockPause.mock.calls[1]![0].resumeAt.toISOString()).toBe('2026-10-13T15:00:00.000Z');
    // In words in the user's zone (the server's), never the ISO instant.
    expect(out).toBe(
      `Paused Echo until ${describeResumeTime('2026-10-13T15:00:00.000Z')}; then it resumes on its own where it left off. ` +
        'op:send with name "Echo" before then resumes or redirects it at once and cancels the timer.'
    );
    expect(out).not.toContain('2026-10-13T15:00');
  });

  it('refuses a bad time before touching the helper', async () => {
    await expect(
      subagentTool({ op: 'pause', name: 'Echo', for: 'later' }, {}, ctx)
    ).rejects.toThrow(/^subagent pause: for must be a length such as "15m"/);
    await expect(
      subagentTool({ op: 'pause', name: 'Echo', for: '1h', until: '2026-10-13T15:00:00Z' }, {}, ctx)
    ).rejects.toThrow('subagent pause: give for or until, not both.');
    expect(mockPause).not.toHaveBeenCalled();
  });

  it('says when the pause or removal waits for the run to end', async () => {
    mockPause.mockResolvedValue({ sub: row(), interrupted: true, done: false });
    expect(await subagentTool({ op: 'pause', name: 'Echo' }, {}, ctx)).toBe(
      "Echo's run is still stopping; it is paused as soon as that run ends."
    );
    mockRemove.mockResolvedValue({ sub: row(), interrupted: true, removed: false });
    expect(await subagentTool({ op: 'remove', name: 'Echo' }, {}, ctx)).toBe(
      "Echo's run is still stopping; it is removed as soon as that run ends."
    );
  });

  it('remove removes as the calling orchestrator', async () => {
    expect(await subagentTool({ op: 'remove', name: 'Echo' }, {}, ctx)).toBe(
      'Removed Echo: its thread and work are deleted.'
    );
    expect(mockRemove).toHaveBeenCalledWith({
      parentThreadId: 'thread-1111111111111-aaaaaaaaa',
      ref: 'Echo',
      by: { kind: 'orchestrator', agentId: 'test-agent-a' },
    });
  });

  it('lists the new ops when the op is unknown', async () => {
    await expect(subagentTool({ op: 'snooze', name: 'Echo' }, {}, ctx)).rejects.toThrow(
      'op is required and must be one of start | send | wait | stop | pause | update | remove | list | models.'
    );
  });
});
