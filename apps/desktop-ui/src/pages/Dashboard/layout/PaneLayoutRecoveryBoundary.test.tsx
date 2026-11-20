import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLeaf, type LayoutNode } from './paneTree';
import type { PaneCallbacks } from './PaneLayout';

const renderPaneLayout = vi.hoisted(() => vi.fn());
vi.mock('./PaneLayout.js', () => ({
  PaneLayout: (props: { layout: LayoutNode }) => renderPaneLayout(props),
}));

import { PaneLayoutRecoveryBoundary } from './PaneLayoutRecoveryBoundary';

const noopCallbacks: PaneCallbacks = {
  onSelectLeaf: () => undefined,
  onCloseLeaf: () => undefined,
  onSplit: () => undefined,
  onReplace: () => undefined,
  onResize: () => undefined,
  onGoBackInLeaf: () => undefined,
  onGoForwardInLeaf: () => undefined,
  onJumpToHistoryEntry: () => undefined,
};

afterEach(() => {
  renderPaneLayout.mockReset();
  vi.restoreAllMocks();
});

describe('PaneLayoutRecoveryBoundary', () => {
  it('resets and remounts only the pane layout after one isolated crash', async () => {
    const badLeaf = {
      ...createLeaf({ kind: 'thread', thread_id: 'thread-private' }),
      id: 'bad-layout',
    };
    const safeLeaf = { ...createLeaf(null), id: 'safe-layout' };
    const reset = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPaneLayout.mockImplementation(({ layout }: { layout: LayoutNode }) => {
      if (layout.id === badLeaf.id) throw new Error('sensitive pane content');
      return <div data-testid="healthy-pane">Healthy pane</div>;
    });

    const Harness = () => {
      const [layout, setLayout] = useState<LayoutNode>(badLeaf);
      return (
        <div>
          <div data-testid="workspace-shell">Workspace remains mounted</div>
          <PaneLayoutRecoveryBoundary
            layout={layout}
            activeLeafId={layout.id}
            callbacks={noopCallbacks}
            onReset={() => {
              reset();
              setLayout(safeLeaf);
            }}
          />
        </div>
      );
    };

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('healthy-pane')).toBeVisible());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('workspace-shell')).toBeVisible();
    expect(error).toHaveBeenCalledWith(
      '[pane-layout] renderer crashed',
      expect.objectContaining({ source: 'render-crash', rootId: 'bad-layout' })
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('sensitive pane content');
    expect(JSON.stringify(error.mock.calls)).not.toContain('thread-private');
  });

  it('stops after one recovery attempt when the safe render also crashes', async () => {
    const layout = { ...createLeaf(null), id: 'always-crashes' };
    const reset = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPaneLayout.mockImplementation(() => {
      throw new Error('still broken');
    });

    render(
      <PaneLayoutRecoveryBoundary
        layout={layout}
        activeLeafId={layout.id}
        callbacks={noopCallbacks}
        onReset={reset}
      />
    );

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Recovering pane'));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
