import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';
import {
  MessageList,
  MAX_RENDERED,
  SEEK_CONTEXT_ROWS,
} from '@desktop/pages/Dashboard/views/ChatView/MessageList/MessageList';

vi.mock('@desktop/pages/Dashboard/views/ChatView/MessageRow/MessageRow', () => ({
  MessageRow: ({ message }: { message: ThreadMessage }) => (
    <div data-message-id={message.id}>{message.content}</div>
  ),
}));

describe('find rendering in long chat', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('CSS', { escape: (value: string) => value });
  });
  it('reveals a hit hidden by the render cap, highlights it and keeps rendering bounded', () => {
    const messages: ThreadMessage[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `message-${index}`,
      threadId: 'thread-test',
      role: 'user',
      content: index === 3 ? 'rare target' : 'ordinary text',
      agentId: null,
      createdAt: new Date(index * 1000).toISOString(),
    }));
    const props = {
      messages,
      activities: new Map(),
      agentNameById: new Map(),
      loading: false,
      renderMode: 'raw' as const,
    };
    const { container, rerender } = render(<MessageList {...props} />);
    expect(container.querySelector('[data-message-id="message-3"]')).toBeNull();
    rerender(
      <MessageList
        {...props}
        find={{
          messageId: 'message-3',
          query: 'target',
          caseSensitive: false,
          occurrence: 0,
          request: 'first',
        }}
      />
    );
    expect(container.querySelector('[data-message-id="message-3"]')).toHaveClass(
      'snaglet-find-message'
    );
    expect(container.querySelectorAll('[data-message-id]').length).toBeLessThanOrEqual(
      MAX_RENDERED + 2 * SEEK_CONTEXT_ROWS + 1
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    rerender(<MessageList {...props} />);
    expect(container.querySelector('.snaglet-find-message')).toBeNull();
  });
});
