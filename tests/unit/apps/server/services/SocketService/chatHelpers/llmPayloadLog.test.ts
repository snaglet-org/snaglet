import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const info = jest.fn<(message: string) => void>();
jest.mock('@server/services/LogsService', () => ({ LogsService: { info } }));

import { logLlmPayload } from '@server/services/SocketService/handlers/chatHelpers/llmPayloadLog';

const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (text: unknown): string => String(text).replace(ANSI_SGR, '');

function call() {
  logLlmPayload({
    agentName: 'Test Agent',
    model: 'test-provider/test-model',
    threadName: 'Test thread',
    threadId: 'thread-1111111111111-aaaaaaaaa',
    systemBlocks: [{ type: 'text', text: 'You are a careful assistant.' }],
    messages: [
      { role: 'user', content: 'my private question about payroll' },
      { role: 'assistant', content: 'a private answer' },
    ],
    tools: ['doc', 'table'],
    budget: { usableBudget: 120000 },
    iteration: 2,
    isGroup: false,
  } as unknown as Parameters<typeof logLlmPayload>[0]);
}

describe('logLlmPayload', () => {
  const original = process.env.SNAGLET_LOG_CONTENT;
  beforeEach(() => info.mockClear());
  afterEach(() => {
    if (original === undefined) delete process.env.SNAGLET_LOG_CONTENT;
    else process.env.SNAGLET_LOG_CONTENT = original;
  });

  it('logs one line with counts and no conversation text by default', () => {
    delete process.env.SNAGLET_LOG_CONTENT;
    call();

    expect(info).toHaveBeenCalledTimes(1);
    const line = strip(info.mock.calls[0]?.[0]);
    expect(line).not.toContain('\n');
    expect(line).toContain('LLM call Test Agent → test-provider/test-model');
    expect(line).toContain('2 messages (1 user, 1 assistant)');
    expect(line).toContain('2 tools');
    expect(line).not.toContain('payroll');
    expect(line).not.toContain('private answer');
    expect(line).not.toContain('careful assistant');
  });

  it('lists blocks and messages when SNAGLET_LOG_CONTENT=1', () => {
    process.env.SNAGLET_LOG_CONTENT = '1';
    call();

    const text = strip(info.mock.calls[0]?.[0]);
    expect(text).toContain('LLM Payload');
    expect(text).toContain('payroll');
  });
});
