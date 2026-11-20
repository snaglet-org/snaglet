/**
 * Guardrails 2+3 at the tool-executor seam: every execution is raced against a
 * hard timeout and the run's AbortSignal, resolving as a structured
 * timeout/abort result instead of wedging the run forever.
 */

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    load: jest.fn(),
    size: 1,
    getHandler: jest.fn(),
    getDefinition: jest.fn(),
  },
}));

import {
  resolveToolTimeoutMs,
  withExecutionGuards,
  TOOL_HARD_TIMEOUT_MS,
} from '@server/services/ToolService/lib/executionGuards';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';

const never = () => new Promise<never>(() => {});

function agentTool(): ResolvedAgentTool {
  return {
    agentId: 'agent-1',
    tool: { id: 'hang_tool', name: 'Hang Tool', type: 'builtin' },
    settings: {},
    requiresConfirmation: false,
  } as unknown as ResolvedAgentTool;
}

describe('withExecutionGuards', () => {
  it('passes through a normal resolution', async () => {
    const outcome = await withExecutionGuards(Promise.resolve(42), { timeoutMs: 1000 });
    expect(outcome).toEqual({ kind: 'ok', value: 42 });
  });

  it('resolves as timeout when the work never returns', async () => {
    const outcome = await withExecutionGuards(never(), { timeoutMs: 40 });
    expect(outcome).toEqual({ kind: 'timeout', timeoutMs: 40 });
  });

  it('resolves as aborted when the signal fires mid-flight', async () => {
    const controller = new AbortController();
    const pending = withExecutionGuards(never(), { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toEqual({ kind: 'aborted' });
  });

  it('resolves as aborted immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await withExecutionGuards(never(), {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ kind: 'aborted' });
  });

  it('propagates a rejection unchanged (normal error path)', async () => {
    await expect(
      withExecutionGuards(Promise.reject(new Error('boom')), { timeoutMs: 1000 })
    ).rejects.toThrow('boom');
  });
});

describe('resolveToolTimeoutMs', () => {
  it('uses the per-call timeout_ms, clamped to sane bounds', () => {
    expect(resolveToolTimeoutMs('any_tool', { timeout_ms: 120_000 }, {})).toBe(120_000);
    expect(resolveToolTimeoutMs('any_tool', { timeout_ms: 1 }, {})).toBe(1_000);
    expect(resolveToolTimeoutMs('any_tool', { timeout_ms: 99 * 60_000 }, {})).toBe(30 * 60_000);
  });

  it('falls back to settings, then per-tool override, then the default', () => {
    expect(resolveToolTimeoutMs('any_tool', {}, { timeout_ms: 45_000 })).toBe(45_000);
    for (const toolId of ['ask', 'get_clarification']) {
      expect(resolveToolTimeoutMs(toolId, {}, {})).toBe(11 * 60_000);
    }
    expect(resolveToolTimeoutMs('any_tool', {}, {})).toBe(TOOL_HARD_TIMEOUT_MS);
  });
});

describe('toolExecutor.execute guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a structured timeout result for a hung handler (run continues)', async () => {
    (toolRegistry.getHandler as jest.Mock).mockReturnValue(() => never());

    const result = await toolExecutor.execute(
      { name: 'hang_tool', input: { timeout_ms: 1000 } },
      agentTool(),
      { agentId: 'agent-1', threadId: 'thread-1' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out after 1000ms/);
  });

  it('returns a structured aborted result when socket:chat:abort fires mid-call', async () => {
    (toolRegistry.getHandler as jest.Mock).mockReturnValue(() => never());
    const controller = new AbortController();

    const pending = toolExecutor.execute(
      { name: 'hang_tool', input: { timeout_ms: 60_000 } },
      agentTool(),
      { agentId: 'agent-1', threadId: 'thread-1', signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 20);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/aborted/);
  });

  it('leaves a fast, healthy call untouched', async () => {
    (toolRegistry.getHandler as jest.Mock).mockReturnValue(async () => 'done');

    const result = await toolExecutor.execute({ name: 'hang_tool', input: {} }, agentTool(), {
      agentId: 'agent-1',
      threadId: 'thread-1',
    });

    expect(result).toMatchObject({ success: true, output: 'done' });
  });
});
