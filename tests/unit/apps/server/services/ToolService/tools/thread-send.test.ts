// The thread_send origin footer. Dispatch is fire-and-forget, so the receiver
// gets no link back to the conversation a cross-thread message came from. The
// footer says who sent it, where it came from (origin thread title + id chip),
// and that it did not originate in the receiver's current conversation; the
// last matters when the sender is also a participant of the target thread.
//
// The footer is decoration: both lookups behind it degrade the wording rather
// than fail the send, tested against rejected promises, not just null returns.
const mockThreadFindById = jest.fn();
const mockAgentFindById = jest.fn();
const mockPostAgentMessage = jest.fn();
const mockPostExternalMessage = jest.fn();
const mockGetCurrentActor = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: mockThreadFindById },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: mockAgentFindById },
}));
jest.mock('@server/services/ThreadDeliveryPolicyService', () => ({
  postAgentMessageToThread: (...args: unknown[]) => mockPostAgentMessage(...args),
  postExternalMessageToThread: (...args: unknown[]) => mockPostExternalMessage(...args),
}));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => mockGetCurrentActor(),
}));

import threadSend from '@server/services/ToolService/handlers/threads/threadSend';

const ORIGIN_THREAD = 'thread-origin';
const TARGET_THREAD = 'thread-target';

/** The content thread_send actually handed to the delivery layer. */
async function sentContent(): Promise<string> {
  expect(mockPostAgentMessage).toHaveBeenCalledTimes(1);
  return (mockPostAgentMessage.mock.calls[0][0] as { content: string }).content;
}

describe('thread_send origin footer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentActor.mockReturnValue(null);
    mockThreadFindById.mockResolvedValue({ id: ORIGIN_THREAD, title: 'Ops Room' });
    mockAgentFindById.mockResolvedValue({ id: 'agent-venus', name: 'Venus' });
    mockPostAgentMessage.mockResolvedValue({ messageId: 'message-1' });
  });

  describe('cross-thread send', () => {
    const context = { agentId: 'agent-venus', threadId: ORIGIN_THREAD } as never;

    it('appends the full footer: sender, origin chip, disambiguation, reply route', async () => {
      await threadSend({ thread_id: TARGET_THREAD, content: 'Status: green.' }, {}, context);

      expect(await sentContent()).toBe(
        'Status: green.\n\n' +
          `— sent by @Venus from [Ops Room](${ORIGIN_THREAD}), ` +
          `not from this conversation. To reply, call thread with op:"send" and id:"${ORIGIN_THREAD}".`
      );
    });

    it('resolves the sender name from the calling agent id', async () => {
      await threadSend({ thread_id: TARGET_THREAD, content: 'ping' }, {}, context);

      expect(mockAgentFindById).toHaveBeenCalledWith('agent-venus');
    });

    it('still delivers to the target thread, not the origin', async () => {
      await threadSend({ thread_id: TARGET_THREAD, content: 'ping' }, {}, context);

      expect(mockPostAgentMessage).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: TARGET_THREAD, agentId: 'agent-venus' })
      );
    });
  });

  describe('same-thread send', () => {
    it('appends no footer — the address would be redundant and the message did originate here', async () => {
      const context = { agentId: 'agent-venus', threadId: TARGET_THREAD } as never;

      await threadSend({ thread_id: TARGET_THREAD, content: 'Status: green.' }, {}, context);

      expect(await sentContent()).toBe('Status: green.');
      // Only the DM guard looks the target up; no origin lookup happens.
      expect(mockThreadFindById).not.toHaveBeenCalledWith(ORIGIN_THREAD);
      expect(mockAgentFindById).not.toHaveBeenCalled();
    });
  });

  describe('headless run (no thread context)', () => {
    it('appends no footer when the caller has no origin thread', async () => {
      const context = { agentId: 'agent-venus' } as never;

      await threadSend({ thread_id: TARGET_THREAD, content: 'Status: green.' }, {}, context);

      expect(await sentContent()).toBe('Status: green.');
      // Only the DM guard looks the target up; no origin lookup happens.
      expect(mockThreadFindById).not.toHaveBeenCalledWith(ORIGIN_THREAD);
      expect(mockAgentFindById).not.toHaveBeenCalled();
    });
  });

  describe('unresolvable sender — footer degrades, send still succeeds', () => {
    const context = { agentId: 'agent-gone', threadId: ORIGIN_THREAD } as never;

    it.each([
      ['the agent row is missing', () => mockAgentFindById.mockResolvedValue(null)],
      ['the lookup rejects', () => mockAgentFindById.mockRejectedValue(new Error('db down'))],
      ['the name is blank', () => mockAgentFindById.mockResolvedValue({ id: 'a', name: '   ' })],
      [
        'the name is not a string',
        () => mockAgentFindById.mockResolvedValue({ id: 'a', name: 42 }),
      ],
    ])('falls back to "an agent" when %s', async (_case, arrange) => {
      arrange();

      const result = await threadSend(
        { thread_id: TARGET_THREAD, content: 'Status: green.' },
        {},
        context
      );

      expect(await sentContent()).toBe(
        'Status: green.\n\n' +
          `— sent by an agent from [Ops Room](${ORIGIN_THREAD}), ` +
          `not from this conversation. To reply, call thread with op:"send" and id:"${ORIGIN_THREAD}".`
      );
      expect(JSON.parse(result as string)).toEqual(
        expect.objectContaining({ success: true, message_id: 'message-1' })
      );
    });
  });

  describe('unresolvable origin thread — footer degrades, send still succeeds', () => {
    const context = { agentId: 'agent-venus', threadId: ORIGIN_THREAD } as never;

    it('keeps the sender name and the id chip when the thread lookup rejects', async () => {
      // Only the origin lookup fails; the DM guard's target lookup succeeds.
      mockThreadFindById.mockImplementation(async (id: string) => {
        if (id === ORIGIN_THREAD) throw new Error('db down');
        return { id, kind: 'chat' };
      });

      await threadSend({ thread_id: TARGET_THREAD, content: 'Status: green.' }, {}, context);

      expect(await sentContent()).toBe(
        'Status: green.\n\n' +
          `— sent by @Venus from [Untitled Thread](${ORIGIN_THREAD}), ` +
          `not from this conversation. To reply, call thread with op:"send" and id:"${ORIGIN_THREAD}".`
      );
    });
  });

  describe('external MCP caller', () => {
    const context = { agentId: 'agent-venus', threadId: ORIGIN_THREAD } as never;

    it('takes the external path and is never given an agent footer', async () => {
      mockGetCurrentActor.mockReturnValue({
        actorKind: 'external',
        actorId: 'member-1',
        actorName: 'Bridge',
      });
      mockPostExternalMessage.mockResolvedValue({ messageId: 'message-ext' });

      await threadSend({ thread_id: TARGET_THREAD, content: 'Status: green.' }, {}, context);

      expect(mockPostExternalMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Status: green.' })
      );
      expect(mockPostAgentMessage).not.toHaveBeenCalled();
    });
  });
});

