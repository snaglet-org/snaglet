/**
 * MessageRow: task-list checkboxes in a message. A tick lands on the item
 * clicked even though a user bubble's rendered offsets drift from the stored
 * text; it shows in the raw view and says so when it can't be saved. The
 * row's local copy gives way to socket:chat:message_updated once its saves
 * settle, and an earlier tick's echo never flashes over a newer one.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { threadsApi } from '@desktop/utils/api/threads';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import { MessageRow } from './MessageRow';

const LIST = '- [ ] first\n- [ ] second\n- [ ] third\n- [ ] fourth';

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    role: 'user',
    agentId: null,
    content: LIST,
    createdAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageRow — checkbox toggles', () => {
  it('ticks the item that was clicked in a multi-line user bubble', async () => {
    const save = vi.spyOn(threadsApi, 'updateMessageContent').mockResolvedValue(undefined as never);
    render(<MessageRow message={message()} agentNameById={new Map()} renderMode="md" />);

    fireEvent.click(screen.getAllByRole('checkbox')[2]!);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      'thread-1',
      'msg-1',
      '- [ ] first\n- [ ] second\n- [x] third\n- [ ] fourth'
    );
  });

  it('ticks the clicked item in an agent bubble too', async () => {
    const save = vi.spyOn(threadsApi, 'updateMessageContent').mockResolvedValue(undefined as never);
    render(
      <MessageRow
        message={message({ role: 'assistant', agentId: 'test-agent-a' })}
        agentNameById={new Map()}
        renderMode="md"
      />
    );

    fireEvent.click(screen.getAllByRole('checkbox')[3]!);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![2]).toBe('- [ ] first\n- [ ] second\n- [ ] third\n- [x] fourth');
  });

  it('shows the tick in the raw view', async () => {
    vi.spyOn(threadsApi, 'updateMessageContent').mockResolvedValue(undefined as never);
    const props = { message: message(), agentNameById: new Map<string, string>() };
    const { container, rerender } = render(<MessageRow {...props} renderMode="md" />);

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    rerender(<MessageRow {...props} renderMode="raw" />);

    expect(container.querySelector('.snaglet-message-find-text')?.textContent).toBe(
      '- [x] first\n- [ ] second\n- [ ] third\n- [ ] fourth'
    );
  });

  it('reverts the tick and says so when it cannot be saved', async () => {
    vi.spyOn(threadsApi, 'updateMessageContent').mockRejectedValue(new Error('offline'));
    const toasts: string[] = [];
    const onToast = (event: Event) =>
      toasts.push((event as CustomEvent<ToastDetail>).detail.message);
    window.addEventListener(TOAST_EVENT_NAME, onToast);
    try {
      render(<MessageRow message={message()} agentNameById={new Map()} renderMode="md" />);

      fireEvent.click(screen.getAllByRole('checkbox')[0]!);

      await waitFor(() => expect(toasts).toEqual(['Couldn’t save the checkbox: offline']));
      expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();
    } finally {
      window.removeEventListener(TOAST_EVENT_NAME, onToast);
    }
  });

  it('gives way to the saved content, so a later edit from another view shows', async () => {
    vi.spyOn(threadsApi, 'updateMessageContent').mockResolvedValue(undefined as never);
    const props = { agentNameById: new Map<string, string>(), renderMode: 'md' as const };
    const { rerender } = render(<MessageRow {...props} message={message()} />);

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    // This row's own echo.
    rerender(
      <MessageRow
        {...props}
        message={message({ content: '- [x] first\n- [ ] second\n- [ ] third\n- [ ] fourth' })}
      />
    );
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeChecked());
    // Another view ticks the second item on top of that.
    rerender(
      <MessageRow
        {...props}
        message={message({ content: '- [x] first\n- [x] second\n- [ ] third\n- [ ] fourth' })}
      />
    );

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
  });

  it('does not flash an earlier tick’s echo over a quick untick', async () => {
    const settle: Array<() => void> = [];
    vi.spyOn(threadsApi, 'updateMessageContent').mockImplementation(
      () => new Promise((resolve) => settle.push(() => resolve(undefined as never)))
    );
    const props = { agentNameById: new Map<string, string>(), renderMode: 'md' as const };
    const { rerender } = render(<MessageRow {...props} message={message()} />);

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();

    // The tick's echo lands while both saves are still out.
    rerender(
      <MessageRow
        {...props}
        message={message({ content: '- [x] first\n- [ ] second\n- [ ] third\n- [ ] fourth' })}
      />
    );
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();

    await act(async () => settle[0]!());
    rerender(<MessageRow {...props} message={message()} />);
    await act(async () => settle[1]!());
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();

    // Both saves settled and matched: another view's edit now shows.
    rerender(
      <MessageRow
        {...props}
        message={message({ content: '- [ ] first\n- [ ] second\n- [x] third\n- [ ] fourth' })}
      />
    );
    expect(screen.getAllByRole('checkbox')[2]).toBeChecked();
  });
});
