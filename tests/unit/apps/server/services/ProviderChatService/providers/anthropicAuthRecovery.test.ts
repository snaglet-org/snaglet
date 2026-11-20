/**
 * Claude Code token handling around chatAnthropic: the live keychain token
 * replaces a stale snapshot before the request, a 401 with a rotated token
 * retries exactly once, a 401 with nothing newer fails with a re-auth
 * message, and a token already known to be dead is refused before any call.
 */
jest.mock('@server/services/ProviderChatService/shared', () => {
  const actual = jest.requireActual('@server/services/ProviderChatService/shared');
  return {
    ...actual,
    pickSecret: jest.fn(async () => 'sk-ant-oat01-stored'),
    pickCredentialId: jest.fn(async () => 'cred-1'),
    logProviderPayload: jest.fn(),
  };
});
jest.mock('@server/services/ToolService', () => ({ toAnthropicTools: jest.fn(() => []) }));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockResolve = jest.fn();
const mockRecover = jest.fn();
const mockKnownBad = jest.fn(() => false);
const mockRejected = jest.fn(async () => undefined);
jest.mock('@server/services/ClaudeCodeAuthService/recovery', () => ({
  CLAUDE_CODE_REAUTH_MESSAGE: 'Claude Code login has expired or been revoked.',
  resolveClaudeCodeSecret: (...a: unknown[]) => mockResolve(...a),
  recoverClaudeCodeToken: (...a: unknown[]) => mockRecover(...a),
  isClaudeCodeTokenKnownBad: (...a: unknown[]) => mockKnownBad(...a),
  markClaudeCodeTokenRejected: (...a: unknown[]) => mockRejected(...a),
}));

const mockCliVersion = jest.fn(async () => ({ version: '2.1.300', source: 'detected' }));
const mockForgetCliVersion = jest.fn();
jest.mock('@server/services/ProviderChatService/providers/claudeCliVersion', () => {
  const actual = jest.requireActual(
    '@server/services/ProviderChatService/providers/claudeCliVersion'
  );
  return {
    ...actual,
    getClaudeCliVersion: () => mockCliVersion(),
    forgetClaudeCliVersion: () => mockForgetCliVersion(),
  };
});

import type { SnagletAgent } from '@server/services/AgentService';
import { chatAnthropic } from '@server/services/ProviderChatService/providers/anthropic';

const agent = {
  id: 'agent-1',
  name: 'Test Agent',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  systemPrompt: 'be helpful',
} as unknown as SnagletAgent;

function okStream(text: string): Response {
  const enc = new TextEncoder();
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events)
        controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const unauthorized = () =>
  new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'OAuth access token has been revoked' },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
const versionRejected = () =>
  new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Claude Code 2.1.300 does not support this model; run `claude update` to use it.',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } }
  );
const requestHeaders = (call: unknown[]) =>
  (call[1] as RequestInit).headers as Record<string, string>;
const authHeader = (call: unknown[]) => requestHeaders(call)['Authorization'];

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockImplementation(async (secret: string) => secret);
  mockKnownBad.mockReturnValue(false);
  mockCliVersion.mockResolvedValue({ version: '2.1.300', source: 'detected' });
});
afterEach(() => jest.restoreAllMocks());

describe('chatAnthropic Claude Code auth', () => {
  test('sends the live keychain token when it differs from the stored snapshot', async () => {
    mockResolve.mockResolvedValue('sk-ant-oat01-live');
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okStream('hi'));
    const result = await chatAnthropic(agent, [{ role: 'user', content: 'hello' }]);
    expect(result.reply).toBe('hi');
    expect(mockResolve).toHaveBeenCalledWith('sk-ant-oat01-stored', 'cred-1');
    expect(authHeader(fetchSpy.mock.calls[0])).toBe('Bearer sk-ant-oat01-live');
  });

  test('retries once with the rotated token after a 401', async () => {
    mockRecover.mockResolvedValue('sk-ant-oat01-rotated');
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(okStream('recovered'));
    const result = await chatAnthropic(agent, [{ role: 'user', content: 'hello' }]);
    expect(result.reply).toBe('recovered');
    expect(mockRecover).toHaveBeenCalledWith('sk-ant-oat01-stored', 'cred-1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(authHeader(fetchSpy.mock.calls[1])).toBe('Bearer sk-ant-oat01-rotated');
  });

  test('a 401 on the rotated token too marks it rejected and does not retry again', async () => {
    mockRecover.mockResolvedValue('sk-ant-oat01-rotated');
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(unauthorized());
    await expect(chatAnthropic(agent, [{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'Claude Code login has expired or been revoked.'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(mockRejected).toHaveBeenCalledWith('sk-ant-oat01-rotated');
  });

  test('fails with a re-authentication message when the keychain has nothing newer', async () => {
    mockRecover.mockResolvedValue(null);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(unauthorized());
    await expect(chatAnthropic(agent, [{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'Claude Code login has expired or been revoked.'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a token already known to be revoked is refused before any request', async () => {
    mockKnownBad.mockReturnValue(true);
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(chatAnthropic(agent, [{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'Claude Code login has expired or been revoked.'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockRecover).not.toHaveBeenCalled();
  });

  test('presents the installed Claude Code version, not a hardcoded one', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okStream('hi'));
    await chatAnthropic(agent, [{ role: 'user', content: 'hello' }]);
    expect(requestHeaders(fetchSpy.mock.calls[0])['User-Agent']).toBe('claude-cli/2.1.300');
  });

  test('rewrites the "run claude update" 400 into Snaglet copy and re-detects the version', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(versionRejected());
    const failure = chatAnthropic(agent, [{ role: 'user', content: 'hello' }]);
    await expect(failure).rejects.toThrow(/installed Claude Code CLI \(2\.1\.300\)/);
    await expect(failure).rejects.toThrow(/status=400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockForgetCliVersion).toHaveBeenCalled();
    expect(mockRecover).not.toHaveBeenCalled();
  });

  test('a 401 on a plain API key is not routed through Claude Code recovery', async () => {
    mockResolve.mockResolvedValue('sk-ant-api03-key');
    jest.spyOn(global, 'fetch').mockResolvedValue(unauthorized());
    await expect(chatAnthropic(agent, [{ role: 'user', content: 'hello' }])).rejects.toThrow(
      /revoked.*status=401/
    );
    expect(mockRecover).not.toHaveBeenCalled();
  });
});
