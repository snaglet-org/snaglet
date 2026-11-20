const messagesCreate = jest.fn();
const wsBroadcast = jest.fn();

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: (...a: unknown[]) => messagesCreate(...a) },
}));

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => wsBroadcast(...a) },
}));

jest.mock('@server/services/LogsService', () => ({
  LogsService: { warn: jest.fn() },
}));

import {
  summarizeError,
  classifyRunError,
  persistRunErrorMessage,
} from '@server/services/SocketService/persistRunErrorMessage';

describe('persistRunErrorMessage — an agent with no model', () => {
  beforeEach(() => {
    messagesCreate.mockReset().mockResolvedValue(undefined);
    wsBroadcast.mockReset();
  });

  const persistNoModel = () =>
    persistRunErrorMessage({
      threadId: 'thread-1',
      agentId: 'test-agent-a',
      agentName: 'Ada',
      runId: null,
      kind: 'no_model',
      rawError: 'Pick a provider and model for Ada to answer.',
    });

  it('stores kind no_model in metadata.run_error, with the summary and a labeled body', async () => {
    const persisted = await persistNoModel();

    expect(persisted).toMatchObject({
      kind: 'no_model',
      summary: 'Pick a provider and model for Ada to answer.',
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const row = messagesCreate.mock.calls[0]![0] as {
      agentId: string;
      runId: string | null;
      content: string;
      metadata: { run_error: Record<string, unknown> };
    };
    expect(row.agentId).toBe('test-agent-a');
    expect(row.runId).toBeNull();
    expect(row.content).toBe('⚠ No model configured: Pick a provider and model for Ada to answer.');
    expect(row.metadata.run_error).toEqual({
      kind: 'no_model',
      summary: 'Pick a provider and model for Ada to answer.',
      provider: null,
      model_id: null,
      agent_name: 'Ada',
    });
  });

  it('broadcasts the row with kind no_model and no run id', async () => {
    await persistNoModel();

    expect(wsBroadcast).toHaveBeenCalledTimes(1);
    const [channel, frame] = wsBroadcast.mock.calls[0] as [
      string,
      { type: string; payload: Record<string, unknown> },
    ];
    expect(channel).toBe('thread-1');
    expect(frame.type).toBe('socket:chat:message_created');
    expect(frame.payload.run_id).toBeNull();
    expect(frame.payload.agent_id).toBe('test-agent-a');
    expect(frame.payload.run_error).toMatchObject({ kind: 'no_model', agent_name: 'Ada' });
  });

  it('falls back to the no-model label when there is no message', () => {
    expect(summarizeError('', 'no_model')).toBe('No model configured');
  });
});

describe('summarizeError', () => {
  it('strips stack-trace lines but keeps the message', () => {
    const err = new Error('upstream model returned 503');
    err.stack =
      'Error: upstream model returned 503\n    at fetch (/Users/foo/bar.ts:12:3)\n    at run';
    expect(summarizeError(err, 'model_failure')).toBe('upstream model returned 503');
  });

  it('redacts filesystem paths', () => {
    expect(summarizeError('config missing at /home/user/secret/keys.json', 'runtime')).toMatch(
      /\[path\]|~/
    );
    expect(
      summarizeError('config missing at /home/user/secret/keys.json', 'runtime')
    ).not.toContain('keys.json');
  });

  it('redacts bearer tokens and sk- keys', () => {
    expect(
      summarizeError('401 unauthorized: Bearer abc.def.ghi123_456 expired', 'runtime')
    ).toContain('[redacted]');
    expect(
      summarizeError('401 unauthorized: Bearer abc.def.ghi123_456 expired', 'runtime')
    ).not.toContain('abc.def.ghi123_456');
    expect(summarizeError('401: sk-proj-abcdefghij key invalid', 'runtime')).toContain(
      '[redacted]'
    );
  });

  it('falls back to a human label when the message is empty', () => {
    expect(summarizeError(new Error(''), 'timeout')).toBe('Response timed out');
  });

  it('truncates very long messages', () => {
    const long = 'x'.repeat(2000);
    const out = summarizeError(long, 'runtime');
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('classifyRunError', () => {
  it('classifies a stream-idle stall as a timeout (not a model failure)', () => {
    expect(
      classifyRunError(
        new Error('Model stream stalled: no output from openai for 5m; the call was aborted.')
      )
    ).toBe('timeout');
  });

  it('classifies timeout', () => {
    expect(classifyRunError(new Error('Agent response timed out after 60s'))).toBe('timeout');
  });

  it('classifies rate limits', () => {
    expect(classifyRunError(new Error('429 rate limit exceeded'))).toBe('rate_limit');
  });

  it('classifies aborts', () => {
    const e = new Error('AbortError: user aborted');
    e.name = 'AbortError';
    expect(classifyRunError(e)).toBe('aborted');
  });

  it('classifies provider/model errors', () => {
    expect(classifyRunError(new Error('provider overloaded — retry later'))).toBe('model_failure');
  });

  it('defaults unknown shapes to runtime', () => {
    expect(classifyRunError(new Error('thingie broke'))).toBe('runtime');
  });
});
