/**
 * The sidebar search highlights a result on hover only after the pointer
 * really moves: rows that appear or shift under a resting pointer (the
 * browser still sends mouseover/mouseenter, and WebKit a mousemove, at the
 * same spot) must not take Enter from the closest match.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteAugmentedResponse, PaletteSearchHit } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const tiered = vi.hoisted(() => ({ state: { instant: null, enriched: null } as unknown }));

vi.mock('@desktop/hooks/useTieredSearch', async () => {
  const actual = await vi.importActual<typeof import('@desktop/hooks/useTieredSearch')>(
    '@desktop/hooks/useTieredSearch'
  );
  return {
    ...actual,
    useTieredSearch: () => ({
      ...(tiered.state as object),
      instantLoading: false,
      enrichmentLoading: false,
    }),
  };
});

import { TreeSearchWidget } from './TreeSearchWidget';
import { useWorkspaceTreeSearch } from './useWorkspaceTreeSearch';

function doc(id: string, title: string, score: number): PaletteSearchHit {
  return { node_id: id, kind: 'doc', score, channels: ['fts'], payload: { title } };
}

function Harness({ onLibraryHit }: { onLibraryHit: (hit: PaletteSearchHit) => void }) {
  const search = useWorkspaceTreeSearch({
    onLibraryHit,
    nodeIndexRef: { current: new Map() },
    pendingOpenIdRef: { current: null },
  });
  return <TreeSearchWidget search={search} />;
}

const row = (name: RegExp) => screen.getByRole('option', { name });

/** What a browser sends when rows appear or move under a resting pointer. */
function contentAppearsUnder(element: HTMLElement, clientX: number, clientY: number) {
  fireEvent.mouseOver(element, { clientX, clientY });
  fireEvent.mouseEnter(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX, clientY });
}

beforeEach(() => {
  tiered.state = {
    instant: {
      byKind: { doc: [doc('doc-1', 'Calendar and reminders', 2), doc('doc-2', 'Clio notes', 1)] },
    } as unknown as PaletteAugmentedResponse,
    enriched: null,
  };
});

describe('sidebar search: a pointer that has not moved', () => {
  it('cannot take the highlight from the closest match, so Enter opens it', async () => {
    const onLibraryHit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onLibraryHit={onLibraryHit} />);

    await user.type(screen.getByRole('textbox', { name: 'Search workspace tree' }), 'cal');
    contentAppearsUnder(row(/Clio notes/), 140, 260);

    expect(row(/Calendar and reminders/)).toHaveAttribute('aria-selected', 'true');
    expect(row(/Clio notes/)).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{Enter}');
    expect(onLibraryHit).toHaveBeenCalledWith(expect.objectContaining({ node_id: 'doc-1' }));
  });

  it('cannot take it after the query changes either', async () => {
    const user = userEvent.setup();
    render(<Harness onLibraryHit={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Search workspace tree' });

    await user.type(input, 'cal');
    fireEvent.mouseMove(row(/Clio notes/), { clientX: 140, clientY: 260 });
    fireEvent.mouseMove(row(/Clio notes/), { clientX: 143, clientY: 262 });
    expect(row(/Clio notes/)).toHaveAttribute('aria-selected', 'true');

    await user.type(input, 'e');
    expect(row(/Calendar and reminders/)).toHaveAttribute('aria-selected', 'true');
    contentAppearsUnder(row(/Clio notes/), 143, 262);
    expect(row(/Calendar and reminders/)).toHaveAttribute('aria-selected', 'true');
  });

  it('still lets a real move highlight a row, arrow keys move on from it, and a click opens the clicked row', async () => {
    const onLibraryHit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onLibraryHit={onLibraryHit} />);

    await user.type(screen.getByRole('textbox', { name: 'Search workspace tree' }), 'cal');
    fireEvent.mouseMove(row(/Clio notes/), { clientX: 140, clientY: 260 });
    fireEvent.mouseMove(row(/Clio notes/), { clientX: 145, clientY: 264 });
    expect(row(/Clio notes/)).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowUp}');
    expect(row(/Calendar and reminders/)).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(row(/Clio notes/));
    expect(onLibraryHit).toHaveBeenCalledWith(expect.objectContaining({ node_id: 'doc-2' }));
  });
});
