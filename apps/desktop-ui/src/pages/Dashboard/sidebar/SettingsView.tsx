import { type FC, type ReactNode, useState } from 'react';
import { Tree, TreeGroup, TreeRow } from '@desktop/components/SidebarTree';
import type { DataSearchTab, DetailSelection } from '../selection/types';
import { SidebarView } from './SidebarView';
import { CLI_PANE_UI_FLAG, HUB_HOME_FLAG } from '@snaglet/shared/types';
import { SETTINGS_ENTRY_LABELS as LABELS } from '@snaglet/shared/constants/settingsEntries';
import { useFeatureFlag } from '@desktop/features/featureFlags/FeatureFlagsContext';
import { paneShortcutHint } from '../chrome/PaneChrome/paneShortcuts';

interface SettingsViewProps {
  /**
   * Open the Home pane in the active pane. While the `hub_home` flag is on,
   * its Home row takes the Profile row's place.
   */
  onHomeClick?: () => void;
  /** Open the user-profile editor in the active pane. */
  onProfileClick: () => void;
  /** Open the packaged command-line installer in the active pane. */
  onCliClick: () => void;
  /** Open the workspace theme customization pane. */
  onThemeClick: () => void;
  /** Open the instructions-for-all-agents pane. */
  onAgentInstructionsClick: () => void;
  /** Open the storage and voice models pane. */
  onStorageClick: () => void;
  /** Open the browser profiles pane. */
  onBrowserClick?: () => void;
  /** Open the version and updates pane. */
  onUpdatesClick?: () => void;
  /** Open the Get started pane (connect a provider, choose models, meet Patty). */
  onGetStartedClick?: () => void;
  /** Open a Data or feature-gated Dev sub-view in the active pane. */
  onDataSearchClick: (tab: DataSearchTab) => void;
  /**
   * Row id whose surface is open in the active pane (from
   * `settingsSelectionId`) — the matching row shows the active-pane
   * highlight, mirroring the workspace tree's active node. `null` when the
   * active pane isn't a settings surface.
   */
  activeSelectionId?: string | null;
}

interface SettingsLeaf {
  id: string;
  label: string;
  /** Shown under the label and in the hover title. */
  description: string;
  /** Keyboard shortcut named in the hover title. */
  shortcut?: string;
  icon: ReactNode;
  /** Drag-to-split payload — same gesture as dragging a node or tool. */
  paneSelection: DetailSelection;
  onClick: () => void;
}

/**
 * SettingsView — settings surfaces in the shared SidebarTree frame, rendered
 * as a real collapsible tree:
 *
 *   General/         (Get started, Home or Profile and Agents, Command line, Theme, Browser,
 *                     Updates)
 *   Data/            (Embeddings, Backups, Local storage)
 *
 * Every leaf row opens its own detail view in the active pane (click) and is
 * pane-draggable (drop on pane chrome -> opens in a split). Group open/closed
 * state is local to this view.
 */