describe('thread_send target thread', () => {
  const context = { agentId: 'agent-venus', threadId: ORIGIN_THREAD } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentActor.mockReturnValue(null);
    mockThreadFindById.mockResolvedValue({ id: ORIGIN_THREAD, title: 'Ops Room' });
    mockAgentFindById.mockResolvedValue({ id: 'agent-venus', name: 'Venus' });
    mockPostAgentMessage.mockResolvedValue({ messageId: 'message-1' });
  });

  it('no id → posts to the calling thread, with no footer', async () => {
    const out = JSON.parse(await threadSend({ content: 'checkpoint' }, {}, context));
    expect(mockPostAgentMessage).toHaveBeenCalledWith({
      threadId: ORIGIN_THREAD,
      agentId: 'agent-venus',
      content: 'checkpoint',
    });
    expect(out.thread_id).toBe(ORIGIN_THREAD);
  });

  it("an unknown id fails naming the caller's own thread", async () => {
    mockPostAgentMessage.mockRejectedValue(new Error('Thread not found: thread-guess'));
    await expect(
      threadSend({ thread_id: 'thread-guess', content: 'x' }, {}, context)
    ).rejects.toThrow(
      'thread op:send: thread not found: thread-guess. You are in thread `Ops Room` (`thread-origin`); omit the id to target it.'
    );
  });

  it('other delivery errors pass through unchanged', async () => {
    mockPostAgentMessage.mockRejectedValue(new Error('not a participant'));
    await expect(threadSend({ content: 'x' }, {}, context)).rejects.toThrow('not a participant');
  });

  it('external MCP caller without an id is refused, never defaulted', async () => {
    mockGetCurrentActor.mockReturnValue({ actorKind: 'external', actorId: 'member-1' });
    await expect(threadSend({ content: 'x' }, {}, context)).rejects.toThrow(
      'thread id is required for external callers'
    );
    expect(mockPostExternalMessage).not.toHaveBeenCalled();
  });
});

describe('thread(op:"send") routing', () => {
  it('routes op send through the thread tool with the id mapped to thread_id', async () => {
    const { default: threadTool } =
      await import('@server/services/ToolService/tools/threads/thread/tool');
    mockGetCurrentActor.mockReturnValue(null);
    mockThreadFindById.mockResolvedValue({ title: 'Ops Room' });
    mockAgentFindById.mockResolvedValue({ name: 'Venus' });
    mockPostAgentMessage.mockResolvedValue({ messageId: 'message-9' });

    const out = await threadTool(
      { op: 'send', id: 'thread-target', thread_id: 'thread-target', content: 'hi' },
      {},
      { agentId: 'agent-venus', threadId: 'thread-target' } as never
    );

    expect(mockPostAgentMessage).toHaveBeenLastCalledWith({
      threadId: 'thread-target',
      agentId: 'agent-venus',
      content: 'hi',
    });
    expect(JSON.parse(out as string)).toMatchObject({ success: true, message_id: 'message-9' });
  });
});
