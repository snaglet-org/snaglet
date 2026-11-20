import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsMessage } from '@snaglet/shared/types';
import type { ThreadMessage } from '@desktop/utils/api';
import { PaneFindProvider } from './PaneFindContext';
import { useConversationFind } from './useConversationFind';

const { getMessages, wsListeners } = vi.hoisted(() => ({
  getMessages: vi.fn(),
  wsListeners: new Set<(frame: WsMessage) => void>(),
}));
vi.mock('@desktop/utils/api', () => ({ threadsApi: { getMessages } }));
vi.mock('@desktop/ws/useWs', () => ({
  useWs: () => ({
    addMessageListener: (listener: (frame: WsMessage) => void) => {
      wsListeners.add(listener);
      return () => wsListeners.delete(listener);
    },
  }),
}));

function pushFrame(frame: WsMessage) {
  act(() => {
    for (const listener of [...wsListeners]) listener(frame);
  });
}

function message(id: string, content: string): ThreadMessage {
  return {
    id,
    content,
    threadId: 'thread-test',
    role: 'user',
    agentId: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}
const loaded = [message('recent', 'The recent message')];
function Harness() {
  const find = useConversationFind('thread-test', loaded);
  return (
    <>
      {find.bar}
      <div data-testid="find-result">{find.target?.messageId}</div>
      <div data-testid="displayed-count">{find.displayedMessages.length}</div>
    </>
  );
}
function startSearch(query: string) {
  fireEvent.keyDown(window, { key: 'f', metaKey: true });
  fireEvent.change(screen.getByRole('textbox', { name: 'Find in conversation' }), {
    target: { value: query },
  });
}

describe('conversation find orchestration', () => {
  beforeEach(() => {
    getMessages.mockReset();
    wsListeners.clear();
  });
  it('loads a bounded context window for an old hit without rendering its full scanned page', async () => {
    const old = message('old', 'rare target');
    getMessages.mockImplementation(async (_id, opts) =>
      opts.around
        ? { messages: [old], hasMoreOlder: true, hasMoreNewer: true }
        : {
            messages: [
              old,
              ...Array.from({ length: 199 }, (_, index) =>
                message(`ordinary-${index}`, 'ordinary')
              ),
            ],
            hasMoreOlder: false,
          }
    );
    render(
      <PaneFindProvider isActive>
        <Harness />
      </PaneFindProvider>
    );
    startSearch('target');
    await waitFor(() => expect(screen.getByTestId('find-result')).toHaveTextContent('old'));
    await waitFor(() => expect(screen.getByTestId('displayed-count')).toHaveTextContent('2'));
    expect(getMessages).toHaveBeenCalledWith(
      'thread-test',
      expect.objectContaining({ around: 'old', limit: 50 })
    );
    expect(screen.getByText('All 200 saved messages searched')).toBeInTheDocument();
  });
  it('aborts a replaced query and ignores its late completion', async () => {
    let finishOld: ((value: unknown) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    getMessages
      .mockImplementationOnce((_id, opts) => {
        oldSignal = opts.signal;
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      })
      .mockResolvedValue({ messages: [loaded[0]], hasMoreOlder: false });
    render(
      <PaneFindProvider isActive>
        <Harness />
      </PaneFindProvider>
    );
    startSearch('obsolete');
    await waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in conversation' }), {
      target: { value: 'recent' },
    });
    expect(oldSignal?.aborted).toBe(true);
    finishOld?.({ messages: [message('obsolete-hit', 'obsolete')], hasMoreOlder: false });
    await waitFor(() => expect(screen.getByTestId('find-result')).toHaveTextContent('recent'));
    expect(screen.queryByText('obsolete-hit')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    expect(screen.getByTestId('displayed-count')).toHaveTextContent('1');
  });
  it('searches again after an edit to this thread, not after one to another thread', async () => {
    let saved = 'The recent message';
    getMessages.mockImplementation(async () => ({
      messages: [message('recent', saved)],
      hasMoreOlder: false,
    }));
    render(
      <PaneFindProvider isActive>
        <Harness />
      </PaneFindProvider>
    );
    startSearch('edited');
    await waitFor(() =>
      expect(screen.getByText('All 1 saved messages searched')).toBeInTheDocument()
    );
    expect(screen.getByTestId('find-result')).toBeEmptyDOMElement();
    const scansBefore = getMessages.mock.calls.length;

    saved = 'The edited message';
    const edit = (threadId: string): WsMessage => ({
      type: 'socket:chat:message_updated',
      channel: threadId,
      payload: { threadId, id: 'recent', content: saved, updatedAt: '2026-01-01T00:01:00Z' },
    });
    // Another thread's edit: the debounced scan would have fired by now.
    pushFrame(edit('thread-other'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(getMessages).toHaveBeenCalledTimes(scansBefore);
    expect(screen.getByTestId('find-result')).toBeEmptyDOMElement();

    pushFrame(edit('thread-test'));
    await waitFor(() => expect(screen.getByTestId('find-result')).toHaveTextContent('recent'));
    expect(getMessages).toHaveBeenCalledTimes(scansBefore + 1);
  });
});
