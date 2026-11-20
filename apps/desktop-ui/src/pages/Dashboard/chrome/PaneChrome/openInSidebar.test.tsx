import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutLeaf } from '../../layout/paneTree';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const renderDetail = vi.hoisted(() => vi.fn());
vi.mock('../../views/DetailRouter.js', () => ({ DetailRouter: () => renderDetail() }));
vi.mock('../PaneHistoryNav/PaneHistoryNav.js', () => ({
  PaneHistoryNav: () => <button type="button">History controls</button>,
}));
vi.mock('../PathHeader/PathHeader.js', () => ({
  PathHeader: () => <button type="button">Context path</button>,
}));
vi.mock('../PathHeader/useNodeAncestors.js', () => ({ useNodeAncestors: () => [] }));

import { PaneChrome, PaneChromeBoundary } from './PaneChrome';
import { OpenInSidebarButton, useClaimOpenInSidebar } from './openInSidebar';

function makeLeaf(): LayoutLeaf {
  const selection = { kind: 'theme' } as const;
  return { kind: 'leaf', id: 'leaf-1', selection, history: { entries: [selection], index: 0 } };
}

function renderPane(onOpenInSidebar = vi.fn()) {
  const utils = render(
    <PaneChrome
      leaf={makeLeaf()}
      isActive
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onDropSelection={vi.fn()}
      onReplaceSelection={vi.fn()}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpToHistoryEntry={vi.fn()}
      onOpenInSidebar={onOpenInSidebar}
    />
  );
  return { ...utils, onOpenInSidebar };
}

/** A view with a side panel: claims the button and shows it in its panel. */
const PanelView = () => {
  useClaimOpenInSidebar();
  return (
    <aside aria-label="Side panel">
      <OpenInSidebarButton />
    </aside>
  );
};

const topbar = () => document.querySelector('[data-pane-chrome-zone="center"]');

describe('Open in sidebar', () => {
  beforeEach(() => renderDetail.mockReset());

  it('stays in the topbar for a view without a side panel', () => {
    renderDetail.mockImplementation(() => <div>plain view</div>);
    renderPane();
    expect(topbar()).toContainElement(screen.getByRole('button', { name: 'Open in sidebar' }));
  });

  it('moves into the side panel of a view that claims it, and still opens the sidebar', async () => {
    renderDetail.mockImplementation(() => <PanelView />);
    const { onOpenInSidebar } = renderPane();

    const panel = screen.getByRole('complementary', { name: 'Side panel' });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Open in sidebar' })).toHaveLength(1)
    );
    const button = screen.getByRole('button', { name: 'Open in sidebar' });
    expect(panel).toContainElement(button);
    expect(topbar()).not.toContainElement(button);

    fireEvent.click(button);
    expect(onOpenInSidebar).toHaveBeenCalledTimes(1);
  });

  it('comes back to the topbar when the claiming view goes away', async () => {
    renderDetail.mockImplementation(() => <PanelView />);
    const { rerender } = renderPane();
    await waitFor(() =>
      expect(topbar()).not.toContainElement(screen.getByRole('button', { name: 'Open in sidebar' }))
    );

    renderDetail.mockImplementation(() => <div>plain view</div>);
    rerender(
      <PaneChrome
        leaf={{ ...makeLeaf() }}
        isActive
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onDropSelection={vi.fn()}
        onReplaceSelection={vi.fn()}
        onGoBack={vi.fn()}
        onGoForward={vi.fn()}
        onJumpToHistoryEntry={vi.fn()}
        onOpenInSidebar={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(topbar()).toContainElement(screen.getByRole('button', { name: 'Open in sidebar' }))
    );
  });

  it('a disabled claim leaves the button in the topbar', () => {
    const MaybeClaim = () => {
      useClaimOpenInSidebar(false);
      return <div>loading</div>;
    };
    renderDetail.mockImplementation(() => <MaybeClaim />);
    renderPane();
    expect(topbar()).toContainElement(screen.getByRole('button', { name: 'Open in sidebar' }));
  });

  it('renders nothing outside a pane (a preview modal behind PaneChromeBoundary)', () => {
    render(
      <PaneChromeBoundary>
        <PanelView />
      </PaneChromeBoundary>
    );
    expect(screen.queryByRole('button', { name: 'Open in sidebar' })).not.toBeInTheDocument();
  });
});
