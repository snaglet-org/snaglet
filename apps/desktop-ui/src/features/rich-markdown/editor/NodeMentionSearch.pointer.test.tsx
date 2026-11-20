/**
 * The @ popup and the slash menu pick the first row on Enter/Tab unless the
 * pointer really moved or the arrow keys were used. Rows that appear or shift
 * under a resting pointer (the browser still sends mouseover/mouseenter, and
 * WebKit a mousemove, at the same spot) must not take the highlight.
 */
import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const useTieredSearchMock = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/hooks/useTieredSearch.js', () => ({
  useTieredSearch: useTieredSearchMock,
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

import {
  NodeMentionSearch,
  type AgentMentionHit,
  type NodeMentionSearchHandle,
} from './NodeMentionSearch';
import { SlashMenu, type SlashMenuHandle } from './SlashMenu';

const ANCHOR = { left: 20, top: 20, bottom: 30, width: 1 };

function agent(id: string, name: string): AgentMentionHit {
  return {
    type: 'agent',
    key: id,
    label: name,
    subtitle: null,
    prefix: false,
    agent: { id, name, handle: null, role: null },
  };
}

const AGENTS = [agent('agent-a', 'Clio Alpha'), agent('agent-b', 'Clio Beta')];

const row = (name: RegExp) => screen.getByRole('option', { name });

/** What a browser sends when rows appear or move under a resting pointer. */
function contentAppearsUnder(element: HTMLElement, clientX: number, clientY: number) {
  fireEvent.mouseOver(element, { clientX, clientY });
  fireEvent.mouseEnter(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX, clientY });
}

/** A real pointer move across `element`. */
function moveAcross(element: HTMLElement) {
  fireEvent.mouseMove(element, { clientX: 100, clientY: 80 });
  fireEvent.mouseMove(element, { clientX: 104, clientY: 83 });
}

function press(handle: { handleKeyDown?: (event: KeyboardEvent) => boolean } | null, key: string) {
  let handled = false;
  act(() => {
    handled = handle?.handleKeyDown?.(new KeyboardEvent('keydown', { key })) ?? false;
  });
  return handled;
}

beforeAll(() => {
  // jsdom has no layout; the slash menu scrolls its active row into view.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  useTieredSearchMock.mockReset();
  useTieredSearchMock.mockReturnValue({
    instant: null,
    enriched: null,
    instantLoading: false,
    enrichmentLoading: false,
  });
});

describe('@ popup: a pointer that has not moved', () => {
  function popup(query: string, onSelect = vi.fn()) {
    const ref = createRef<NodeMentionSearchHandle>();
    const element = (q: string) => (
      <NodeMentionSearch
        ref={ref}
        open
        query={q}
        anchorRect={ANCHOR}
        agentOptions={AGENTS}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );
    const view = render(element(query));
    return { ref, onSelect, rerender: (q: string) => view.rerender(element(q)) };
  }

  it('cannot take the highlight, so Enter and Tab pick the first row', () => {
    const { ref, onSelect } = popup('clio');

    contentAppearsUnder(row(/Clio Beta/), 100, 80);
    expect(row(/Clio Alpha/)).toHaveAttribute('aria-selected', 'true');
    expect(press(ref.current, 'Enter')).toBe(true);
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'agent-a' }));

    expect(press(ref.current, 'Tab')).toBe(true);
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'agent-a' }));
  });

  it('puts the highlight back on the first row when the query changes', () => {
    const { ref, onSelect, rerender } = popup('clio');

    moveAcross(row(/Clio Beta/));
    expect(row(/Clio Beta/)).toHaveAttribute('aria-selected', 'true');

    rerender('clio ');
    expect(row(/Clio Alpha/)).toHaveAttribute('aria-selected', 'true');
    // The pointer stays put while the rows re-render under it.
    contentAppearsUnder(row(/Clio Beta/), 104, 83);
    expect(row(/Clio Alpha/)).toHaveAttribute('aria-selected', 'true');
    press(ref.current, 'Enter');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'agent-a' }));
  });

  it('still follows a real move and the arrow keys, and a press picks the pressed row', () => {
    const { ref, onSelect } = popup('clio');

    moveAcross(row(/Clio Beta/));
    expect(row(/Clio Beta/)).toHaveAttribute('aria-selected', 'true');
    press(ref.current, 'ArrowUp');
    expect(row(/Clio Alpha/)).toHaveAttribute('aria-selected', 'true');
    press(ref.current, 'ArrowDown');
    press(ref.current, 'Enter');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'agent-b' }));

    fireEvent.mouseDown(row(/Clio Alpha/));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'agent-a' }));
  });
});

describe('slash menu: a pointer that has not moved', () => {
  function menu(query: string, onPick = vi.fn()) {
    const ref = createRef<SlashMenuHandle>();
    const element = (q: string) => (
      <SlashMenu
        ref={ref}
        query={q}
        anchor={ANCHOR}
        editor={null}
        onPick={onPick}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    const view = render(element(query));
    return { ref, onPick, rerender: (q: string) => view.rerender(element(q)) };
  }

  const pickedIds = (onPick: ReturnType<typeof vi.fn>) =>
    onPick.mock.calls.map(([command]) => (command as { id: string }).id);

  it('cannot take the highlight, so Enter and Tab pick the first command', () => {
    const { ref, onPick } = menu('');
    const [first, second] = screen.getAllByRole('option');

    contentAppearsUnder(second!, 100, 80);
    expect(first).toHaveAttribute('aria-selected', 'true');
    press(ref.current, 'Enter');
    press(ref.current, 'Tab');
    expect(pickedIds(onPick)).toEqual(['paragraph', 'paragraph']);
  });

  it('puts the highlight back on the first command when the query changes', () => {
    const { rerender } = menu('');
    moveAcross(screen.getAllByRole('option')[1]!);
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    rerender('h');
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveAttribute('aria-selected', 'true');
    contentAppearsUnder(rows[1]!, 104, 83);
    expect(rows[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('still follows a real move and the arrow keys, and a press picks the pressed command', () => {
    const { ref, onPick } = menu('');
    const rows = screen.getAllByRole('option');

    moveAcross(rows[2]!);
    expect(rows[2]).toHaveAttribute('aria-selected', 'true');
    press(ref.current, 'ArrowUp');
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');
    press(ref.current, 'Enter');
    fireEvent.mouseDown(rows[0]!);
    expect(pickedIds(onPick)).toEqual(['h1', 'paragraph']);
  });
});
