import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    http: jest.fn(),
  },
}));

import { logger } from '@server/config/logger';
import { LogsService } from '@server/services/LogsService';

type LogFn = jest.Mock<(message: string, meta?: Record<string, unknown>) => void>;
const mockLog = logger as unknown as Record<'info' | 'warn' | 'error' | 'debug' | 'http', LogFn>;

const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: unknown): string => String(text).replace(ANSI_SGR, '');

beforeEach(() => {
  for (const fn of Object.values(mockLog)) fn.mockClear();
});

describe('LogsService line meta', () => {
  it('hands the logger only the fields the line prefix does not already show', () => {
    LogsService.info('message sent', {
      agentName: 'test-agent-a',
      threadId: 'thread-1',
      modelName: 'test-model',
      tokens: 156,
      provider: 'test-provider',
    });

    expect(mockLog.info).toHaveBeenCalledTimes(1);
    const [message, meta] = mockLog.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(stripAnsi(message)).toBe(
      '[server][test-agent-a][thread: thread-1][test-model] message sent'
    );
    expect(meta).toEqual({ tokens: 156, provider: 'test-provider' });
  });

  it('carries the error block as `stack` so it renders under the line', () => {
    const failure = new Error('boom');
    LogsService.chat.error(failure, { threadId: 'thread-1', sessionId: 'session-1' });

    const [message, meta] = mockLog.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(stripAnsi(message)).toContain('[chat]');
    expect(stripAnsi(message)).not.toContain('boom');
    expect(meta.sessionId).toBe('session-1');
    expect(stripAnsi(meta.stack)).toMatch(/^ {2}Error: boom\nError: boom\n\s+at /);
  });

  it('renders a thrown non-Error as its content, not [object Object]', () => {
    LogsService.agent.error({ type: 'overloaded_error', message: 'try later' });

    const [, meta] = mockLog.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(stripAnsi(meta.stack)).toBe(
      '  UnknownError: {"type":"overloaded_error","message":"try later"}'
    );
  });

  it('renames caller fields that would collide with the logger-owned keys', () => {
    LogsService.warn('odd meta', { message: 'caller text', level: 'custom' });

    const [, meta] = mockLog.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toEqual({ 'meta.message': 'caller text', 'meta.level': 'custom' });
  });

  it('leaves tool lines to their own rendering (no duplicated input/output)', () => {
    LogsService.tool.start({ toolName: 'test-tool', input: '{"q":1}' });

    expect(mockLog.info).toHaveBeenCalledTimes(1);
    expect(mockLog.info.mock.calls[0]).toHaveLength(1);
  });
});

describe('LogsService keeps conversation content out by default', () => {
  const original = process.env.SNAGLET_LOG_CONTENT;
  afterEach(() => {
    if (original === undefined) delete process.env.SNAGLET_LOG_CONTENT;
    else process.env.SNAGLET_LOG_CONTENT = original;
  });

  it('keep tool inputs and outputs out of the log by default', () => {
    delete process.env.SNAGLET_LOG_CONTENT;
    LogsService.tool.start({ toolName: 'doc', input: '{"op":"get","id":"doc-1"}' });
    LogsService.tool.end({ toolName: 'doc', success: true, durationMs: 12, output: 'secret body' });

    const call = stripAnsi(mockLog.info.mock.calls[0]?.[0]);
    const result = stripAnsi(mockLog.info.mock.calls[1]?.[0]);
    expect(call).toMatch(/\[tool call\]\[doc\]$/);
    expect(call).not.toContain('doc-1');
    expect(result).toMatch(/\[tool result\]\[doc\] ok 12ms$/);
    expect(result).not.toContain('secret body');
  });

  it('keep a short reason on a failed tool result', () => {
    delete process.env.SNAGLET_LOG_CONTENT;
    LogsService.tool.end({
      toolName: 'browser',
      success: false,
      durationMs: 9,
      output: 'full page text',
      error: 'You have no tab "t1". Use op:tabs to list yours.',
    });

    const line = stripAnsi(mockLog.info.mock.calls[0]?.[0]);
    expect(line).toContain('[browser] fail 9ms You have no tab "t1".');
    expect(line).not.toContain('full page text');
  });

  it('drop message text from user lines and content fields from event meta', () => {
    delete process.env.SNAGLET_LOG_CONTENT;
    LogsService.user.message({ userName: 'Test User', threadName: 'T', text: 'my private note' });
    LogsService.socket.event('assistant message', {
      threadName: 'T',
      text: 'a private reply',
      runId: 'r1',
    });

    expect(stripAnsi(mockLog.info.mock.calls[0]?.[0])).not.toContain('private');
    const [line, meta] = mockLog.info.mock.calls[1] as [string, Record<string, unknown>];
    expect(stripAnsi(line)).toContain('assistant message');
    expect(meta).toEqual({ runId: 'r1' });
  });

  it('include them when SNAGLET_LOG_CONTENT=1', () => {
    process.env.SNAGLET_LOG_CONTENT = '1';
    LogsService.tool.start({ toolName: 'doc', input: '{"op":"get"}' });
    LogsService.tool.end({ toolName: 'doc', success: true, durationMs: 3, output: 'body' });

    expect(stripAnsi(mockLog.info.mock.calls[0]?.[0])).toContain('[doc] input: {"op":"get"}');
    expect(stripAnsi(mockLog.info.mock.calls[1]?.[0])).toContain('ok 3ms body');
  });
});
