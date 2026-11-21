import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { CLI_PANE_UI_FLAG, type TableCatalogEntry } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { threadsApi } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useFeatureFlag } from '@desktop/features/featureFlags/FeatureFlagsContext';
import { NEW_THREAD_TITLE, createQuickDoc } from '../../hooks/useQuickCreateHotkeys';
import { ThreadAgentPickerModal } from '@desktop/features/workspace-tree/ThreadAgentPickerModal';
import { useDashboardNavigation } from '../../selection/DashboardNavigationContext';
import type { DetailSelection } from '../../selection/types';
import { HubScreen } from './HubScreen';
import {
  pinnableTables,
  recentDocs,
  recentThreads,
  threadActivityAt,
  type PinKind,
  type TreeIndex,
} from './hubModel';
import type {
  HubDocRow,
  HubPinCandidate,
  HubPinRow,
  HubThreadRow,
  HubWorkspaceLink,
} from './hubTypes';
import {
  useGlobalInstructions,
  useHubPins,
  useHubProfile,
  useHubTables,
  useHubTree,
  useThreadDetails,
} from './useHubData';

/** The greeting follows the clock; once a minute is plenty. */
const CLOCK_TICK_MS = 60_000;
/**
 * Thread rows whose agents and last message load before any scrolling:
 * about a screenful. The rest load as they scroll into view.
 */
const THREAD_DETAILS_UP_FRONT = 12;