export const SettingsView: FC<SettingsViewProps> = ({
  onHomeClick,
  onProfileClick,
  onCliClick,
  onThemeClick,
  onAgentInstructionsClick,
  onStorageClick,
  onBrowserClick,
  onUpdatesClick,
  onGetStartedClick,
  onDataSearchClick,
  activeSelectionId = null,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [dataOpen, setDataOpen] = useState(true);
  // The command-line installer ships dark (`cli_pane_ui`, fails closed).
  const cliPaneEnabled = useFeatureFlag(CLI_PANE_UI_FLAG);
  // Home replaces the Profile row while `hub_home` is on (fails closed).
  const hubEnabled = useFeatureFlag(HUB_HOME_FLAG);

  const settingsLeaves: SettingsLeaf[] = [
    ...(onGetStartedClick
      ? [
          {
            id: 'get-started',
            label: LABELS['get-started'],
            description: 'Connect a provider, choose a model, meet Patty',
            icon: '✦',
            paneSelection: { kind: 'get-started' } as DetailSelection,
            onClick: onGetStartedClick,
          },
        ]
      : []),
    hubEnabled && onHomeClick
      ? {
          id: 'hub',
          label: LABELS.hub,
          description: 'Pinned items, recent work, your name',
          shortcut: paneShortcutHint('home'),
          icon: '⌂',
          paneSelection: { kind: 'hub' },
          onClick: onHomeClick,
        }
      : {
          id: 'profile',
          label: LABELS.profile,
          description: 'Name and email',
          icon: '◉',
          paneSelection: { kind: 'profile' },
          onClick: onProfileClick,
        },
    ...(cliPaneEnabled
      ? [
          {
            id: 'cli',
            label: LABELS.cli,
            description: 'Install the snaglet terminal command',
            icon: '$',
            paneSelection: { kind: 'cli' } as DetailSelection,
            onClick: onCliClick,
          },
        ]
      : []),
    {
      id: 'theme',
      label: LABELS.theme,
      description: 'Colors, fonts, and visual preferences',
      icon: '◐',
      paneSelection: { kind: 'theme' },
      onClick: onThemeClick,
    },
    // Home's Instructions card edits the same setting, so this row shows only
    // while Home is off.
    ...(hubEnabled && onHomeClick
      ? []
      : [
          {
            id: 'agent-instructions',
            label: LABELS['agent-instructions'],
            description: 'Instructions for all agents',
            icon: '☺',
            paneSelection: { kind: 'agent-instructions' } as DetailSelection,
            onClick: onAgentInstructionsClick,
          },
        ]),
    ...(onBrowserClick
      ? [
          {
            id: 'browser',
            label: LABELS.browser,
            description: 'Sign-in profile agents browse with',
            icon: '◎',
            paneSelection: { kind: 'browser' } as DetailSelection,
            onClick: onBrowserClick,
          },
        ]
      : []),
    ...(onUpdatesClick
      ? [
          {
            id: 'updates',
            label: LABELS.updates,
            description: 'Your version and new releases',
            icon: '⇡',
            paneSelection: { kind: 'updates' } as DetailSelection,
            onClick: onUpdatesClick,
          },
        ]
      : []),
  ];

  const dataLeaves: SettingsLeaf[] = [
    {
      id: 'embeddings',
      label: LABELS.embeddings,
      description: 'Coverage, backfill, and indexed content',
      icon: '◆',
      paneSelection: { kind: 'embeddings', tab: 'embeddings' },
      onClick: () => onDataSearchClick('embeddings'),
    },
    {
      id: 'backups',
      label: LABELS.backups,
      description: 'Snapshots and restore',
      icon: '↻',
      paneSelection: { kind: 'embeddings', tab: 'backups' },
      onClick: () => onDataSearchClick('backups'),
    },
    {
      id: 'storage',
      label: LABELS.storage,
      description: 'Disk usage and local models',
      icon: '↺',
      paneSelection: { kind: 'storage' },
      onClick: onStorageClick,
    },
  ];

  const renderLeaf = (leaf: SettingsLeaf) => (
    <TreeRow
      key={leaf.id}
      role="treeitem"
      depth={1}
      chevron="empty"
      icon={leaf.icon}
      label={leaf.label}
      description={leaf.description}
      paneSelection={leaf.paneSelection}
      active={activeSelectionId === leaf.id}
      aria-selected={activeSelectionId === leaf.id}
      onClick={leaf.onClick}
      title={`${leaf.description}${leaf.shortcut ? ` (${leaf.shortcut})` : ''} — drag onto a pane to open in a split`}
    />
  );

  return (
    <SidebarView title="Settings">
      <Tree>
        <TreeGroup
          label="General"
          count={settingsLeaves.length}
          open={settingsOpen}
          onToggle={() => setSettingsOpen((v) => !v)}
        >
          {settingsLeaves.map(renderLeaf)}
        </TreeGroup>

        <TreeGroup
          label="Data"
          count={dataLeaves.length}
          open={dataOpen}
          onToggle={() => setDataOpen((v) => !v)}
        >
          {dataLeaves.map(renderLeaf)}
        </TreeGroup>
      </Tree>
    </SidebarView>
  );
};
