const broadcastToChannel = jest.fn();
const noteProgressForThread = jest.fn();
const appendAgentAllowList = jest.fn();
const grantThreadToolAccess = jest.fn();
const settleAsk = jest.fn(async () => undefined);
const notifyToolApprovalAsk = jest.fn((_input: unknown) => ({
  notificationId: Promise.resolve('notif-ask-test-1'),
  settle: settleAsk,
}));

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel },
}));
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: { noteProgressForThread },
}));
jest.mock('@server/config/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));
// The agent row as read before and after the Always-allow write: the allow
// list and the revision move once the append has run.
const findAgentById = jest.fn(async () => {
  const appended = appendAgentAllowList.mock.calls.length > 0;
  return {
    id: 'agent-1',
    toolAccessAllowList: appended ? ['shell_exec'] : [],
    updatedAt: appended ? 'rev-2' : 'rev-1',
  };
});
jest.mock('@snaglet/db', () => ({
  Agents: { appendToolAccessAllowList: appendAgentAllowList, findById: findAgentById },
  ThreadParticipants: { grantToolAccess: grantThreadToolAccess },
}));
jest.mock('@server/services/askNotifications', () => ({
  notifyToolApprovalAsk: (input: unknown) => notifyToolApprovalAsk(input),
}));
// Only the instructions tool's definition is known: it marks `text` for the prompt in full.
jest.mock('@server/services/ToolService/ToolRegistry', () => {
  const definition = jest.requireActual<{ default: { id: string } }>(
    '@server/services/ToolService/tools/agents/workspace-instructions/definition'
  ).default;
  return {
    toolRegistry: {
      getDefinition: (id: string) => (id === definition.id ? definition : undefined),
    },
  };
});

import {
  cancelToolConfirmationsForThread,
  listPendingToolConfirmations,
  resolveToolConfirmation,
  waitForConfirmation,
} from '@server/services/SocketService/confirmation';

const baseInput = {
  threadId: 'thread-1',
  sessionId: 'session-1',
  callId: 'call-1',
  agentId: 'agent-1',
  toolName: 'shell_exec',
  toolInput: { command: 'git status' },
} as const;

describe('tool confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    appendAgentAllowList.mockResolvedValue({ id: 'agent-1', updatedAt: 'rev-2' });
    grantThreadToolAccess.mockResolvedValue({ agentId: 'agent-1' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits a thread-scoped request and resolves one-time approval', async () => {
    const resultPromise = waitForConfirmation(baseInput);

    expect(noteProgressForThread).toHaveBeenCalledWith('thread-1');
    expect(broadcastToChannel).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        type: 'socket:tool:confirmation_request',
        payload: expect.objectContaining({
          callId: 'call-1',
          mode: 'approval',
          inputSummary: expect.stringContaining('git status'),
        }),
      })
    );
    expect(listPendingToolConfirmations('thread-1')).toHaveLength(1);

    await resolveToolConfirmation('thread-1', 'call-1', 'approve_once');
    await expect(resultPromise).resolves.toEqual({ approved: true, timedOut: false });
    expect(listPendingToolConfirmations('thread-1')).toEqual([]);
  });

  it('shows a marked arg in full and verbatim, however long, with its length', async () => {
    const text = `Line one.\n${'x'.repeat(7_859)}\nLast line, past the usual cap.`;
    expect(text.length).toBe(7_900);
    const resultPromise = waitForConfirmation({
      ...baseInput,
      toolName: 'workspace_instructions',
      toolInput: { op: 'set', text },
    });
    const [, frame] = broadcastToChannel.mock.calls[0] as [
      string,
      { payload: { inputSummary: string } },
    ];
    const summary = frame.payload.inputSummary;
    expect(summary).toContain(`text (${text.length} characters, in full):\n${text}`);
    expect(summary).not.toContain('(truncated)');
    // The other args stay in the JSON part, without a second copy of the text.
    expect(summary.startsWith(JSON.stringify({ op: 'set' }, null, 2))).toBe(true);
    await resolveToolConfirmation('thread-1', 'call-1', 'deny');
    await expect(resultPromise).resolves.toMatchObject({ approved: false });
  });

  it('still caps the JSON summary of other tools', async () => {
    const resultPromise = waitForConfirmation({
      ...baseInput,
      toolInput: { command: 'y'.repeat(5_000) },
    });
    const [, frame] = broadcastToChannel.mock.calls[0] as [
      string,
      { payload: { inputSummary: string } },
    ];
    expect(frame.payload.inputSummary).toMatch(/… \(truncated\)$/);
    expect(frame.payload.inputSummary.length).toBeLessThan(2_100);
    await resolveToolConfirmation('thread-1', 'call-1', 'deny');
    await resultPromise;
  });

  it('persists Always allow on the agent allow-list before approving', async () => {
    const resultPromise = waitForConfirmation({ ...baseInput, mode: 'allow_list' });

    await resolveToolConfirmation('thread-1', 'call-1', 'allow_agent');

    expect(appendAgentAllowList).toHaveBeenCalledWith('agent-1', 'shell_exec');
    await expect(resultPromise).resolves.toEqual({
      approved: true,
      timedOut: false,
      policyUpdated: true,
    });
  });

  it('announces the grown allow-list so an open agent pane shows the tool', async () => {
    const resultPromise = waitForConfirmation({ ...baseInput, mode: 'allow_list' });

    await resolveToolConfirmation('thread-1', 'call-1', 'allow_agent');
    await resultPromise;

    expect(broadcastToChannel).toHaveBeenCalledWith(
      'workspace',
      expect.objectContaining({
        type: 'agent.updated',
        payload: expect.objectContaining({
          agentId: 'agent-1',
          changed: ['toolAccessAllowList'],
          updatedAt: 'rev-2',
        }),
      })
    );
  });

  it('persists Allow for this thread on the participant override', async () => {
    const resultPromise = waitForConfirmation({
      ...baseInput,
      mode: 'allow_list',
      allowListSnapshot: ['workspace_search'],
      denyListSnapshot: ['shell_exec(rm:*)'],
    });

    await resolveToolConfirmation('thread-1', 'call-1', 'allow_thread');

    expect(grantThreadToolAccess).toHaveBeenCalledWith(
      'thread-1',
      'agent-1',
      'shell_exec',
      ['workspace_search'],
      ['shell_exec(rm:*)']
    );
    await expect(resultPromise).resolves.toEqual({
      approved: true,
      timedOut: false,
      policyUpdated: true,
    });
  });

  it('times out as a clean denial and clears the pending request', async () => {
    const resultPromise = waitForConfirmation(baseInput);
    jest.advanceTimersByTime(60_000);

    await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: true });
    expect(listPendingToolConfirmations('thread-1')).toEqual([]);
    expect(broadcastToChannel).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ type: 'socket:tool:confirmation_timeout' })
    );
  });

  describe('a prompt nobody answered closes its panel', () => {
    function closeFrames(): unknown[] {
      return broadcastToChannel.mock.calls.filter(
        ([, msg]) => (msg as { type?: string }).type === 'socket:tool:confirmation_timeout'
      );
    }

    it("when the run's abort signal fires (Stop), once", async () => {
      const controller = new AbortController();
      const resultPromise = waitForConfirmation({ ...baseInput, abortSignal: controller.signal });

      controller.abort();
      // A later reaper sweep finds nothing left to close.
      expect(cancelToolConfirmationsForThread('thread-1')).toBe(0);

      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: false });
      expect(closeFrames()).toEqual([
        [
          'thread-1',
          {
            type: 'socket:tool:confirmation_timeout',
            payload: { threadId: 'thread-1', callId: 'call-1', toolName: 'shell_exec' },
          },
        ],
      ]);
      expect(listPendingToolConfirmations('thread-1')).toEqual([]);
    });

    it("when the thread's prompts are canceled (reaper), once", async () => {
      const controller = new AbortController();
      const resultPromise = waitForConfirmation({ ...baseInput, abortSignal: controller.signal });

      expect(cancelToolConfirmationsForThread('thread-1')).toBe(1);
      controller.abort();

      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: false });
      expect(closeFrames()).toHaveLength(1);
    });

    it('not when it was answered before the run stopped', async () => {
      const controller = new AbortController();
      const resultPromise = waitForConfirmation({ ...baseInput, abortSignal: controller.signal });

      await resolveToolConfirmation('thread-1', 'call-1', 'deny');
      controller.abort();

      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: false });
      expect(closeFrames()).toEqual([]);
    });
  });

  describe("the prompt's notification", () => {
    it('is raised with the prompt and cleared once it is answered', async () => {
      const resultPromise = waitForConfirmation({ ...baseInput, runId: 'run-1' });

      expect(notifyToolApprovalAsk).toHaveBeenCalledTimes(1);
      expect(notifyToolApprovalAsk).toHaveBeenCalledWith({
        threadId: 'thread-1',
        callId: 'call-1',
        agentId: 'agent-1',
        runId: 'run-1',
        toolName: 'shell_exec',
        inputSummary: expect.stringContaining('git status'),
      });
      expect(settleAsk).not.toHaveBeenCalled();

      await resolveToolConfirmation('thread-1', 'call-1', 'approve_once');
      await resultPromise;
      expect(settleAsk).toHaveBeenCalledTimes(1);
    });

    it('is raised for an allow-list prompt too and cleared by Always allow', async () => {
      const resultPromise = waitForConfirmation({ ...baseInput, mode: 'allow_list' });
      expect(notifyToolApprovalAsk).toHaveBeenCalledTimes(1);

      await resolveToolConfirmation('thread-1', 'call-1', 'allow_agent');
      await resultPromise;
      expect(settleAsk).toHaveBeenCalledTimes(1);
    });

    it('is cleared by a denial', async () => {
      const resultPromise = waitForConfirmation(baseInput);
      await resolveToolConfirmation('thread-1', 'call-1', 'deny');
      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: false });
      expect(settleAsk).toHaveBeenCalledTimes(1);
    });

    it('is cleared by a decision that does not match the mode', async () => {
      const resultPromise = waitForConfirmation(baseInput);
      await resolveToolConfirmation('thread-1', 'call-1', 'allow_agent');
      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: false });
      expect(settleAsk).toHaveBeenCalledTimes(1);
    });

    it('is cleared when a grant cannot be saved', async () => {
      appendAgentAllowList.mockResolvedValueOnce(null);
      const resultPromise = waitForConfirmation({ ...baseInput, mode: 'allow_list' });
      await resolveToolConfirmation('thread-1', 'call-1', 'allow_agent');
      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: false });
      expect(settleAsk).toHaveBeenCalledTimes(1);
    });

    it('is cleared by the timeout', async () => {
      const resultPromise = waitForConfirmation(baseInput);
      jest.advanceTimersByTime(60_000);
      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: true });
      expect(settleAsk).toHaveBeenCalledTimes(1);
    });

    it("is cleared when the run's abort signal fires", async () => {
      const controller = new AbortController();
      const resultPromise = waitForConfirmation({ ...baseInput, abortSignal: controller.signal });
      controller.abort();
      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: false });
      expect(settleAsk).toHaveBeenCalledTimes(1);
    });

    it("is cleared when the thread's prompts are canceled", async () => {
      const resultPromise = waitForConfirmation(baseInput);
      expect(cancelToolConfirmationsForThread('thread-1')).toBe(1);
      await expect(resultPromise).resolves.toEqual({ approved: false, timedOut: false });
      expect(settleAsk).toHaveBeenCalledTimes(1);
    });

    it('is never raised for a prompt whose run was already stopped', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        waitForConfirmation({ ...baseInput, abortSignal: controller.signal })
      ).resolves.toEqual({ approved: false, timedOut: false });
      expect(notifyToolApprovalAsk).not.toHaveBeenCalled();
      expect(broadcastToChannel).not.toHaveBeenCalled();
    });
  });
});
