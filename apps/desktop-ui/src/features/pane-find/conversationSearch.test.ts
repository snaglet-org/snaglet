import { describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';
import { scanConversation, type ConversationMatch } from './conversationSearch';

const message = (id: string, content: string) => ({ id, content }) as ThreadMessage;
describe('complete conversation search', () => {
  it('searches beyond both the 200-row rendering cap and 20-page seek budget', async () => {
    const controller = new AbortController();
    const found: ConversationMatch[] = [];
    const fetchPage = vi.fn(async (before?: string) => {
      const page = before ? Number(before.split('-')[0]) - 1 : 25;
      return {
        messages: Array.from({ length: 200 }, (_, index) =>
          message(
            `${page}-${index}`,
            page === 1 && index === 0 ? 'rare match twice match' : 'ordinary'
          )
        ),
        hasMoreOlder: page > 1,
      };
    });
    await scanConversation('match', false, controller.signal, fetchPage, (matches) =>
      found.unshift(...matches)
    );
    expect(fetchPage).toHaveBeenCalledTimes(25);
    expect(found.map((match) => match.messageId)).toEqual(['1-0', '1-0']);
    expect(found[0]).toMatchObject({ from: 5, to: 10 });
  });
  it('aborts between pages without publishing stale results or requesting more pages', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async () => {
      controller.abort();
      return { messages: [message('1', 'target')], hasMoreOlder: true };
    });
    const onPage = vi.fn();
    await scanConversation('target', false, controller.signal, fetchPage, onPage);
    expect(onPage).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it('reports broken pagination instead of silently claiming a complete count', async () => {
    await expect(
      scanConversation(
        'target',
        false,
        new AbortController().signal,
        async () => ({ messages: [message('1', 'target')], hasMoreOlder: true }),
        vi.fn()
      )
    ).rejects.toThrow('stopped making progress');
  });
});