interface HubViewProps {
  /** Open a selection in this pane (Back returns to Home). */
  onReplaceSelection?: (selection: DetailSelection) => void;
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function threadTitle(title: string | null): string {
  return title?.trim() || 'Untitled thread';
}

/** A pin's row: the live item when it can be found, else its saved title. */
function pinRow(
  pin: { kind: PinKind; id: string; title?: string },
  index: TreeIndex | null,
  tables: TableCatalogEntry[] | null
): HubPinRow {
  const saved = pin.title?.trim() || 'Untitled';
  const notFound = (known: boolean): HubPinRow => ({
    kind: pin.kind,
    id: pin.id,
    title: saved,
    meta: null,
    missing: known,
    // While the lists load, open by id: the pane looks the item up itself.
    selection: known
      ? null
      : pin.kind === 'table'
        ? { kind: 'table', table_id: pin.id }
        : pin.kind === 'project'
          ? { kind: 'container', container_id: pin.id }
          : pin.kind === 'doc'
            ? { kind: 'doc', doc_id: pin.id }
            : { kind: 'thread', thread_id: pin.id },
  });
  switch (pin.kind) {
    case 'doc': {
      const doc = index?.docsById.get(pin.id);
      if (!doc) return notFound(!!index);
      return {
        kind: 'doc',
        id: pin.id,
        title: doc.node.title || saved,
        meta: doc.path[doc.path.length - 1] ?? null,
        missing: false,
        selection: { kind: 'doc', doc_id: doc.node.id, node: doc.node },
      };
    }
    case 'thread': {
      const thread = index?.threadsById.get(pin.id);
      if (!thread) return notFound(!!index);
      return {
        kind: 'thread',
        id: pin.id,
        title: threadTitle(thread.node.title),
        meta: thread.projectName,
        missing: false,
        selection: { kind: 'thread', thread_id: thread.node.id, node: thread.node },
      };
    }
    case 'project': {
      const project = index?.projectsById.get(pin.id);
      if (!project) return notFound(!!index);
      return {
        kind: 'project',
        id: pin.id,
        title: project.name || saved,
        meta: null,
        missing: false,
        selection: { kind: 'container', container_id: project.id, node: project },
      };
    }
    case 'table': {
      const table = tables?.find((entry) => entry.id === pin.id);
      if (!table) return notFound(!!tables);
      return {
        kind: 'table',
        id: pin.id,
        title: table.name || saved,
        meta: table.projectId ? (index?.projectsById.get(table.projectId)?.name ?? null) : null,
        missing: false,
        selection: { kind: 'table', table_id: table.id, table },
      };
    }
  }
}

/**
 * HubView — the Home pane (`hub_home` flag): a greeting with the user's name
 * (edited in place), pinned items, the instructions for all agents, recent
 * threads and docs, and links to the settings that keep their own panes. Everything Home opens replaces it in this pane, so Back returns here.
 */
export const HubView: FC<HubViewProps> = ({ onReplaceSelection }) => {
  const nav = useDashboardNavigation();
  const cliEnabled = useFeatureFlag(CLI_PANE_UI_FLAG);
  const now = useNow();
  const profile = useHubProfile();
  const tree = useHubTree();
  const pins = useHubPins(profile.profile?.id ?? null);
  const { isPinned, pin, unpin } = pins;
  const [pickerOpen, setPickerOpen] = useState(false);
  // The table catalog names pinned tables and fills the picker's Tables group.
  const tables = useHubTables(
    pickerOpen || pins.pins.some((pinned) => pinned.kind === 'table')
  ).tables;
  const instructions = useGlobalInstructions();
  const [pickingAgents, setPickingAgents] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [creatingDoc, setCreatingDoc] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  const open = useCallback(
    (selection: NonNullable<DetailSelection>) => onReplaceSelection?.(selection),
    [onReplaceSelection]
  );

  const recentThreadList = useMemo(
    () => (tree.index ? recentThreads(tree.index) : []),
    [tree.index]
  );
  // Thread ids whose rows have been on screen; only those read their details.
  const [seenThreadIds, setSeenThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const onThreadRowVisible = useCallback((id: string) => {
    setSeenThreadIds((seen) => (seen.has(id) ? seen : new Set(seen).add(id)));
  }, []);
  const detailThreads = useMemo(
    () =>
      recentThreadList.filter(
        (thread, index) => index < THREAD_DETAILS_UP_FRONT || seenThreadIds.has(thread.node.id)
      ),
    [recentThreadList, seenThreadIds]
  );
  const details = useThreadDetails(detailThreads);

  const threadRows = useMemo<HubThreadRow[]>(
    () =>
      recentThreadList.map(({ node, projectName }) => {
        const detail = details.get(node.id);
        return {
          id: node.id,
          title: threadTitle(node.title),
          projectName,
          activityAt: threadActivityAt(node) || null,
          agents: detail?.agents ?? [],
          snippet: detail?.snippet ?? null,
          detailsStatus: detail?.status ?? 'loading',
          pinned: isPinned('thread', node.id),
          selection: { kind: 'thread', thread_id: node.id, node },
        };
      }),
    [details, isPinned, recentThreadList]
  );

  const docRows = useMemo<HubDocRow[]>(
    () =>
      (tree.index ? recentDocs(tree.index) : []).map(({ node, path }) => ({
        id: node.id,
        title: node.title || 'Untitled doc',
        path,
        updatedAt: node.updatedAt,
        pinned: isPinned('doc', node.id),
        selection: { kind: 'doc', doc_id: node.id, node },
      })),
    [isPinned, tree.index]
  );

  const pinRows = useMemo(
    () => pins.pins.map((pin) => pinRow(pin, tree.index, tables)),
    [pins.pins, tables, tree.index]
  );

  const candidates = useMemo<HubPinCandidate[] | null>(() => {
    if (!pickerOpen || !tree.index) return null;
    const index = tree.index;
    return [
      ...index.projects.map((project) => ({
        kind: 'project' as const,
        id: project.id,
        title: project.name,
        meta: null,
      })),
      ...pinnableTables(tables ?? []).map((table) => ({
        kind: 'table' as const,
        id: table.id,
        title: table.name,
        meta: table.projectId ? (index.projectsById.get(table.projectId)?.name ?? null) : null,
      })),
      ...recentDocs(index, Infinity).map(({ node, path }) => ({
        kind: 'doc' as const,
        id: node.id,
        title: node.title || 'Untitled doc',
        meta: path[path.length - 1] ?? null,
      })),
      ...recentThreads(index, Infinity).map(({ node, projectName }) => ({
        kind: 'thread' as const,
        id: node.id,
        title: threadTitle(node.title),
        meta: projectName,
      })),
    ];
  }, [pickerOpen, tables, tree.index]);

  const togglePin = useCallback(
    (kind: PinKind, row: { id: string; title: string; pinned: boolean }) => {
      if (row.pinned) void unpin(kind, row.id);
      else void pin({ kind, id: row.id, title: row.title });
    },
    [pin, unpin]
  );

  const createThread = useCallback(
    async (agentIds: string[]) => {
      // A failed create rejects and the picker shows why; once the thread
      // exists the picker closes even if an agent did not join.
      const { thread, failedAgentIds } = await threadsApi.createInProjectWithAgents(
        NEW_THREAD_TITLE,
        null,
        agentIds
      );
      setPickingAgents(false);
      emitLibraryEvent({ type: 'tree-invalidated', ids: [] });
      setThreadError(
        failedAgentIds.length > 0
          ? `Thread created without ${failedAgentIds.length} agent${failedAgentIds.length === 1 ? '' : 's'}. Add them from the thread's Agents tab.`
          : null
      );
      open({
        kind: 'thread',
        thread_id: thread.id,
        node: {
          kind: 'thread',
          id: thread.id,
          projectId: null,
          title: thread.title ?? NEW_THREAD_TITLE,
          sortOrder: 0,
          lastMessageAt: null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt || null,
        },
      });
    },
    [open]
  );

  const createDoc = useCallback(async () => {
    if (creatingDoc) return;
    setCreatingDoc(true);
    setDocError(null);
    try {
      const node = await createQuickDoc();
      open({ kind: 'doc', doc_id: node.id, node });
    } catch (err) {
      setDocError(getErrorMessage(err, 'Could not create the doc'));
    } finally {
      setCreatingDoc(false);
    }
  }, [creatingDoc, open]);

  const workspaceLinks = useMemo<HubWorkspaceLink[]>(() => {
    const links: HubWorkspaceLink[] = [
      {
        id: 'account',
        label: 'Account and users',
        description: 'Your email and which user you act as.',
        icon: '◉',
        onOpen: () => open({ kind: 'profile', account: true }),
      },
      {
        id: 'providers',
        label: 'Providers',
        description: 'Model providers and keys',
        icon: '⚡',
        onOpen: () => open({ kind: 'providers' }),
      },
      {
        id: 'mcp',
        label: 'MCP',
        description: 'MCP clients and servers',
        icon: '⇄',
        onOpen: () => nav?.openSidebarView?.('mcp'),
      },
      {
        id: 'theme',
        label: 'Theme',
        description: 'Colors, fonts, and visual preferences',
        icon: '◐',
        onOpen: () => open({ kind: 'theme' }),
      },
      {
        id: 'storage',
        label: 'Local storage',
        description: 'Disk usage and local models',
        icon: '↺',
        onOpen: () => open({ kind: 'storage' }),
      },
      {
        id: 'browser',
        label: 'Browser',
        description: 'Sign-in profile agents browse with',
        icon: '◎',
        onOpen: () => open({ kind: 'browser' }),
      },
      {
        id: 'updates',
        label: 'Updates',
        description: 'Your version and new releases',
        icon: '⇡',
        onOpen: () => open({ kind: 'updates' }),
      },
      {
        id: 'embeddings',
        label: 'Embeddings',
        description: 'Coverage, backfill, and indexed content',
        icon: '◆',
        onOpen: () => open({ kind: 'embeddings', tab: 'embeddings' }),
      },
      {
        id: 'backups',
        label: 'Backups',
        description: 'Snapshots and restore',
        icon: '↻',
        onOpen: () => open({ kind: 'embeddings', tab: 'backups' }),
      },
    ];
    if (cliEnabled) {
      links.push({
        id: 'cli',
        label: 'Command line',
        description: 'Install the snaglet terminal command',
        icon: '$',
        onOpen: () => open({ kind: 'cli' }),
      });
    }
    return links;
  }, [cliEnabled, nav, open]);

  const firstLoadError = profile.error ?? null;

  return (
    <>
      <HubScreen
        header={{
          now,
          status: profile.status,
          name: profile.profile?.name ?? null,
          error: firstLoadError,
          onSaveName: profile.saveName,
        }}
        pinned={{
          // Pins wait for the profile (they are per user); a failed profile
          // read leaves them unloadable, so say so there too.
          status: profile.status === 'error' ? 'error' : pins.status,
          error: profile.status === 'error' ? firstLoadError : pins.error,
          onRetry: profile.status === 'error' ? undefined : pins.reload,
          rows: pinRows,
          onOpen: open,
          onUnpin: (kind, id) => void unpin(kind, id),
          candidates,
          onPin: (candidate) =>
            void pin({ kind: candidate.kind, id: candidate.id, title: candidate.title }),
          onPickerOpenChange: setPickerOpen,
        }}
        threads={{
          status: tree.status,
          error: tree.error,
          onRetry: tree.reload,
          rows: threadRows,
          onOpen: open,
          onTogglePin: (row) => togglePin('thread', row),
          onNewThread: () => {
            setThreadError(null);
            setPickingAgents(true);
          },
          actionError: threadError,
          onRowVisible: onThreadRowVisible,
        }}
        docs={{
          status: tree.status,
          error: tree.error,
          onRetry: tree.reload,
          rows: docRows,
          onOpen: open,
          onTogglePin: (row) => togglePin('doc', row),
          onNewDoc: () => void createDoc(),
          creating: creatingDoc,
          actionError: docError,
        }}
        instructions={{
          status: instructions.status,
          saved: instructions.saved,
          error: instructions.error,
          onSave: instructions.save,
        }}
        workspace={{ links: workspaceLinks }}
      />
      {pickingAgents && (
        <ThreadAgentPickerModal
          threadTitle={NEW_THREAD_TITLE}
          onCancel={() => setPickingAgents(false)}
          onCreate={createThread}
        />
      )}
    </>
  );
};
