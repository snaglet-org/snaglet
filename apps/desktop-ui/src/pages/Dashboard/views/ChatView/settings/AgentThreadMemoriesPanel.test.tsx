/**
 * AgentThreadMemoriesPanel — the thread's per-agent Memories and Summaries lists.
 *
 * Memories: proposals (facts about you, waiting on you) in their own group on
 * top, each with keep and remove; saved memories below, each with a delete
 * button (the agent page's hard delete, no confirm, optimistic).
 *
 * Summaries: provenance on the summary card.
 *
 * A summary is model-authored prose, and which runtime wrote it is part of
 * reading it: quality complaints and selective regeneration both need to know.
 * The stamp is rendered from the row's structured `modelUsed` field, never
 * injected into `summaryText` — that text is embedded for retrieval and quoted
 * verbatim into exports, so a machine stamp inside it would pollute both.
 *
 * The three shapes real rows arrive in are pinned here: a provider-qualified
 * stamp, a null stamp from a row written before provenance existed, and a
 * malformed stamp with no separator. The last two must never render a bare `/`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentThreadMemoriesPanel } from './AgentThreadMemoriesPanel';
import { useProposedMemories } from './useProposedMemories';
import { memoriesApi, threadsApi } from '@desktop/utils/api';
import type { MemoryRecord, ThreadSummaryRecord } from '@desktop/utils/api';
import styles from './ChatSettings.module.scss';

vi.mock('@desktop/utils/api', () => ({
  threadsApi: {
    listAgentSummaries: vi.fn(),
  },
  memoriesApi: {
    list: vi.fn(),
    listProposed: vi.fn(),
    approve: vi.fn(),
    delete: vi.fn(),
  },
}));

const listAgentSummaries = vi.mocked(threadsApi.listAgentSummaries);

const SUMMARY_TEXT = 'They discussed the export design.';

function summary(over: Partial<ThreadSummaryRecord> = {}): ThreadSummaryRecord {
  return {
    id: 'ts-1',
    threadId: 't1',
    agentId: 'a1',
    summaryText: SUMMARY_TEXT,
    messagesCovered: 477,
    messagesInWindow: 12,
    lastMessageId: 'msg-1',
    modelUsed: 'anthropic/claude-opus-4',
    version: 3,
    isCurrent: true,
    createdAt: '2026-01-14T10:00:00.000Z',
    updatedAt: '2026-01-14T10:00:00.000Z',
    ...over,
  };
}

function renderPanel() {
  return render(
    <AgentThreadMemoriesPanel agentId="a1" threadId="t1" agentName="clio" tab="summaries" />
  );
}

describe('summary provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memoriesApi.list).mockResolvedValue([]);
  });

  it('shows the provider and model that generated the summary', async () => {
    listAgentSummaries.mockResolvedValue([summary({ modelUsed: 'anthropic/claude-opus-4' })]);
    renderPanel();

    const provenance = await screen.findByText(/anthropic\/claude-opus-4/);
    expect(provenance).toBeInTheDocument();
    // At the END of the summary: the stamp follows the body in document order.
    const body = screen.getByText(SUMMARY_TEXT);
    expect(body.compareDocumentPosition(provenance)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders the summary alone when the row carries no stamp', async () => {
    // Rows persisted before provenance was tracked.
    listAgentSummaries.mockResolvedValue([summary({ modelUsed: null })]);
    const { container } = renderPanel();

    await screen.findByText(SUMMARY_TEXT);
    expect(screen.queryByText(/via/)).not.toBeInTheDocument();
    // The failure this guards is a lone separator where a model name should be.
    expect(container.textContent).not.toMatch(/via\s*\/?\s*$/);
    expect(container.textContent).not.toContain('via /');
  });

  it('renders a malformed stamp with no slash as-is, never a bare separator', async () => {
    listAgentSummaries.mockResolvedValue([summary({ modelUsed: 'qwen2.5:3b' })]);
    const { container } = renderPanel();

    expect(await screen.findByText(/qwen2\.5:3b/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('/qwen2.5:3b');
  });

  it('never writes the stamp into the stored summary text', async () => {
    // The card must render provenance beside the prose, not inside it — the
    // prose is what gets embedded and exported.
    listAgentSummaries.mockResolvedValue([summary({ modelUsed: 'anthropic/claude-opus-4' })]);
    renderPanel();

    const body = await screen.findByText(SUMMARY_TEXT);
    expect(body.textContent).toBe(SUMMARY_TEXT);
    expect(body.textContent).not.toContain('anthropic');
  });

  it('does not fetch summaries until the summaries tab is active', async () => {
    listAgentSummaries.mockResolvedValue([summary()]);
    render(<AgentThreadMemoriesPanel agentId="a1" threadId="t1" agentName="clio" tab="memories" />);
    await waitFor(() => expect(listAgentSummaries).not.toHaveBeenCalled());
  });
});

describe('load failures', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the error without also claiming the agent has no memories', async () => {
    vi.mocked(memoriesApi.list).mockRejectedValue(new Error('memories unavailable'));
    render(<AgentThreadMemoriesPanel agentId="a1" threadId="t1" agentName="clio" tab="memories" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('memories unavailable');
    expect(screen.queryByText(/No memories yet/)).toBeNull();
  });

  it('shows the error without also claiming the agent has no summaries', async () => {
    listAgentSummaries.mockRejectedValue(new Error('summaries unavailable'));
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('summaries unavailable');
    expect(screen.queryByText(/No summaries yet/)).toBeNull();
  });
});

function memory(
  id: string,
  key: string,
  content: string,
  updatedAt: string,
  owner: Pick<MemoryRecord, 'agentId' | 'memberId'> = { agentId: 'a1', memberId: null }
): MemoryRecord {
  return { id, ...owner, key, content, sourceThreadId: 't1', createdAt: updatedAt, updatedAt };
}

const ABOUT_THE_HUMAN = { agentId: null, memberId: 'member-human' };

// Saved memories, newest first (the server's order).
const SAVED = [
  memory(
    'mem-a',
    'user.ethereal-color-direction',
    'Likes soft, airy palettes.',
    '2026-01-14T12:00:00.000Z'
  ),
  memory('mem-b', 'project.deadline', 'The demo ships Friday.', '2026-01-14T11:00:00.000Z'),
  memory('mem-c', 'user.timezone', 'Works from Pacific time.', '2026-01-14T10:00:00.000Z'),
];
// Proposals: facts about the human (member-owned, so no agent).
const PROPOSED = [
  memory(
    'prop-1',
    'user.prefers-short-replies',
    'Prefers short replies.',
    '2026-01-14T13:00:00.000Z',
    ABOUT_THE_HUMAN
  ),
  memory(
    'prop-2',
    'user.coffee',
    'Drinks oat-milk lattes.',
    '2026-01-14T12:30:00.000Z',
    ABOUT_THE_HUMAN
  ),
];

/** The panel wired to the real proposals hook, as AgentsSection wires it. */
function Harness({ agentId = 'a1' }: { agentId?: string }) {
  const { proposed, proposedError, loadProposed, resolveProposed } = useProposedMemories('t1');
  return (
    <>
      <button type="button" onClick={() => loadProposed()}>
        reload proposals
      </button>
      <AgentThreadMemoriesPanel
        agentId={agentId}
        threadId="t1"
        agentName="clio"
        tab="memories"
        proposed={proposed}
        proposedError={proposedError}
        onResolveProposed={resolveProposed}
      />
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A FetchError-shaped failure, as fetchData throws for an HTTP status. */
function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const cardKeys = () =>
  Array.from(document.querySelectorAll('[data-item-id]')).map((el) =>
    el.getAttribute('data-item-id')
  );

describe('deleting a saved memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memoriesApi.list).mockResolvedValue(SAVED);
    vi.mocked(memoriesApi.listProposed).mockResolvedValue([]);
  });

  it('gives every saved card its own delete button, outside the card button', async () => {
    render(<Harness />);
    await screen.findByText('Likes soft, airy palettes.');
    for (const m of SAVED) {
      const del = screen.getByRole('button', { name: `Delete memory ${m.key}` });
      expect(del).toHaveAttribute('title', 'Delete memory');
      // A sibling of the card, never nested in it.
      const card = screen.getByRole('button', { name: `Open memory ${m.key}` });
      expect(card.contains(del)).toBe(false);
    }
  });

  it('calls the agent page delete with the id and drops the card at once, no confirm', async () => {
    const call = deferred<{ id: string }>();
    vi.mocked(memoriesApi.delete).mockReturnValue(call.promise);
    render(<Harness />);
    await screen.findByText('The demo ships Friday.');

    fireEvent.click(screen.getByRole('button', { name: 'Delete memory project.deadline' }));

    expect(memoriesApi.delete).toHaveBeenCalledWith('mem-b');
    // Gone before the server answers, with no "Delete?" step.
    expect(screen.queryByText('The demo ships Friday.')).toBeNull();
    expect(screen.queryByText(/Delete\?/)).toBeNull();
    await act(async () => call.resolve({ id: 'mem-b' }));
    expect(screen.queryByText('The demo ships Friday.')).toBeNull();
    expect(cardKeys()).toEqual(['mem-a', 'mem-c']);
  });

  it('does not open the preview when the delete button is clicked', async () => {
    vi.mocked(memoriesApi.delete).mockResolvedValue({ id: 'mem-a' });
    render(<Harness />);
    await screen.findByText('Likes soft, airy palettes.');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete memory user.ethereal-color-direction' })
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts the card back in its place and shows the error when the delete fails', async () => {
    vi.mocked(memoriesApi.delete).mockRejectedValue(new Error('database is busy'));
    render(<Harness />);
    await screen.findByText('The demo ships Friday.');

    fireEvent.click(screen.getByRole('button', { name: 'Delete memory project.deadline' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('database is busy');
    expect(screen.getByText('The demo ships Friday.')).toBeInTheDocument();
    expect(cardKeys()).toEqual(['mem-a', 'mem-b', 'mem-c']);
  });

  it('treats a 404 (already gone) as done: the card stays gone, no error', async () => {
    vi.mocked(memoriesApi.delete).mockRejectedValue(httpError(404, 'Memory not found'));
    render(<Harness />);
    await screen.findByText('The demo ships Friday.');

    fireEvent.click(screen.getByRole('button', { name: 'Delete memory project.deadline' }));

    await waitFor(() => expect(memoriesApi.delete).toHaveBeenCalledWith('mem-b'));
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(cardKeys()).toEqual(['mem-a', 'mem-c']);
  });

  it('a list read the server answered before the delete committed does not bring it back', async () => {
    vi.mocked(memoriesApi.delete).mockResolvedValue({ id: 'mem-b' });
    const { rerender } = render(<Harness />);
    await screen.findByText('The demo ships Friday.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory project.deadline' }));
    await act(async () => {});

    // Switch away and back: the fresh read still (stale) lists mem-b.
    rerender(<Harness agentId="a2" />);
    rerender(<Harness agentId="a1" />);
    await screen.findByText('Likes soft, airy palettes.');
    expect(memoriesApi.list).toHaveBeenLastCalledWith('a1', { threadId: 't1' });
    expect(screen.queryByText('The demo ships Friday.')).toBeNull();
  });

  it('is reachable from the keyboard, and focus moves to the next card', async () => {
    const user = userEvent.setup();
    vi.mocked(memoriesApi.delete).mockResolvedValue({ id: 'mem-a' });
    render(<Harness />);
    await screen.findByText('Likes soft, airy palettes.');

    // Tab from the first card lands on its delete button.
    screen.getByRole('button', { name: 'Open memory user.ethereal-color-direction' }).focus();
    await user.tab();
    const del = screen.getByRole('button', { name: 'Delete memory user.ethereal-color-direction' });
    expect(del).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(memoriesApi.delete).toHaveBeenCalledWith('mem-a');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open memory project.deadline' })).toHaveFocus()
    );
  });

  it('deleting the last card from the keyboard moves focus to the previous card', async () => {
    const user = userEvent.setup();
    vi.mocked(memoriesApi.delete).mockResolvedValue({ id: 'mem-c' });
    render(<Harness />);
    await screen.findByText('Works from Pacific time.');

    screen.getByRole('button', { name: 'Delete memory user.timezone' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open memory project.deadline' })).toHaveFocus()
    );
  });

  it('deleting the only card from the keyboard moves focus to the list, not the page', async () => {
    const user = userEvent.setup();
    vi.mocked(memoriesApi.list).mockResolvedValue([SAVED[0]]);
    vi.mocked(memoriesApi.delete).mockResolvedValue({ id: 'mem-a' });
    render(<Harness />);
    await screen.findByText('Likes soft, airy palettes.');

    screen.getByRole('button', { name: 'Delete memory user.ethereal-color-direction' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('tabpanel', { name: 'Memories' })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('proposed memories in the Memories list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memoriesApi.list).mockResolvedValue(SAVED);
    vi.mocked(memoriesApi.listProposed).mockResolvedValue(PROPOSED);
  });

  it('lists proposals in their own group, with the count, above the saved memories', async () => {
    render(<Harness />);
    const heading = await screen.findByRole('heading', { name: 'Proposed (2)' });
    await screen.findByText('Likes soft, airy palettes.');
    const group = heading.closest('section')!;
    expect(within(group).getByText('Prefers short replies.')).toBeInTheDocument();
    expect(within(group).getByText('Drinks oat-milk lattes.')).toBeInTheDocument();
    // Saved memories are not in the group, and come after it.
    expect(within(group).queryByText('Likes soft, airy palettes.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Saved' })).toBeInTheDocument();
    expect(cardKeys()).toEqual(['prop-1', 'prop-2', 'mem-a', 'mem-b', 'mem-c']);
    // Proposals have keep and remove, not the saved cards' delete.
    expect(within(group).queryByRole('button', { name: /^Delete memory/ })).toBeNull();
  });

  it('shows no group, heading or gap when nothing is proposed', async () => {
    vi.mocked(memoriesApi.listProposed).mockResolvedValue([]);
    render(<Harness />);
    await screen.findByText('Likes soft, airy palettes.');
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByText(/Facts about you/)).toBeNull();
  });

  it('keeps the group above the empty state when only proposals exist', async () => {
    vi.mocked(memoriesApi.list).mockResolvedValue([]);
    render(<Harness />);
    await screen.findByRole('heading', { name: 'Proposed (2)' });
    expect(await screen.findByText('No memories yet for clio in this thread.')).toBeInTheDocument();
  });

  it('marks a kept fact about you in the saved list', async () => {
    vi.mocked(memoriesApi.list).mockResolvedValue([
      memory(
        'kept-1',
        'user.city',
        'Lives in Portland.',
        '2026-01-14T14:00:00.000Z',
        ABOUT_THE_HUMAN
      ),
      ...SAVED,
    ]);
    vi.mocked(memoriesApi.listProposed).mockResolvedValue([]);
    render(<Harness />);
    const kept = await screen.findByRole('button', { name: 'Open memory user.city' });
    expect(within(kept).getByText('About you')).toBeInTheDocument();
    const own = screen.getByRole('button', { name: 'Open memory project.deadline' });
    expect(within(own).queryByText('About you')).toBeNull();
    // A kept fact is deleted like any saved memory.
    expect(screen.getByRole('button', { name: 'Delete memory user.city' })).toBeInTheDocument();
  });

  it('keep calls the approve path with the id and moves the card into the saved list', async () => {
    const call = deferred<MemoryRecord>();
    vi.mocked(memoriesApi.approve).mockReturnValue(call.promise);
    render(<Harness />);
    await screen.findByText('Likes soft, airy palettes.');

    fireEvent.click(screen.getByRole('button', { name: 'Keep memory user.prefers-short-replies' }));

    expect(memoriesApi.approve).toHaveBeenCalledWith('prop-1');
    expect(memoriesApi.delete).not.toHaveBeenCalled();
    // Optimistic: out of the group and at the top of the saved list at once.
    expect(screen.getByRole('heading', { name: 'Proposed (1)' })).toBeInTheDocument();
    expect(cardKeys()).toEqual(['prop-2', 'prop-1', 'mem-a', 'mem-b', 'mem-c']);
    const kept = screen.getByRole('button', { name: 'Open memory user.prefers-short-replies' });
    expect(within(kept).getByText('About you')).toBeInTheDocument();
    await act(async () => call.resolve({ ...PROPOSED[0] }));
    expect(cardKeys()).toEqual(['prop-2', 'prop-1', 'mem-a', 'mem-b', 'mem-c']);
  });

  it('remove calls the dismiss path (the hard delete) and drops the card', async () => {
    vi.mocked(memoriesApi.delete).mockResolvedValue({ id: 'prop-2' });
    render(<Harness />);
    await screen.findByText('Likes soft, airy palettes.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove proposed memory user.coffee' }));

    expect(memoriesApi.delete).toHaveBeenCalledWith('prop-2');
    expect(memoriesApi.approve).not.toHaveBeenCalled();
    expect(screen.queryByText('Drinks oat-milk lattes.')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Proposed (1)' })).toBeInTheDocument()
    );
    // Removed, not kept: it never joins the saved list.
    expect(cardKeys()).toEqual(['prop-1', 'mem-a', 'mem-b', 'mem-c']);
  });

  it('drops the group entirely once the last proposal is resolved', async () => {
    vi.mocked(memoriesApi.listProposed).mockResolvedValue([PROPOSED[0]]);
    vi.mocked(memoriesApi.delete).mockResolvedValue({ id: 'prop-1' });
    render(<Harness />);
    await screen.findByText('Prefers short replies.');
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove proposed memory user.prefers-short-replies' })
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Proposed/ })).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Saved' })).toBeNull();
  });

  it('puts a proposal back in the group, out of the saved list, when keep fails', async () => {
    vi.mocked(memoriesApi.approve).mockRejectedValue(new Error('approve failed'));
    render(<Harness />);
    await screen.findByText('Likes soft, airy palettes.');

    fireEvent.click(screen.getByRole('button', { name: 'Keep memory user.prefers-short-replies' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('approve failed');
    const group = screen.getByRole('heading', { name: 'Proposed (2)' }).closest('section')!;
    expect(within(group).getByText('Prefers short replies.')).toBeInTheDocument();
    expect(screen.getAllByText('Prefers short replies.')).toHaveLength(1);
  });

  it('a remove that finds the proposal already gone (404) is done, with no error', async () => {
    vi.mocked(memoriesApi.delete).mockRejectedValue(httpError(404, 'Memory not found'));
    render(<Harness />);
    await screen.findByText('Drinks oat-milk lattes.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove proposed memory user.coffee' }));

    await waitFor(() => expect(memoriesApi.delete).toHaveBeenCalledWith('prop-2'));
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Drinks oat-milk lattes.')).toBeNull();
  });

  it('a proposals read the server answered before the keep committed does not bring it back', async () => {
    vi.mocked(memoriesApi.approve).mockResolvedValue({ ...PROPOSED[0] });
    render(<Harness />);
    await screen.findByText('Prefers short replies.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep memory user.prefers-short-replies' }));
    await act(async () => {});

    // A later read still (stale) lists the kept proposal.
    fireEvent.click(screen.getByRole('button', { name: 'reload proposals' }));
    await waitFor(() => expect(memoriesApi.listProposed).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Proposed (1)' })).toBeInTheDocument();
  });

  it('reaches keep and remove from the keyboard', async () => {
    const user = userEvent.setup();
    vi.mocked(memoriesApi.approve).mockResolvedValue({ ...PROPOSED[0] });
    vi.mocked(memoriesApi.delete).mockResolvedValue({ id: 'prop-2' });
    render(<Harness />);
    await screen.findByText('Drinks oat-milk lattes.');

    screen.getByRole('button', { name: 'reload proposals' }).focus();
    await user.tab();
    expect(
      screen.getByRole('button', { name: 'Keep memory user.prefers-short-replies' })
    ).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(memoriesApi.approve).toHaveBeenCalledWith('prop-1');

    const remove = screen.getByRole('button', { name: 'Remove proposed memory user.coffee' });
    remove.focus();
    await user.keyboard(' ');
    expect(memoriesApi.delete).toHaveBeenCalledWith('prop-2');
  });
});

