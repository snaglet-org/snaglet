import { safeJsonParse } from '@snaglet/shared/utils';

async function* readSSEDataEvents(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        yield raw;
      }
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const raw = tail.slice(5).trim();
    if (raw && raw !== '[DONE]') yield raw;
  }
}

export async function* readSSEJsonEvents<T extends Record<string, unknown>>(
  body: ReadableStream<Uint8Array>,
  /** Fired on every raw read from the stream (see ProviderChatOptions.onStreamActivity). */
  onActivity?: () => void
): AsyncGenerator<T> {
  for await (const raw of readSSEDataEvents(body, onActivity)) {
    const parsed = safeJsonParse<T>(raw);
    if (parsed) yield parsed;
  }
}
