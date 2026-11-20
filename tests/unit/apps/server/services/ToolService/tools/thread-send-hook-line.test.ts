// thread op:"send" from a hook set to run as an agent ends with
// `[hook <name> as <Agent>]`, so the hook's words never read as the agent's
// own. Other hook posts (ghost, or the event's agent without run as) and an
// agent's own turn are unchanged.
const mockThreadFindById = jest.fn();
const mockAgentFindById = jest.fn();
const mockPostAgentMessage = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: mockThreadFindById },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: mockAgentFindById },
}));
jest.mock('@server/services/ThreadDeliveryPolicyService', () => ({
  postAgentMessageToThread: (...args: unknown[]) => mockPostAgentMessage(...args),
  postExternalMessageToThread: jest.fn(),
}));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => undefined,
}));

import threadSend, {
  hookSenderLine,
} from '@server/services/ToolService/handlers/threads/threadSend';

const TARGET_THREAD = 'thread-target';
const HOOK = { kind: 'hook' as const, hookName: 'test-phase-gate' };

async function sentContent(): Promise<string> {
  expect(mockPostAgentMessage).toHaveBeenCalledTimes(1);
  return (mockPostAgentMessage.mock.calls[0][0] as { content: string }).content;
}

describe('thread send from a hook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadFindById.mockResolvedValue({ id: TARGET_THREAD, title: 'Ops' });
    mockAgentFindById.mockResolvedValue({ id: 'test-agent-a', name: 'Test Agent A' });
    mockPostAgentMessage.mockResolvedValue({ messageId: 'message-1' });
  });

  it('a hook running as an agent sends as it and says so on the last line', async () => {
    await threadSend(
      { thread_id: TARGET_THREAD, content: 'Phase 2 is done.' },
      {},
      {
        agentId: 'test-agent-a',
        hookOrigin: HOOK,
        hookRunAs: true,
      }
    );

    expect(await sentContent()).toBe('Phase 2 is done.\n\n[hook test-phase-gate as Test Agent A]');
    expect(mockPostAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'test-agent-a', threadId: TARGET_THREAD })
    );
  });

  it('a ghost post gets no line', async () => {
    await threadSend(
      { thread_id: TARGET_THREAD, content: 'Phase 2 is done.' },
      {},
      {
        agentId: 'ghost',
        hookOrigin: HOOK,
      }
    );

    expect(await sentContent()).toBe('Phase 2 is done.');
  });

  it("a hook acting as the event's agent without run as gets no line", async () => {
    await threadSend(
      { thread_id: TARGET_THREAD, content: 'Phase 2 is done.' },
      {},
      { agentId: 'test-agent-a', hookOrigin: HOOK }
    );

    expect(await sentContent()).toBe('Phase 2 is done.');
  });

  it("an agent's own send is unchanged", async () => {
    await threadSend(
      { thread_id: TARGET_THREAD, content: 'hi' },
      {},
      {
        agentId: 'test-agent-a',
        threadId: TARGET_THREAD,
      }
    );

    expect(await sentContent()).toBe('hi');
  });

  it('falls back to the agent id when the name lookup fails', async () => {
    mockAgentFindById.mockRejectedValue(new Error('db down'));
    await expect(hookSenderLine('test-phase-gate', 'test-agent-a')).resolves.toBe(
      '[hook test-phase-gate as test-agent-a]'
    );
  });
});
