import { describe, it, expect, jest } from '@jest/globals';
import { readSSEJsonEvents } from '@server/services/ProviderChatService/providers/shared/sse';
import { collectOpenAICompatibleChatCompletionSSE } from '@server/services/ProviderChatService/providers/shared/chat-completions';

/**
 * The stream-idle watchdog must see tool-call argument streaming as activity.
 * Those deltas fire no onChunk/onThinkingChunk/onUsage callback, so the shared
 * readers fire `onActivity` on every raw read.
 */
function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

describe('provider stream activity hook', () => {
  it('readSSEJsonEvents fires onActivity once per raw read, even mid-event', async () => {
    const onActivity = jest.fn();
    const parts = [
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"pa',
      'th\\":\\"/x\\"}"}}\n\n',
      ': ping\n\n',
    ];
    const events: unknown[] = [];
    for await (const ev of readSSEJsonEvents(streamOf(parts), onActivity)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it('chat-completions reader counts tool-call argument deltas as activity', async () => {
    const onActivity = jest.fn();
    const onChunk = jest.fn();
    const delta = (args: string, first = false) =>
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  ...(first
                    ? { id: 'call_1', function: { name: 'file_write', arguments: args } }
                    : {}),
                  ...(!first ? { function: { arguments: args } } : {}),
                },
              ],
            },
          },
        ],
      })}\n\n`;
    const parts = [delta('{"pa', true), delta('th":"/x"'), delta('}'), 'data: [DONE]\n\n'];
    const result = await collectOpenAICompatibleChatCompletionSSE(
      streamOf(parts),
      onChunk,
      undefined,
      undefined,
      onActivity
    );
    expect(onChunk).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledTimes(4);
    expect(result.toolCalls?.[0]?.name).toBe('file_write');
  });
});
