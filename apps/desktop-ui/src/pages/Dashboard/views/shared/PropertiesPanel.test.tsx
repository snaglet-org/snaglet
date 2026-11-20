import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type FC, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const paneWidth = vi.hoisted(() => ({ value: 800 as number | null }));
vi.mock('@desktop/hooks/useElementWidth', () => ({ useElementWidth: () => paneWidth.value }));

const chrome = vi.hoisted(() => ({
  inPane: false,
  zones: {} as Record<string, ReactNode>,
}));
vi.mock('../../chrome/PaneChrome/PaneChrome', () => ({
  useHasPaneChrome: () => chrome.inPane,
  usePaneChromeActions: (actions: ReactNode, opts?: { zone?: string }) => {
    chrome.zones[opts?.zone ?? 'center'] = actions;
  },
}));

import { PropertiesPanel } from './PropertiesPanel';

const View: FC<{ extra?: string }> = ({ extra = 'md' }) => (
  <PropertiesPanel
    ariaLabel="Document properties"
    topbarActions={<button type="button">{extra}</button>}
    panel={<p>Created by Ada</p>}
  >
    <div>editor</div>
  </PropertiesPanel>
);

describe('PropertiesPanel', () => {
  it('starts closed and slides out as a sidebar in a wide pane', () => {
    paneWidth.value = 800;
    render(<View />);
    expect(screen.queryByText('Created by Ada')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('properties-toggle'));
    const region = screen.getByRole('region', { name: 'Document properties' });
    expect(region.className).toContain('sidebar');
    expect(within(region).getByText('Created by Ada')).toBeInTheDocument();
    expect(within(region).getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByTestId('properties-toggle')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByTestId('properties-toggle'));
    expect(screen.queryByText('Created by Ada')).not.toBeInTheDocument();
  });

  it('drops from the top in a skinny pane', () => {
    paneWidth.value = 400;
    render(<View />);
    fireEvent.click(screen.getByTestId('properties-toggle'));
    const region = screen.getByRole('region', { name: 'Document properties' });
    expect(region.className).toContain('topDrawer');
    expect(within(region).getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
    // The drawer sits above the content, pushing it down.
    expect(
      region.compareDocumentPosition(screen.getByText('editor')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('inside a pane, puts the toggle in the topbar and portals live controls there', () => {
    chrome.inPane = true;
    paneWidth.value = 800;
    const Harness: FC = () => {
      const [label, setLabel] = useState('md');
      return (
        <>
          <button type="button" onClick={() => setLabel('txt')}>
            flip
          </button>
          <View extra={label} />
        </>
      );
    };
    const { rerender } = render(<Harness />);
    // Render what the view registered as the pane topbar.
    const Topbar: FC = () => (
      <div data-testid="topbar">
        <div data-testid="center">{chrome.zones.center}</div>
        <div data-testid="right">{chrome.zones.right}</div>
      </div>
    );
    rerender(
      <>
        <Harness />
        <Topbar />
      </>
    );
    rerender(
      <>
        <Harness />
        <Topbar />
      </>
    );
    const topbar = screen.getByTestId('topbar');
    // The toggle pins to the right edge so a skinny pane never scrolls it away.
    expect(
      within(screen.getByTestId('right')).getByTestId('properties-toggle')
    ).toBeInTheDocument();
    expect(within(topbar).getByRole('button', { name: 'md' })).toBeInTheDocument();
    expect(screen.queryByTestId('properties-strip')).not.toBeInTheDocument();

    // Controls update live without re-registering the topbar.
    fireEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(within(topbar).getByRole('button', { name: 'txt' })).toBeInTheDocument();
    chrome.inPane = false;
  });
});
