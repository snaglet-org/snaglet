/**
 * The "[agent run ended · …]" thread_event is a UI footer: it must never reach
 * an agent through replay, while every other thread_event kind still does.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listMessages = jest.fn<() => Promise<unknown[]>>();

jest.mock('@snaglet/db/db', () => ({ getDb: jest.fn(), transaction: jest.fn() }));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { listByThreadId: () => listMessages() },
}));
jest.mock('@snaglet/db/tables/runs', () => ({ Runs: { listByThreadId: async () => [] } }));
jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { getByThreadId: async () => [] },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: async () => [] },
}));
jest.mock('@snaglet/db/tables/users', () => ({ Users: { findById: async () => null } }));
jest.mock('@snaglet/db/tables/agents', () => ({ Agents: { findById: async () => null } }));

import {
  buildReplayPayload,
  loadReplaySource,
} from '@server/services/SocketService/handlers/chatPhases/replayLoader';
import {
  AGENT_RUN_ENDED_EVENT_KIND,
  isAgentRunEndedRow,
} from '@server/services/SocketService/agentRunEnded';
import {
  THREAD_EVENT_KIND,
  THREAD_EVENT_LINE_PREFIX,
} from '@server/services/SocketService/threadEvents';

const RUN_ENDED = '[agent run ended · Ada · 1m12s · 7 tool calls]';
const MODE_CHANGED = '[dispatch mode changed · all]';

const row = (over: Record<string, unknown>) => ({
  id: 'm',
  threadId: 't',
  agentId: null,
  userId: null,
  role: 'user',
  content: '',
  runId: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  injectedDuringRun: false,
  externalSenderLabel: null,
  messageType: 'message',
  visibleToAgentId: null,
  metadata: {},
  ...over,
});

const event = (id: string, content: string, kind: string, createdAt: string) =>
  row({ id, content, createdAt, messageType: 'thread_event', metadata: { event_kind: kind } });

beforeEach(() => {
  listMessages.mockReset();
  listMessages.mockResolvedValue([
    row({ id: 'm1', userId: 'u1', content: 'hello', createdAt: '2026-10-20T10:00:00.000Z' }),
    row({
      id: 'm2',
      role: 'assistant',
      agentId: 'ada',
      content: 'hi there',
      createdAt: '2026-10-20T10:00:05.000Z',
    }),
    event('e1', RUN_ENDED, THREAD_EVENT_KIND.agentRunEnded, '2026-10-20T10:00:06.000Z'),
    event('e2', MODE_CHANGED, THREAD_EVENT_KIND.dispatchModeChanged, '2026-10-20T10:00:07.000Z'),
  ]);
});

describe('agent-run-ended row is hidden from agent replay', () => {
  it('the exported kind matches the emitter kind and prefix the UI relies on', () => {
    expect(THREAD_EVENT_KIND.agentRunEnded).toBe(AGENT_RUN_ENDED_EVENT_KIND);
    expect(RUN_ENDED.startsWith(THREAD_EVENT_LINE_PREFIX.agentRunEnded)).toBe(true);
  });

  it('(a) is not in the assembled replay payload', async () => {
    const { messages } = await buildReplayPayload('t', 'ada');
    const text = JSON.stringify(messages);
    expect(text).not.toContain('agent run ended');
    expect(text).not.toContain('tool calls]');
  });

  it('(b) other thread_event kinds still replay verbatim', async () => {
    const { messages } = await buildReplayPayload('t', 'ada');
    expect(messages.map((m) => m.content)).toContain(MODE_CHANGED);
  });

  it('drops it from the replay source rows but keeps it behind the watermark', async () => {
    const source = await loadReplaySource('t');
    expect(source.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'e2']);
    // Raw rows and the watermark still cover the footer, so voice catch-up
    // stays contiguous with what this read consumed.
    expect(source.messageRows.map((m) => m.id)).toContain('e1');
    expect(source.watermark?.id).toBe('e2');
  });
});

describe('isAgentRunEndedRow', () => {
  it('matches only the run-ended thread_event kind', () => {
    expect(
      isAgentRunEndedRow({
        messageType: 'thread_event',
        metadata: { event_kind: 'agent_run_ended' },
      })
    ).toBe(true);
    expect(
      isAgentRunEndedRow({
        messageType: 'thread_event',
        metadata: { event_kind: 'dispatch_mode_changed' },
      })
    ).toBe(false);
    // A human message that merely quotes the footer is untouched.
    expect(isAgentRunEndedRow({ messageType: 'message', metadata: {} })).toBe(false);
    expect(isAgentRunEndedRow({ messageType: 'thread_event', metadata: null })).toBe(false);
  });
});
