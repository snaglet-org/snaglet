// Unit tests for the shared cross-thread footer helper used by thread op:send
// and thread op:create (initial_message). The two variants differ in how they
// describe the origin, but must share the exact reply-call wording so they
// cannot drift.
const mockThreadFindById = jest.fn();
const mockAgentFindById = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: mockThreadFindById },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: mockAgentFindById },
}));

import {
  crossThreadFooter,
  replyCall,
  withCrossThreadFooter,
} from '@server/services/ToolService/handlers/threads/crossThreadFooter';

describe('crossThreadFooter', () => {
  it('both variants end with the same reply call', () => {
    const reply = replyCall('thread-origin');
    expect(reply).toBe('call thread with op:"send" and id:"thread-origin".');
    expect(crossThreadFooter('sent', '@Test Agent', 'Ops Room', 'thread-origin')).toMatch(
      new RegExp(`${reply.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    );
    expect(crossThreadFooter('created', '@Test Agent', 'Ops Room', 'thread-origin')).toMatch(
      new RegExp(`${reply.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    );
  });

  it('"sent" says the message is not from this conversation', () => {
    expect(crossThreadFooter('sent', '@Test Agent', 'Ops Room', 'thread-origin')).toBe(
      '— sent by @Test Agent from [Ops Room](thread-origin), not from this conversation. ' +
        'To reply, call thread with op:"send" and id:"thread-origin".'
    );
  });

  it('"created" says the agent created this thread from the origin', () => {
    expect(crossThreadFooter('created', '@Test Agent', 'Ops Room', 'thread-origin')).toBe(
      '— @Test Agent created this thread from [Ops Room](thread-origin) and posted this message ' +
        'from there. To reply in that thread, call thread with op:"send" and id:"thread-origin".'
    );
  });
});

describe('withCrossThreadFooter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadFindById.mockResolvedValue({ id: 'thread-origin', title: 'Ops Room' });
    mockAgentFindById.mockResolvedValue({ id: 'agent-a', name: 'Test Agent' });
  });

  const base = {
    kind: 'created' as const,
    content: 'hello',
    agentId: 'agent-a',
    targetThreadId: 'thread-target',
  };

  it('appends the footer after a blank line when the origin differs', async () => {
    const out = await withCrossThreadFooter({ ...base, originThreadId: 'thread-origin' });
    expect(out).toBe(
      `hello\n\n${crossThreadFooter('created', '@Test Agent', 'Ops Room', 'thread-origin')}`
    );
  });

  it.each([undefined, null, '', 'thread-target'])(
    'returns content unchanged without lookups for origin %p',
    async (originThreadId) => {
      const out = await withCrossThreadFooter({ ...base, originThreadId });
      expect(out).toBe('hello');
      expect(mockThreadFindById).not.toHaveBeenCalled();
      expect(mockAgentFindById).not.toHaveBeenCalled();
    }
  );

  it('degrades the wording when lookups reject or throw synchronously', async () => {
    mockThreadFindById.mockImplementation(() => {
      throw new Error('sync boom');
    });
    mockAgentFindById.mockRejectedValue(new Error('db down'));
    const out = await withCrossThreadFooter({ ...base, originThreadId: 'thread-origin' });
    expect(out).toBe(
      `hello\n\n${crossThreadFooter('created', 'an agent', 'Untitled Thread', 'thread-origin')}`
    );
  });

  it('falls back when the origin title or agent name is blank', async () => {
    mockThreadFindById.mockResolvedValue({ id: 'thread-origin', title: '   ' });
    mockAgentFindById.mockResolvedValue({ id: 'agent-a', name: '' });
    const out = await withCrossThreadFooter({ ...base, originThreadId: 'thread-origin' });
    expect(out).toContain('— an agent created this thread from [Untitled Thread](thread-origin)');
  });
});
