import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { dispatchToolCalls } from '@server/services/SocketService/handlers/chatPhases/toolDispatch';
import type { DispatchToolCallsInput } from '@server/services/SocketService/handlers/chatPhases/toolDispatch';
import type { Message } from '@server/services/SocketService/types';

const mockExecute = jest.fn();
const mockWaitForConfirmation = jest.fn();

jest.mock('@server/services/ToolService/lib/resolveAgentCwd', () => ({
  resolveAgentCwd: jest.fn().mockResolvedValue('/tmp'),
}));

jest.mock('@server/services/ToolService', () => ({
  toolExecutor: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

jest.mock('@server/services/SocketService/confirmation', () => ({
  waitForConfirmation: (...args: unknown[]) => mockWaitForConfirmation(...args),
}));

jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { logActivity: jest.fn().mockResolvedValue({}) },
}));

// The pared-down resolved-tool fake these tests thread through toolMap.
interface FakeResolvedTool {
  agentId?: string;
  tool: { id: string; name?: string; type?: string };
  settings?: Record<string, unknown>;
  requiresConfirmation?: boolean;
}

interface TestContentBlock {
  type?: string;
  text?: string;
  content?: string;
  is_error?: boolean;
  tool_use_id?: string;
}

function dispatchInput(
  toolMap: Map<string, FakeResolvedTool>,
  call: { id: string; name: string; input: Record<string, unknown> },
  agentMessages: Message[] = []
) {
  return {
    input: {
      result: {
        reply: '',
        toolCalls: [call],
        stopReason: 'tool_use',
      } as DispatchToolCallsInput['result'],
      agent: { id: 'agent-b', name: 'Agent B' } as DispatchToolCallsInput['agent'],
      runtimeAgent: {
        provider: 'anthropic',
        modelId: 'claude',
        credentialId: null,
      } as DispatchToolCallsInput['runtimeAgent'],
      agentMessages,
      toolMap,
      visibleToolIds: new Set(Array.from(toolMap.values(), (tool) => tool.tool.id)),
      session: { threadId: 'thread-1' } as DispatchToolCallsInput['session'],
      sessionId: 'session-1',
      threadName: 'Test Thread',
      runId: 'run-1',
      triggerMessageId: undefined,
      latestThinking: '',
      toToolText: (value: unknown) => String(value),
      dispatchMode: 'mentioned' as const,
      // Call-time permission guard input (mode 'all' = no per-call gating),
      // required by toolDispatch's tool-sandboxing guard.
      toolAccess: { mode: 'all', allowList: [], denyList: [] },
    },
    agentMessages,
  };
}

