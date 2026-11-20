/**
 * apple-on-device provider — mocks AppleChatEngine (via the resolver) to
 * assert: onChunk deltas relay through, the ProviderChatResult shape is
 * correct, the provider never looks up a secret (keyless, like ollama), and
 * prompt flattening handles all four ProviderMessage shapes.
 */

jest.mock('@server/services/ProviderChatService/appleChat/appleChatResolver', () => ({
  getAppleChatEngine: jest.fn(),
  resolveAppleChatAvailability: jest.fn(),
}));

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { SnagletAgent } from '@server/services/AgentService';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import {
  chatAppleOnDevice,
  verifyAppleOnDevice,
  renderApplePrompt,
} from '@server/services/ProviderChatService/providers/apple-on-device';
import {
  getAppleChatEngine,
  resolveAppleChatAvailability,
} from '@server/services/ProviderChatService/appleChat/appleChatResolver';

const getEngineMock = getAppleChatEngine as jest.Mock;
const resolveAvailabilityMock = resolveAppleChatAvailability as jest.Mock;

function makeAgent(overrides: Partial<SnagletAgent> = {}): SnagletAgent {
  return {
    id: 'agent-1',
    name: 'Local Agent',
    provider: 'apple-on-device',
    modelId: 'apple-on-device',
    systemPrompt: 'Be terse.',
    // Deliberately no credentialId — proves the keyless path never needs one.
    credentialId: null,
    ...overrides,
  } as unknown as SnagletAgent;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('chatAppleOnDevice — keyless relay', () => {
  it('relays onChunk deltas and returns the ProviderChatResult shape, with no secret lookup', async () => {
    const chatMock = jest.fn(async (req: { onChunk?: (t: string) => void }) => {
      req.onChunk?.('Hello ');
      req.onChunk?.('world');
      return { text: 'Hello world', stopReason: 'end_turn' };
    });
    getEngineMock.mockReturnValue({ chat: chatMock });

    const chunks: string[] = [];
    const agent = makeAgent();
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    const result = await chatAppleOnDevice(agent, messages, (t) => chunks.push(t), {
      threadId: 'thread-1',
    });

    expect(chunks).toEqual(['Hello ', 'world']);
    expect(result).toEqual({ reply: 'Hello world', stopReason: 'end_turn', usage: undefined });
    expect(chatMock).toHaveBeenCalledTimes(1);
    const callArg = chatMock.mock.calls[0]![0] as {
      sessionKey: string;
      instructions?: string;
      prompt: string;
    };
    expect(callArg.sessionKey).toBe('agent-1:thread-1');
    expect(callArg.instructions).toBe('Be terse.');
    expect(callArg.prompt).toContain('Human: hi');
  });

  it('defaults sessionKey to "no-thread" when options.threadId is absent', async () => {
    const chatMock = jest.fn(async () => ({ text: 'ok', stopReason: 'end_turn' }));
    getEngineMock.mockReturnValue({ chat: chatMock });

    await chatAppleOnDevice(makeAgent(), [{ role: 'user', content: 'hi' }]);

    const callArg = chatMock.mock.calls[0]![0] as { sessionKey: string };
    expect(callArg.sessionKey).toBe('agent-1:no-thread');
  });

  it('throws a clear error when the engine is unavailable (defensive — should be unreachable once availability gating hides the provider)', async () => {
    getEngineMock.mockReturnValue(null);
    await expect(chatAppleOnDevice(makeAgent(), [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /unavailable on this machine/
    );
  });

  it('propagates an AbortError from the engine untouched', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    getEngineMock.mockReturnValue({
      chat: jest.fn(async () => {
        throw abortErr;
      }),
    });
    await expect(
      chatAppleOnDevice(makeAgent(), [{ role: 'user', content: 'hi' }])
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('renderApplePrompt', () => {
  it('flattens text messages into a Human/Assistant transcript ending with "Assistant:"', () => {
    const rendered = renderApplePrompt([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello!' },
    ]);
    expect(rendered).toBe('Human: hi there\n\nAssistant: hello!\n\nAssistant:');
  });

  it('flattens tool_use/tool_result blocks to readable text (history from an earlier tool-capable turn)', () => {
    const rendered = renderApplePrompt([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'NYC' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sunny, 72F' }],
      },
    ]);
    expect(rendered).toContain('[called tool get_weather({"city":"NYC"})]');
    expect(rendered).toContain('[tool result: sunny, 72F]');
  });

  it('flattens image blocks to a marker', () => {
    const rendered = renderApplePrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
        ],
      },
    ]);
    expect(rendered).toContain('what is this');
    expect(rendered).toContain('[image attached]');
  });

  it('skips messages that flatten to empty text', () => {
    const rendered = renderApplePrompt([{ role: 'user', content: '   ' }]);
    expect(rendered).toBe('Assistant:');
  });
});

describe('verifyAppleOnDevice', () => {
  it('is valid when the sidecar reports available', async () => {
    resolveAvailabilityMock.mockResolvedValue({ available: true });
    const result = await verifyAppleOnDevice('');
    expect(result.valid).toBe(true);
  });

  it('is invalid with the honest reason when unavailable', async () => {
    resolveAvailabilityMock.mockResolvedValue({
      available: false,
      reason: 'appleIntelligenceNotEnabled',
    });
    const result = await verifyAppleOnDevice('');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('appleIntelligenceNotEnabled');
  });
});
