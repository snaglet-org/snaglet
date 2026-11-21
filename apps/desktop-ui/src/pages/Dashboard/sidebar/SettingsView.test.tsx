import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionDescriptor } from '../selection/selectionDescriptor';
import type { DetailSelection } from '../selection/types';
import { SettingsView } from './SettingsView';

const featureFlagState = vi.hoisted(() => ({ cli: false, hub: false }));

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: (name: string) =>
    name === 'cli_pane_ui'
      ? featureFlagState.cli
      : name === 'hub_home'
        ? featureFlagState.hub
        : false,
}));

function renderView(
  onAgentInstructionsClick = vi.fn(),
  onHomeClick = vi.fn(),
  onProfileClick = vi.fn()
) {
  return render(
    <SettingsView
      onHomeClick={onHomeClick}
      onProfileClick={onProfileClick}
      onCliClick={vi.fn()}
      onThemeClick={vi.fn()}
      onAgentInstructionsClick={onAgentInstructionsClick}
      onStorageClick={vi.fn()}
      onDataSearchClick={vi.fn()}
    />
  );
}

beforeEach(() => {
  featureFlagState.cli = false;
  featureFlagState.hub = false;
});

describe('SettingsView — Command line row', () => {
  it('is hidden while the cli_pane_ui flag is off (the default)', () => {
    renderView();
    expect(screen.queryByText('Command line')).toBeNull();
    // The rest of the General group is unaffected.
    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByText('Theme')).toBeInTheDocument();
  });

  it('appears when the flag is on', () => {
    featureFlagState.cli = true;
    renderView();
    expect(screen.getByText('Command line')).toBeInTheDocument();
  });
});

describe('SettingsView — Updates row', () => {
  it('opens the version and updates pane from the General group', () => {
    const onUpdatesClick = vi.fn();
    render(
      <SettingsView
        onProfileClick={vi.fn()}
        onCliClick={vi.fn()}
        onThemeClick={vi.fn()}
        onAgentInstructionsClick={vi.fn()}
        onStorageClick={vi.fn()}
        onUpdatesClick={onUpdatesClick}
        onDataSearchClick={vi.fn()}
        activeSelectionId="updates"
      />
    );
    const row = screen.getByText('Updates').closest('[role="treeitem"]')!;
    expect(row).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(row);
    expect(onUpdatesClick).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsView — Agents row', () => {
  it('lists Agents after Theme and opens the instructions pane while Home is off', () => {
    const onAgentInstructionsClick = vi.fn();
    renderView(onAgentInstructionsClick);

    const labels = screen.getAllByRole('treeitem').map((row) => row.textContent ?? '');
    const theme = labels.findIndex((text) => text.includes('Theme'));
    const agents = labels.findIndex((text) => text.includes('Instructions for all agents'));
    expect(agents).toBe(theme + 1);

    fireEvent.click(screen.getByText('Agents'));
    expect(onAgentInstructionsClick).toHaveBeenCalledTimes(1);
  });

  it('is hidden while Home is on: Home’s card edits the same instructions', () => {
    featureFlagState.hub = true;
    renderView(vi.fn(), vi.fn());
    expect(screen.queryByText('Instructions for all agents')).toBeNull();
  });
});

describe('SettingsView — Home row (hub_home flag)', () => {
  it('keeps the Profile row and no Home row while the flag is off (the default)', () => {
    const onProfileClick = vi.fn();
    renderView(vi.fn(), vi.fn(), onProfileClick);
    expect(screen.queryByText('Home')).toBeNull();
    fireEvent.click(screen.getByText('Profile'));
    expect(onProfileClick).toHaveBeenCalledTimes(1);
  });

  it('puts Home in the Profile row’s place when the flag is on', () => {
    featureFlagState.hub = true;
    const onHomeClick = vi.fn();
    renderView(vi.fn(), onHomeClick);
    expect(screen.queryByText('Profile')).toBeNull();
    const rows = screen.getAllByRole('treeitem').map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('Home');
    fireEvent.click(screen.getByText('Home'));
    expect(onHomeClick).toHaveBeenCalledTimes(1);
  });

  it('names the Home shortcut in the row’s tooltip', () => {
    featureFlagState.hub = true;
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    renderView();
    const home = screen.getAllByRole('treeitem')[0];
    expect(home.getAttribute('title')).toContain('(⌘⇧H)');
    vi.restoreAllMocks();
  });
});

describe('SettingsView — names', () => {
  it('calls its first group General, under the Settings header', () => {
    renderView();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getAllByText('Settings')).toHaveLength(1);
  });

  function PaneTitle({ selection }: { selection: DetailSelection }) {
    return <output>{useSelectionDescriptor(selection)?.title}</output>;
  }

  it('labels every row with the title of the pane it opens', () => {
    featureFlagState.hub = true;
    featureFlagState.cli = true;
    render(
      <SettingsView
        onHomeClick={vi.fn()}
        onProfileClick={vi.fn()}
        onCliClick={vi.fn()}
        onThemeClick={vi.fn()}
        onAgentInstructionsClick={vi.fn()}
        onStorageClick={vi.fn()}
        onBrowserClick={vi.fn()}
        onUpdatesClick={vi.fn()}
        onGetStartedClick={vi.fn()}
        onDataSearchClick={vi.fn()}
      />
    );

    const rows = screen.getAllByRole('treeitem');
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      let payload = '';
      fireEvent.dragStart(row, {
        dataTransfer: {
          getData: () => '',
          setData: (_type: string, value: string) => {
            payload = value;
          },
        },
      });
      const selection = JSON.parse(payload) as DetailSelection;
      const { unmount } = render(<PaneTitle selection={selection} />);
      const title = screen.getByRole('status').textContent ?? '';
      expect(title).not.toBe('');
      expect(row.querySelector('[data-sidebar-label]')?.textContent).toBe(title);
      unmount();
    }
  });
});
