import { type FC } from 'react';
import { EmptyState } from '@desktop/components';
import { AgentView } from './AgentView';
import { DmView } from './DmView';
import { ThreadPane } from './ThreadPane';
import { ContainerView } from './ContainerView';
import { DocView } from './DocView';
import { FileView } from './FileView';
import { SkillFileView } from './SkillFileView';
import { CalendarView } from './CalendarView';
import { ImageView } from './ImageView';
import { ProfileView } from './ProfileView';
import { HubView } from './HubView';
import { GetStartedView } from './GetStartedView';
import { StorageView } from './StorageView';
import { BrowserSettingsView } from './BrowserSettingsView';
import { ProvidersView } from './ProvidersView';
import { McpClientConnectionView, McpServerConnectionView } from './McpConnections';
import { DataSearchView } from './DataSearchView';
import { CliSettingsView } from './CliSettingsView';
import { ThemeView } from './ThemeView';
import { AgentInstructionsView } from './AgentInstructionsView';
import { ToolPane } from './ToolView';
import { HookBuilderView } from './HookBuilderView';
import { AutomationPane } from './AutomationView';
import { TableDraftView, TableView } from './TableView';
import { UnresolvedWorkspaceItem } from './UnresolvedWorkspaceItem';
import { selectionFromWorkspaceNode, type DetailSelection } from '../selection/types';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { CLI_PANE_UI_FLAG, HUB_HOME_FLAG } from '@snaglet/shared/types';
import { useFeatureFlag } from '@desktop/features/featureFlags/FeatureFlagsContext';
import { shortcutHint } from '@desktop/utils/platform';

interface DetailRouterProps {
  selection: DetailSelection;
  /**
   * Called when the active view wants to swap this pane's whole
   * selection — used by ContainerView when a child opens in the same pane.
   */
  onReplaceSelection?: (selection: DetailSelection) => void;
  /** Close the pane this router renders in (offered when its item is gone). */
  onClosePane?: () => void;
}

// A component (not a module-level JSX constant): JSX at module scope
// evaluates at import time, before code-inspector's dev runtime installs
// its __codeInspectorPath global, and crashes the pane.
const NothingSelected: FC = () => (
  <EmptyState
    title="Nothing open here"
    body={`Open a doc, thread, table or agent from the sidebar, drag one onto this pane, or press ${shortcutHint('K')} to search.`}
  />
);

/**
 * DetailRouter — renders the view for a pane's selection. Pane chrome owns
 * the unified topbar; each view pushes its own action buttons up via
 * `usePaneChromeActions`.
 *
 * Views that hold per-item state (drafts, pending saves, confirmations) are
 * keyed on their item id so an async result for one item can never land on
 * the next item opened in the same pane.
 */
