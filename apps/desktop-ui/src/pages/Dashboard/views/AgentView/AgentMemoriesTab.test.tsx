import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '@desktop/utils/api';
import { AgentMemoriesTab } from './AgentMemoriesTab';
import styles from './AgentMemoriesTab.module.scss';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  getStats: vi.fn(),
  remove: vi.fn(),
  threads: vi.fn(),
}));
vi.mock('@desktop/utils/api', () => ({
  memoriesApi: { list: api.list, getStats: api.getStats, delete: api.remove },
  threadsApi: { list: api.threads },
}));

const AGENT = 'agent-test-a';

function memory(n: number, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `memory-${n}`,
    agentId: AGENT,
    memberId: null,
    key: `fact-${n}`,
    content: `Test memory ${n}`,
    sourceThreadId: 'thread-1',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...extra,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue([]);
  api.getStats.mockResolvedValue({ total: 0 });
  api.threads.mockResolvedValue([]);
});
afterEach(cleanup);

describe('AgentMemoriesTab', () => {
  it('lists every memory of the agent across threads, each with its thread', async () => {
    api.list.mockResolvedValue([
      memory(1),
      memory(2, { sourceThreadId: 'thread-2' }),
      memory(3, { sourceThreadId: null }),
    ]);
    api.getStats.mockResolvedValue({ total: 3 });
    api.threads.mockResolvedValue([
      { id: 'thread-1', title: 'Planning' },
      { id: 'thread-2', title: null },
    ]);
    render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);

    expect(await screen.findByText('Test memory 1')).toBeInTheDocument();
    // All threads: the list is asked for without a thread.
    expect(api.list).toHaveBeenCalledWith(AGENT, { limit: 50, offset: 0 });
    expect(screen.getByText('3 memories from all threads')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Planning')).toBeInTheDocument());
    expect(screen.getByText('Untitled thread')).toBeInTheDocument();
    expect(screen.getByText('Added by hand')).toBeInTheDocument();
  });

  it('keeps the rows, and Load more, in a scroll box of their own', async () => {
    api.list.mockResolvedValue(Array.from({ length: 50 }, (_, i) => memory(i + 1)));
    api.getStats.mockResolvedValue({ total: 60 });
    render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
    const box = await screen.findByTestId('memories-scroll');
    expect(within(box).getByText('Test memory 1')).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    // The count line stays outside the box, above it.
    expect(within(box).queryByText(/memories from all threads/)).toBeNull();
    expect(screen.getByText('60 memories from all threads')).toBeInTheDocument();
  });

  it('says so when the agent has no memories, naming the agent instead of a pronoun', async () => {
    render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
    expect(
      await screen.findByText(
        'Test Agent has no memories yet. They appear here when Test Agent saves one in any thread.'
      )
    ).toBeInTheDocument();
  });

  it('opens a memory in full and closes it', async () => {
    api.list.mockResolvedValue([memory(1, { content: 'The whole text of it' })]);
    api.getStats.mockResolvedValue({ total: 1 });
    render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open memory fact-1' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The whole text of it')).toBeInTheDocument();
    expect(within(dialog).getByText('fact-1')).toBeInTheDocument();
  });

  it('loads the next page from where the list ends, without repeating a row', async () => {
    const first = Array.from({ length: 50 }, (_, i) => memory(i + 1));
    api.list.mockResolvedValueOnce(first).mockResolvedValueOnce([memory(50), memory(51)]);
    api.getStats.mockResolvedValue({ total: 51 });
    render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Test memory 51');
    expect(api.list).toHaveBeenLastCalledWith(AGENT, { limit: 50, offset: 50 });
    expect(screen.getAllByText('Test memory 50')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows a failed load with Retry, and the list once it works', async () => {
    api.list.mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce([memory(1)]);
    render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Test memory 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('deleting a memory', () => {
    async function renderTwo(total = 2) {
      api.list.mockResolvedValue([memory(1), memory(2)]);
      api.getStats.mockResolvedValue({ total });
      render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
      await screen.findByText('Test memory 1');
      await waitFor(() =>
        expect(screen.getByText(`${total} memories from all threads`)).toBeInTheDocument()
      );
    }

    it('asks first, then deletes the row and lowers the count', async () => {
      api.remove.mockResolvedValue({ id: 'memory-1' });
      await renderTwo();
      fireEvent.click(screen.getByRole('button', { name: 'Delete memory fact-1' }));
      // Asking changes nothing yet.
      expect(api.remove).not.toHaveBeenCalled();
      expect(screen.getByText('Delete?')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete memory fact-1' }));
      await waitFor(() => expect(screen.queryByText('Test memory 1')).toBeNull());
      expect(api.remove).toHaveBeenCalledTimes(1);
      expect(api.remove).toHaveBeenCalledWith('memory-1');
      expect(screen.getByText('Test memory 2')).toBeInTheDocument();
      expect(screen.getByText('1 memory from all threads')).toBeInTheDocument();
      expect(screen.queryByText('Delete?')).toBeNull();
    });

    it('keeps the row when the delete is canceled', async () => {
      await renderTwo();
      fireEvent.click(screen.getByRole('button', { name: 'Delete memory fact-1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel delete memory fact-1' }));
      expect(api.remove).not.toHaveBeenCalled();
      expect(screen.getByText('Test memory 1')).toBeInTheDocument();
      expect(screen.queryByText('Delete?')).toBeNull();
      expect(screen.getByText('2 memories from all threads')).toBeInTheDocument();
      // The trash button is back, and has focus again.
      expect(screen.getByRole('button', { name: 'Delete memory fact-1' })).toHaveFocus();
    });

    it('keeps the row and shows the error when the delete fails', async () => {
      api.remove.mockRejectedValue(new Error('Server said no'));
      await renderTwo();
      fireEvent.click(screen.getByRole('button', { name: 'Delete memory fact-1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete memory fact-1' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Server said no');
      expect(screen.getByText('Test memory 1')).toBeInTheDocument();
      expect(screen.getByText('2 memories from all threads')).toBeInTheDocument();
    });

    it('locks the controls while the delete is in flight', async () => {
      let finish: (value: { id: string }) => void = () => undefined;
      api.remove.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      await renderTwo();
      fireEvent.click(screen.getByRole('button', { name: 'Delete memory fact-1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete memory fact-1' }));
      expect(screen.getByRole('button', { name: 'Confirm delete memory fact-1' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel delete memory fact-1' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete memory fact-2' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete memory fact-1' }));
      expect(api.remove).toHaveBeenCalledTimes(1);
      finish({ id: 'memory-1' });
      await waitFor(() => expect(screen.queryByText('Test memory 1')).toBeNull());
      expect(screen.getByRole('button', { name: 'Delete memory fact-2' })).toBeEnabled();
    });

    it('does not open the preview, and the control is not inside the row button', async () => {
      await renderTwo();
      const trash = screen.getByRole('button', { name: 'Delete memory fact-1' });
      expect(trash.closest('button.row, [data-item-id]')).toBeNull();
      fireEvent.click(trash);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel delete memory fact-1' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('shows the empty state after the last memory is deleted', async () => {
      api.list.mockResolvedValue([memory(1)]);
      api.getStats.mockResolvedValue({ total: 1 });
      api.remove.mockResolvedValue({ id: 'memory-1' });
      render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
      await screen.findByText('Test memory 1');
      await waitFor(() =>
        expect(screen.getByText('1 memory from all threads')).toBeInTheDocument()
      );
      fireEvent.click(screen.getByRole('button', { name: 'Delete memory fact-1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete memory fact-1' }));
      expect(await screen.findByText(/Test Agent has no memories yet/)).toBeInTheDocument();
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    it('closes the preview if it showed the deleted memory', async () => {
      // Open the preview of memory 1, then delete it from the (hidden-behind) list.
      api.remove.mockResolvedValue({ id: 'memory-1' });
      await renderTwo();
      fireEvent.click(screen.getByRole('button', { name: 'Open memory fact-1' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      // The modal is aria-modal, so reach the list's controls by hidden query.
      fireEvent.click(screen.getByRole('button', { name: 'Delete memory fact-1', hidden: true }));
      fireEvent.click(
        screen.getByRole('button', { name: 'Confirm delete memory fact-1', hidden: true })
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.queryByText('Test memory 1')).toBeNull();
    });

    it('never lets the count go below zero', async () => {
      api.list.mockResolvedValue([memory(1), memory(2)]);
      api.getStats.mockResolvedValue({ total: 0 });
      api.remove.mockResolvedValue({ id: 'memory-1' });
      render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
      await screen.findByText('Test memory 1');
      fireEvent.click(screen.getByRole('button', { name: 'Delete memory fact-1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete memory fact-1' }));
      await waitFor(() => expect(screen.queryByText('Test memory 1')).toBeNull());
      expect(screen.getByText('Test memory 2')).toBeInTheDocument();
      expect(screen.queryByText(/-1/)).toBeNull();
    });
  });
});

describe('AgentMemoriesTab long keys', () => {
  // jsdom lays nothing out, so: the key carries the key class, and the
  // stylesheet lets that class break anywhere it must.
  const scss = readFileSync(join(__dirname, 'AgentMemoriesTab.module.scss'), 'utf8');
  const LONG_KEY = 'userlearninghistorymodule5compactcaughtupthensomelongerwords';

  it('wraps a 60-character key inside the row and breaks dotted keys after each dot', async () => {
    const start = scss.indexOf('\n.key {');
    const key = scss.slice(start, scss.indexOf('\n}', start));
    expect(key).toContain('overflow-wrap: anywhere');
    expect(key).toContain('max-width: 100%');

    const dotted = 'user.learning.history.module5.compact-caught-up';
    api.list.mockResolvedValue([memory(1, { key: LONG_KEY }), memory(2, { key: dotted })]);
    render(<AgentMemoriesTab agentId={AGENT} agentName="Test Agent" />);
    await screen.findByText('Test memory 1');

    expect(screen.getByText(LONG_KEY)).toHaveClass(styles.key);
    const dottedKey = screen.getByText(dotted);
    expect(dottedKey).toHaveClass(styles.key);
    expect(dottedKey.querySelectorAll('wbr')).toHaveLength(4);
  });
});