describe('pending agent messages', () => {
  beforeEach(() => {
    pendingAgentMessages.resetForTests();
    jest.clearAllMocks();
  });

  it('rejects action subtools outside the effective tool map', async () => {
    const { input, agentMessages } = dispatchInput(new Map(), {
      id: 'call-denied',
      name: 'action',
      input: { tool: 'disabled_tool', params: {} },
    });

    await dispatchToolCalls(input);

    expect(mockExecute).not.toHaveBeenCalled();
    expect((agentMessages[0]!.content as TestContentBlock[])[0]).toMatchObject({
      is_error: true,
      content: expect.stringMatching(/^No tool named 'disabled_tool' is loaded for you\. /),
    });
  });

  it('resolves an action alias and executes the canonical tool with its settings', async () => {
    const resolved = {
      agentId: 'agent-b',
      tool: { id: 'canonical_tool', name: 'Canonical Tool', type: 'external' },
      settings: { scope: 'agent' },
      requiresConfirmation: false,
    };
    mockExecute.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
    const { input } = dispatchInput(new Map([['friendly alias', resolved]]), {
      id: 'call-alias',
      name: 'action',
      input: { tool: 'friendly alias', params: { value: 42 } },
    });

    await dispatchToolCalls(input);

    // The alias resolves to the canonical tool id, with the alias row's own
    // settings; dispatch results do not echo dispatched tool names.
    expect(mockExecute).toHaveBeenCalledWith(
      { name: 'canonical_tool', input: { value: 42 } },
      resolved,
      expect.objectContaining({ agentId: 'agent-b', threadId: 'thread-1' })
    );
  });

  it('applies confirmation policy before action subtool execution', async () => {
    const resolved = {
      agentId: 'agent-b',
      tool: { id: 'dangerous_tool', name: 'Dangerous Tool', type: 'builtin' },
      settings: {},
      requiresConfirmation: true,
    };
    mockWaitForConfirmation.mockResolvedValue({ approved: false, timedOut: false });
    const { input, agentMessages } = dispatchInput(new Map([['dangerous_tool', resolved]]), {
      id: 'call-confirm',
      name: 'action',
      input: { tool: 'dangerous_tool', params: { force: true } },
    });

    await dispatchToolCalls(input);

    expect(mockWaitForConfirmation).toHaveBeenCalledWith({
      threadId: input.session.threadId,
      sessionId: input.sessionId,
      callId: 'call-confirm',
      agentId: input.agent.id,
      runId: input.runId,
      toolName: 'dangerous_tool',
      toolInput: { force: true },
      mode: 'approval',
      allowListSnapshot: [],
      denyListSnapshot: [],
      abortSignal: undefined,
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect((agentMessages[0]!.content as TestContentBlock[])[0].content).toBe(
      'Tool call was denied by the user'
    );
  });

  // End-to-end-ish coverage of the turnLoop → dispatchToolCalls seam: a message
  // queued for a running agent must be appended, formatted, to the tool_result
  // turn dispatchToolCalls builds — which is exactly the array turnLoop forwards
  // to the next iteration's LLM request. dispatchMode here is 'mentioned'
  // (dispatchInput default) — the DB default for a 1:1 thread, i.e. the
  // flagship solo/user case.
  describe('mid-run message injection into the next iteration request', () => {
    function runToolThenInject() {
      const resolved = {
        agentId: 'agent-b',
        tool: { id: 'some_tool', name: 'Some Tool', type: 'builtin' },
        settings: {},
        requiresConfirmation: false,
      };
      mockExecute.mockResolvedValue({ success: true, output: 'done', durationMs: 1 });
      return dispatchInput(new Map([['some_tool', resolved]]), {
        id: 'call-1',
        name: 'some_tool',
        input: {},
      });
    }

    it("injects a queued user message as a text block after the tool_result (mentioned mode — user's voice always heard)", async () => {
      pendingAgentMessages.enqueue({
        threadId: 'thread-1',
        targetAgentId: 'agent-b',
        senderUserId: 'user-1',
        senderName: 'User',
        content: 'actually, also check the logs',
        reason: 'user-mid-run',
      });

      const { input, agentMessages } = runToolThenInject();
      await dispatchToolCalls(input);

      const userTurn = agentMessages[agentMessages.length - 1]!;
      expect(userTurn.role).toBe('user');
      const blocks = userTurn.content as TestContentBlock[];
      expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1' });
      expect(blocks).toContainEqual({
        type: 'text',
        text: '[message from User] actually, also check the logs',
      });
      expect(pendingAgentMessages.listUnread('thread-1', 'agent-b')).toEqual([]);
    });

    it('does not inject a non-mention peer message in mentioned mode (held for the next message that reaches the agent)', async () => {
      pendingAgentMessages.enqueue({
        threadId: 'thread-1',
        targetAgentId: 'agent-b',
        senderAgentId: 'agent-venus',
        senderName: 'Venus',
        content: 'fyi broadcast',
        reason: 'all-mode-thread-message',
      });

      const { input, agentMessages } = runToolThenInject();
      await dispatchToolCalls(input);

      const userTurn = agentMessages[agentMessages.length - 1]!;
      const blocks = userTurn.content as TestContentBlock[];
      // Pure tool_result turn — no appended text block.
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1' });
      // Held, not dropped: it goes out ahead of the next message that reaches
      // the agent, or is read from history on its next wake.
      expect(pendingAgentMessages.listUnread('thread-1', 'agent-b')).toHaveLength(1);
    });
  });
});
