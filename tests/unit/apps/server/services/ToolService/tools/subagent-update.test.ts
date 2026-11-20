/**
 * The subagent tool's instructions: op:start passes them to the service, and
 * op:update replaces them as the calling orchestrator ("" clears them). The
 * service owns the checks (length, ownership); the tool only reads input.
 */
const mockStart = jest.fn();
const mockUpdateInstructions = jest.fn();

jest.mock('@server/services/subagents/SubagentService', () => ({
  SUBAGENT_WAIT_MAX_MS: 240_000,
  SubagentError: jest.requireActual('@server/services/subagents/errors').SubagentError,
  subagentService: { start: mockStart, updateInstructions: mockUpdateInstructions },
}));

import subagentTool from '@server/services/ToolService/tools/agents/subagent/tool';

const THREAD = 'thread-1111111111111-aaaaaaaaa';
const ctx = { agentId: 'test-agent-a', threadId: THREAD } as never;
const sub = { id: 'subagent-1', name: 'Scout', modelId: 'model-a', threadId: 'thread-2' };

describe('subagent tool: instructions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStart.mockResolvedValue(sub);
    mockUpdateInstructions.mockImplementation(async (input: { instructions: string | null }) => ({
      sub,
      instructions: input.instructions?.trim() ? input.instructions : null,
    }));
  });

  it('start passes instructions (none when omitted)', async () => {
    await subagentTool(
      { op: 'start', name: 'Scout', model: 'model-a', brief: 'Look.', instructions: 'Be brief.' },
      {},
      ctx
    );
    expect(mockStart.mock.calls[0]![0]).toMatchObject({ instructions: 'Be brief.' });
    await subagentTool({ op: 'start', name: 'Scout', model: 'model-a', brief: 'Look.' }, {}, ctx);
    expect(mockStart.mock.calls[1]![0]).toMatchObject({ instructions: null });
  });

  it('update replaces them as the calling orchestrator', async () => {
    const out = await subagentTool(
      { op: 'update', name: 'Scout', instructions: 'Cite sources.' },
      {},
      ctx
    );
    expect(mockUpdateInstructions).toHaveBeenCalledWith({
      parentThreadId: THREAD,
      ref: 'Scout',
      by: { kind: 'orchestrator', agentId: 'test-agent-a' },
      instructions: 'Cite sources.',
    });
    expect(out).toContain("Updated Scout's instructions; they apply from its next turn");
  });

  it('update with "" clears them', async () => {
    const out = await subagentTool({ op: 'update', name: 'Scout', instructions: '' }, {}, ctx);
    expect(out).toContain("Cleared Scout's instructions");
  });

  it('update without instructions, or with a non-string, is refused before the service', async () => {
    await expect(subagentTool({ op: 'update', name: 'Scout' }, {}, ctx)).rejects.toThrow(
      'subagent update: update needs instructions'
    );
    await expect(
      subagentTool({ op: 'update', name: 'Scout', instructions: 42 }, {}, ctx)
    ).rejects.toThrow('subagent update: instructions must be a string.');
    expect(mockUpdateInstructions).not.toHaveBeenCalled();
  });
});