describe('long keys', () => {
  // jsdom lays nothing out and vitest does not inject CSS modules, so the
  // no-overflow contract is checked two ways: the key element carries the key
  // class, and the stylesheet lets that class break anywhere it must.
  const scss = readFileSync(join(__dirname, 'ChatSettings.module.scss'), 'utf8');
  const block = (selector: string): string => {
    const start = scss.indexOf(`\n${selector} {`);
    expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
    return scss.slice(start, scss.indexOf('\n}', start));
  };
  // 60 characters, no dot or hyphen: nothing to break at but the CSS.
  const LONG_KEY = 'userlearninghistorymodule5compactcaughtupthensomelongerwords';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the key style breaks a segment too long for the card, keeping the mono caps look', () => {
    expect(LONG_KEY).toHaveLength(60);
    const key = block('.agentsMemoryKey');
    expect(key).toContain('overflow-wrap: anywhere');
    expect(key).toContain('word-break: break-word');
    expect(key).toContain('min-width: 0');
    expect(key).toContain('max-width: 100%');
    expect(key).toContain('@include theme-mono-label');
    // The flex children that hold a key can shrink below the key's length.
    expect(block('.agentsMemoryKeyRow')).toContain('min-width: 0');
    expect(block('.agentsProposedText')).toContain('min-width: 0');
    // And the keep / remove buttons never give up their room.
    expect(block('.agentsProposedActions')).toContain('flex-shrink: 0');
  });

  it('renders a 60-character key in the wrapping key element, saved and proposed', async () => {
    vi.mocked(memoriesApi.list).mockResolvedValue([
      memory('mem-long', LONG_KEY, 'Saved with a long key.', '2026-01-14T12:00:00.000Z'),
    ]);
    vi.mocked(memoriesApi.listProposed).mockResolvedValue([
      memory('prop-long', LONG_KEY, 'Proposed with a long key.', '2026-01-14T13:00:00.000Z'),
    ]);
    render(<Harness />);
    await screen.findByText('Saved with a long key.');

    const saved = screen.getByRole('button', { name: `Open memory ${LONG_KEY}` });
    const savedKey = within(saved).getByText(LONG_KEY);
    expect(savedKey).toHaveClass(styles.agentsMemoryKey);

    const proposal = screen.getByText('Proposed with a long key.').closest('article')!;
    const proposedKey = within(proposal).getByText(LONG_KEY);
    expect(proposedKey).toHaveClass(styles.agentsMemoryKey);
    // The key sits in the shrinkable text column; the buttons are outside it.
    const column = proposedKey.closest(`.${styles.agentsProposedText}`)!;
    expect(column).not.toBeNull();
    const keep = within(proposal).getByRole('button', { name: `Keep memory ${LONG_KEY}` });
    expect(column.contains(keep)).toBe(false);
  });

  it('offers a line break after every dot, with the text unchanged', async () => {
    const dotted = 'user.learning.history.module5.compact-caught-up';
    vi.mocked(memoriesApi.list).mockResolvedValue([
      memory('mem-dots', dotted, 'Dotted key.', '2026-01-14T12:00:00.000Z'),
    ]);
    vi.mocked(memoriesApi.listProposed).mockResolvedValue([]);
    render(<Harness />);
    await screen.findByText('Dotted key.');
    const key = within(screen.getByRole('button', { name: `Open memory ${dotted}` })).getByText(
      dotted
    );
    expect(key.textContent).toBe(dotted);
    expect(key.querySelectorAll('wbr')).toHaveLength(4);
  });
});