const DetailRouter: FC<DetailRouterProps> = ({ selection, onReplaceSelection, onClosePane }) => {
  // A pane restored from an earlier layout may still point at the command-line
  // installer; while `cli_pane_ui` is off it shows the empty state instead.
  const cliPaneEnabled = useFeatureFlag(CLI_PANE_UI_FLAG);
  // Home ships dark (`hub_home`, fails closed): while it is off a restored
  // Home pane shows the empty state and Profile opens as before.
  const hubEnabled = useFeatureFlag(HUB_HOME_FLAG);
  const openResolvedNode = onReplaceSelection
    ? (node: LibraryTreeChild) => onReplaceSelection(selectionFromWorkspaceNode(node))
    : undefined;
  const unresolved = (id: string) => (
    <UnresolvedWorkspaceItem
      key={id}
      id={id}
      onResolved={openResolvedNode}
      onClosePane={onClosePane}
    />
  );

  if (!selection) {
    return <NothingSelected />;
  }

  if (selection.kind === 'agent') {
    return (
      <AgentView
        key={selection.agent.id}
        agent={selection.agent}
        focusTab={selection.focusTab}
        focusRequestId={selection.focusRequestId}
        onClosePane={onClosePane}
      />
    );
  }

  if (selection.kind === 'hub') {
    return hubEnabled ? <HubView onReplaceSelection={onReplaceSelection} /> : <NothingSelected />;
  }

  // With Home on, the profile pane opens Home instead; Home's "Account and
  // users" link (`account`) still reaches the profile pane.
  if (selection.kind === 'profile') {
    return hubEnabled && !selection.account ? (
      <HubView onReplaceSelection={onReplaceSelection} />
    ) : (
      <ProfileView />
    );
  }

  if (selection.kind === 'browser') {
    return <BrowserSettingsView />;
  }

  if (selection.kind === 'get-started') {
    return <GetStartedView onReplaceSelection={onReplaceSelection} />;
  }

  if (selection.kind === 'storage') {
    return <StorageView />;
  }

  if (selection.kind === 'providers') {
    return <ProvidersView />;
  }
  if (selection.kind === 'provider') {
    return (
      <ProvidersView
        providerId={selection.provider_id}
        focusModelId={selection.focusModelId ?? null}
      />
    );
  }
  if (selection.kind === 'mcp-client-connection') {
    return <McpClientConnectionView key={selection.client_id} clientId={selection.client_id} />;
  }
  if (selection.kind === 'mcp-server-connection') {
    return <McpServerConnectionView key={selection.server_id} serverId={selection.server_id} />;
  }
  if (selection.kind === 'cli') {
    return cliPaneEnabled ? <CliSettingsView /> : <NothingSelected />;
  }
  if (selection.kind === 'theme') {
    return <ThemeView />;
  }
  if (selection.kind === 'agent-instructions') {
    return <AgentInstructionsView />;
  }
  if (selection.kind === 'embeddings') {
    return <DataSearchView tab={selection.tab} />;
  }
  if (selection.kind === 'tool') {
    return <ToolPane key={selection.tool.id} tool={selection.tool} startEditing={selection.edit} />;
  }
  if (selection.kind === 'tool-create') {
    return <ToolPane key="tool-create" create onReplaceSelection={onReplaceSelection} />;
  }
  if (selection.kind === 'hook') {
    return <HookBuilderView key={selection.hook.hookName} hook={selection.hook} />;
  }
  if (selection.kind === 'hook-create') {
    return <HookBuilderView key="hook-create" />;
  }
  if (selection.kind === 'automation-detail') {
    return <AutomationPane key={selection.automation_id} automationId={selection.automation_id} />;
  }
  if (selection.kind === 'automation-create') {
    return (
      <AutomationPane key="automation-create" create onReplaceSelection={onReplaceSelection} />
    );
  }
  if (selection.kind === 'skill') {
    return (
      <SkillFileView
        key={`${selection.skill_id}:${selection.path}`}
        skillId={selection.skill_id}
        slug={selection.slug}
        path={selection.path}
      />
    );
  }
  // Database catalog tables are not workspace nodes: they render from their
  // catalog id and never go through node hydration.
  if (selection.kind === 'table') {
    return (
      <TableView
        key={selection.table_id}
        tableId={selection.table_id}
        initial={selection.table}
        focusEntryId={selection.focusEntryId}
        openEntryId={selection.openEntryId}
        focusRequestId={selection.focusRequestId}
        onClosePane={onClosePane}
      />
    );
  }
  if (selection.kind === 'table-draft') {
    return (
      <TableDraftView
        key={selection.draft_id}
        draftId={selection.draft_id}
        projectId={selection.project_id ?? null}
      />
    );
  }
  if (selection.kind === 'file') {
    return <FileView key={selection.node.id} node={selection.node} />;
  }

  // Threads render directly from their id. Other workspace
  // surfaces need the hydrated node cache populated by useDashboardLayout.
  // A DM thread opened as a thread (bell, chip, navigate_pane) gets the DM pane.
  if (selection.kind === 'thread') {
    return (
      <ThreadPane
        key={selection.thread_id}
        selection={selection}
        onReplaceSelection={onReplaceSelection}
        onClosePane={onClosePane}
      />
    );
  }

  // A DM conversation: not a workspace node, rendered from its thread id.
  if (selection.kind === 'dm') {
    return (
      <DmView
        key={selection.thread_id}
        threadId={selection.thread_id}
        title={selection.title ?? null}
        onClosePane={onClosePane}
      />
    );
  }

  if (selection.kind === 'container') {
    if (selection.node) {
      // A project is a container with `category === 'project'`. ContainerView
      // owns the project surface (Contents grid, details dropdown, Threads and
      // Tables sections) — no separate `project` selection kind exists.
      return (
        <ContainerView
          key={selection.node.id}
          container={selection.node}
          onOpenNode={(node) => onReplaceSelection?.(selectionFromWorkspaceNode(node))}
        />
      );
    }
    return unresolved(selection.container_id);
  }

  if (selection.kind === 'doc') {
    if (selection.node) {
      return <DocView key={selection.node.id} node={selection.node} />;
    }
    return unresolved(selection.doc_id);
  }

  // There is no Sketch view. A stray `sketch-…` id (restored layout or a
  // stale chip) resolves to the generic unresolved-item pane, which reports
  // it archived or gone.
  if (selection.kind === 'sketch') return unresolved(selection.sketch_id);

  // The Calendar pane is a singleton. Its selection carries the view (zoom and
  // day) so the pane's back / forward arrows step through the views visited.
  if (selection.kind === 'calendar') {
    return (
      <CalendarView
        paneView={selection.view}
        onPaneViewChange={(view) => onReplaceSelection?.({ kind: 'calendar', view })}
      />
    );
  }

  if (selection.kind === 'image') {
    return selection.node ? (
      <ImageView key={selection.node.id} node={selection.node} />
    ) : (
      unresolved(selection.image_id)
    );
  }

  return <NothingSelected />;
};

export { DetailRouter };
