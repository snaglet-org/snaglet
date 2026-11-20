/**
 * TokenEstimator unit tests.
 *
 * Golden tiktoken counts below were computed directly with js-tiktoken
 * (same library, same rank tables) — they pin the strategy wiring, not the
 * library's correctness. The unicode sample intentionally has different
 * counts under o200k vs cl100k to prove encoding selection by model family.
 */

import {
  estimateTokens,
  estimateMessageTokens,
  estimateSessionTokens,
} from '@server/services/TokenEstimator';
import type { ProviderMessage } from '@server/services/ProviderChatService';

const UNICODE_SAMPLE = 'Tokenization differs across vocabularies — émojis 🎉 and ünïcödé too.';

describe('estimateTokens — strategy selection', () => {
  test('openai uses tiktoken o200k_base (exact golden counts)', () => {
    expect(estimateTokens('hello world', 'openai', 'gpt-4o')).toBe(2);
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.', 'openai', 'gpt-4o')).toBe(
      10
    );
    expect(
      estimateTokens('function add(a: number, b: number): number { return a + b; }', 'openai')
    ).toBe(18);
  });

  test('legacy gpt-4 selects cl100k_base; modern models select o200k_base', () => {
    // Same text, different vocabularies → different counts.
    expect(estimateTokens(UNICODE_SAMPLE, 'openai', 'gpt-4')).toBe(24); // cl100k
    expect(estimateTokens(UNICODE_SAMPLE, 'openai', 'gpt-4o')).toBe(20); // o200k
    expect(estimateTokens(UNICODE_SAMPLE, 'codex', 'gpt-5.2')).toBe(20); // o200k
  });

  test('copilot picks by model id — gpt models exact, claude models heuristic', () => {
    expect(estimateTokens('hello world', 'copilot', 'gpt-4o')).toBe(2); // tiktoken
    // Non-gpt copilot models fall back to the char heuristic (default 4.0 —
    // copilot has no provider-specific ratio entry).
    expect(estimateTokens('hello world', 'copilot', 'claude-opus-4.5')).toBe(
      Math.ceil('hello world'.length / 4.0)
    );
  });

  test('anthropic uses the tuned 3.5 chars/token heuristic', () => {
    expect(estimateTokens('1234567', 'anthropic')).toBe(2);
    expect(estimateTokens('x'.repeat(35), 'anthropic', 'claude-sonnet-4-5')).toBe(10);
  });

  test('unknown providers fall back to 4.0 chars/token', () => {
    expect(estimateTokens('123456789', 'unknown')).toBe(3);
    expect(estimateTokens('x'.repeat(40), 'ollama', 'llama3')).toBe(10);
  });

  test('empty text is zero for every strategy', () => {
    expect(estimateTokens('', 'openai', 'gpt-4o')).toBe(0);
    expect(estimateTokens('', 'anthropic')).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  test('adds per-message overhead (tiktoken path)', () => {
    const msg: ProviderMessage = { role: 'user', content: 'hello world' };
    expect(estimateMessageTokens(msg, 'openai', 'gpt-4o')).toBe(2 + 4);
  });

  test('estimates a plain text message with overhead (heuristic path)', () => {
    const message = { role: 'user', content: 'abcdefgh' } as const;
    // ceil(8 / 4) + 4 overhead = 6
    expect(estimateMessageTokens(message, 'together')).toBe(6);
  });

  test('includes text, tool_use, and tool_result block content (heuristic path)', () => {
    const toolInput = { query: 'status', limit: 5 };

    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello world' }, // 11 chars
        { type: 'tool_use', id: 't1', name: 'search', input: toolInput },
        { type: 'tool_result', tool_use_id: 't1', content: 'done' }, // 4 chars
      ],
    } as const;

    // Per-block ceil under the 4.0 ratio (strategy counts each block separately).
    const expected =
      Math.ceil(11 / 4) +
      Math.ceil('search'.length / 4) +
      Math.ceil(JSON.stringify(toolInput).length / 4) +
      Math.ceil(4 / 4) +
      4;
    expect(estimateMessageTokens(message as unknown as ProviderMessage, 'together')).toBe(expected);
  });

  test('tool_result string and block-array contents both count (tiktoken path)', () => {
    const asString = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'hello world' }],
    } as unknown as ProviderMessage;
    const asBlocks = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          content: [{ type: 'text', text: 'hello world' }],
        },
      ],
    } as unknown as ProviderMessage;
    expect(estimateMessageTokens(asString, 'openai', 'gpt-4o')).toBe(2 + 4);
    expect(estimateMessageTokens(asBlocks, 'openai', 'gpt-4o')).toBe(2 + 4);
  });

  test('images cost a flat 1500', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }],
    } as unknown as ProviderMessage;
    expect(estimateMessageTokens(msg, 'anthropic')).toBe(1500 + 4);
  });
});

describe('estimateSessionTokens', () => {
  test('sums system prompt + messages with overheads (tiktoken path)', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hello world' },
    ];
    // system: 2 + 4 overhead; each message: 2 + 4 overhead
    expect(estimateSessionTokens(messages, 'hello world', 'openai', 'gpt-4o')).toBe(6 + 6 + 6);
  });

  test('sums system prompt and message estimates (heuristic path)', () => {
    const messages = [
      { role: 'user', content: '12345678' }, // 8 chars => 2 + 4
      { role: 'assistant', content: '1234' }, // 4 chars => 1 + 4
    ] as const;
    const total = estimateSessionTokens(
      messages as unknown as ProviderMessage[],
      '12345678',
      'together'
    );
    expect(total).toBe(2 + 4 + (2 + 4) + (1 + 4));
  });

  test('omits system overhead when system prompt is undefined', () => {
    expect(estimateSessionTokens([], undefined, 'openai', 'gpt-4o')).toBe(0);
  });
});
