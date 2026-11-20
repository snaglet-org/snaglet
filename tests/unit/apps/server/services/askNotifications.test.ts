/**
 * askNotifications in isolation: who the title names, what the body shows,
 * and that a failing notification never reaches the ask (create, dismiss and
 * name lookups may all fail; the handle still resolves).
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NotificationRecord } from '@snaglet/shared/types';

const createAsk = jest.fn<(params: Record<string, unknown>) => Promise<NotificationRecord>>();
const dismiss = jest.fn<(id: string) => Promise<NotificationRecord | null>>();
const findAgent =
  jest.fn<
    (id: string) => Promise<{ id: string; name: string; parentAgentId: string | null } | null>
  >();
const findSubagent = jest.fn<(agentId: string) => Promise<{ name: string } | null>>();

jest.mock('@server/services/NotificationService', () => ({
  notificationService: {
    createAsk: (params: Record<string, unknown>) => createAsk(params),
    dismiss: (id: string) => dismiss(id),
  },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (id: string) => findAgent(id) },
}));
jest.mock('@snaglet/db/tables/subagents', () => ({
  Subagents: { findByAgentId: (agentId: string) => findSubagent(agentId) },
}));
jest.mock('@server/config/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import {
  ASK_PREVIEW_CHARS,
  notifyClarificationAsk,
  notifyToolApprovalAsk,
} from '@server/services/askNotifications';

const AGENTS = {
  'test-agent-a': { id: 'test-agent-a', name: 'Test Agent A', parentAgentId: null },
  'subagent-test-a': {
    id: 'subagent-test-a',
    name: 'helper row name',
    parentAgentId: 'test-agent-a',
  },
} as const;

function record(id: string): NotificationRecord {
  return {
    id,
    type: 'tool_approval',
    title: '',
    body: null,
    threadId: null,
    agentId: null,
    runId: null,
    read: false,
    dismissed: false,
    createdAt: '2026-10-12T00:00:00.000Z',
  };
}

let nextCall = 0;
function callId(): string {
  nextCall += 1;
  return `call-${nextCall}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  createAsk.mockImplementation(async () => record('notif-ask-test-1'));
  dismiss.mockImplementation(async (id) => ({ ...record(id), dismissed: true }));
  findAgent.mockImplementation(async (id) => AGENTS[id as keyof typeof AGENTS] ?? null);
  findSubagent.mockImplementation(async () => ({ name: 'Test Helper A' }));
});

describe('ask notification content', () => {
  it("names a helper by its orchestrator and its subagent row's name", async () => {
    const ask = notifyToolApprovalAsk({
      threadId: 'thread-helper',
      callId: callId(),
      agentId: 'subagent-test-a',
      toolName: 'shell',
      inputSummary: '{\n  "command": "git status"\n}',
    });
    await ask.notificationId;

    expect(createAsk).toHaveBeenCalledWith({
      type: 'tool_approval',
      title: "Test Agent A's subagent Test Helper A needs your approval",
      body: 'Wants to use shell. Open the thread to see the details.',
      threadId: 'thread-helper',
      agentId: 'subagent-test-a',
      runId: null,
    });
  });

  it('names the tool and its op but never the arguments (they may hold secrets)', async () => {
    const ask = notifyToolApprovalAsk({
      threadId: 'thread-a',
      callId: callId(),
      agentId: 'test-agent-a',
      toolName: 'shell',
      inputSummary: JSON.stringify({
        op: 'run',
        cmd: 'curl -H "Authorization: Bearer test-token"',
      }),
    });
    await ask.notificationId;

    const body = createAsk.mock.calls[0]?.[0].body as string;
    expect(body).toBe('Wants to use shell (run). Open the thread to see the details.');
    expect(body).not.toContain('test-token');
    expect(body.length).toBeLessThanOrEqual(ASK_PREVIEW_CHARS + 1);
  });

  it('previews a Triage form by its first question and the count of the rest', async () => {
    const ask = notifyClarificationAsk({
      threadId: 'thread-a',
      callId: callId(),
      agentId: 'test-agent-a',
      runId: 'run-a',
      request: {
        preamble: 'Before I deploy:',
        questions: [
          { id: 'target', prompt: 'Which environment?', type: 'single_select', options: ['a'] },
          { id: 'window', prompt: 'When?', type: 'text' },
          { id: 'notify', prompt: 'Who to tell?', type: 'text' },
        ],
      },
    });
    await ask.notificationId;

    expect(createAsk).toHaveBeenCalledWith({
      type: 'mention',
      title: 'Test Agent A needs your answer',
      body: 'Which environment? (+2 more)',
      threadId: 'thread-a',
      agentId: 'test-agent-a',
      runId: 'run-a',
    });
  });

  it('falls back to "An agent" when the name lookup fails', async () => {
    findAgent.mockRejectedValueOnce(new Error('lookup down'));
    const ask = notifyToolApprovalAsk({
      threadId: 'thread-a',
      callId: callId(),
      agentId: 'test-agent-a',
      toolName: 'shell',
      inputSummary: '{}',
    });
    await ask.notificationId;

    expect(createAsk.mock.calls[0]?.[0].title).toBe('An agent needs your approval');
  });
});

describe('notification failures stay away from the ask', () => {
  it('a failed create resolves to no id, and settling it dismisses nothing', async () => {
    createAsk.mockRejectedValueOnce(new Error('insert failed'));
    const ask = notifyToolApprovalAsk({
      threadId: 'thread-a',
      callId: callId(),
      agentId: 'test-agent-a',
      toolName: 'shell',
      inputSummary: '{}',
    });

    await expect(ask.notificationId).resolves.toBeNull();
    await expect(ask.settle()).resolves.toBeUndefined();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('a failed dismiss still settles, and settling twice dismisses once', async () => {
    dismiss.mockRejectedValueOnce(new Error('update failed'));
    const ask = notifyToolApprovalAsk({
      threadId: 'thread-a',
      callId: callId(),
      agentId: 'test-agent-a',
      toolName: 'shell',
      inputSummary: '{}',
    });

    await expect(ask.settle()).resolves.toBeUndefined();
    await expect(ask.settle()).resolves.toBeUndefined();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith('notif-ask-test-1');
  });

  it('a settled ask frees its call id for a new notification', async () => {
    const input = {
      threadId: 'thread-a',
      callId: callId(),
      agentId: 'test-agent-a',
      toolName: 'shell',
      inputSummary: '{}',
    };
    const first = notifyToolApprovalAsk(input);
    await first.settle();

    const second = notifyToolApprovalAsk(input);
    expect(second).not.toBe(first);
    await second.notificationId;
    expect(createAsk).toHaveBeenCalledTimes(2);
  });
});
