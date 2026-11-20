// thread op:read mode:message_context must not hand the UI-only run-ended
// footer to an agent, while still resolving a window anchored on that row.
const mockGetContextWindow = jest.fn();
const mockThreadFindById = jest.fn();

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { getContextWindow: mockGetContextWindow },
}));
jest.mock('@snaglet/db/tables/threads', () => ({ Threads: { findById: mockThreadFindById } }));

import messageContext from '@server/services/ToolService/handlers/trivial/messageContext';

const CTX = { agentId: 'agent-venus', threadId: 'thread-here' } as never;

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: 'thread-here',
  role: 'user',
  content: `content ${id}`,
  agentId: null,
  userId: null,
  messageType: 'message',
  metadata: {},
  createdAt: `t-${id}`,
  ...extra,
});

const footer = (id: string) =>
  row(id, {
    messageType: 'thread_event',
    content: '[agent run ended · Nova · 4s · 1 tool call]',
    metadata: { event_kind: 'agent_run_ended' },
  });

describe('message_context run-ended filter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadFindById.mockResolvedValue({ id: 'thread-here', kind: 'chat' });
  });

  it('drops the run-ended footer, keeps other thread_event rows, counts the filtered list', async () => {
    mockGetContextWindow.mockResolvedValue({
      anchor: row('m2'),
      messages: [
        row('m1'),
        row('m2'),
        footer('f1'),
        row('e1', {
          messageType: 'thread_event',
          metadata: { event_kind: 'dispatch_mode_changed' },
        }),
      ],
    });
    const out = JSON.parse(await messageContext({ message_id: 'm2' }, {}, CTX));
    expect(out.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2', 'e1']);
    expect(out.returned_count).toBe(3);
    expect(JSON.stringify(out)).not.toContain('agent run ended');
  });

  it('still resolves a window anchored on a footer row, omitting the footer itself', async () => {
    mockGetContextWindow.mockResolvedValue({
      anchor: footer('f1'),
      messages: [row('m1'), footer('f1'), row('m3')],
    });
    const out = JSON.parse(await messageContext({ message_id: 'f1' }, {}, CTX));
    expect(out.success).toBe(true);
    expect(out.anchor_id).toBe('f1');
    expect(out.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm3']);
    expect(out.returned_count).toBe(2);
  });
});
