import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownRenderer } from './MarkdownRenderer';

/**
 * The agent roster warming re-parses mentions by remounting the rendered
 * tree. That may happen once, cold to warm — not on every content change, or
 * a streamed reply that mentions someone would reset its tables (sort, open
 * cells, the Expand view) with each chunk.
 */
const roster = vi.hoisted(() => ({ cached: null as unknown[] | null, loads: 0 }));

vi.mock('@desktop/features/rich-markdown/editor/agentMentionCache', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@desktop/features/rich-markdown/editor/agentMentionCache')
  >()),
  getAgentsCached: () => roster.cached,
  ensureAgents: async () => {
    roster.loads += 1;
    roster.cached = [];
    return [];
  },
}));

const reply = (...rows: string[]) =>
  ['Ask @sam about these:', '', '| Item | Files |', '| --- | --- |', ...rows].join('\n');

/** The inline table's header (the Expand view repeats it). */
const files = () => screen.getAllByRole('columnheader', { name: /Files/ })[0];

beforeEach(() => {
  roster.cached = null;
  roster.loads = 0;
});

describe('MarkdownRenderer lookup remount', () => {
  it('keeps a table’s sort and Expand view while a reply mentioning @someone streams', async () => {
    const { rerender } = render(<MarkdownRenderer content={reply('| a | 3 |', '| b | 1 |')} />);
    // The cold roster loads once and the tree re-parses with it.
    await act(async () => {});
    expect(roster.loads).toBe(1);

    fireEvent.click(files());
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));
    expect(screen.getByRole('dialog', { name: 'Expanded table' })).toBeInTheDocument();

    rerender(<MarkdownRenderer content={reply('| a | 3 |', '| b | 1 |', '| c | 2 |')} />);
    await act(async () => {});
    rerender(
      <MarkdownRenderer content={reply('| a | 3 |', '| b | 1 |', '| c | 2 |', '| d | 0 |')} />
    );
    await act(async () => {});

    expect(roster.loads).toBe(1);
    expect(files()).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('dialog', { name: 'Expanded table' })).toBeInTheDocument();
  });
});
