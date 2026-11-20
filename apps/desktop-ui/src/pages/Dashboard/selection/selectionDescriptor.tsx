import { type ReactNode } from 'react';
import {
  BoxIcon,
  ChatBubbleIcon,
  DmsViewIcon,
  DocIcon,
  HookIcon,
  ImageIcon,
  SwirlIcon,
  TableIcon,
  ToolIcon,
} from '@desktop/components/Icons';
import { ProjectIcon } from '@desktop/components/Icons/ProjectIcon';
import { useAutomation } from '@desktop/features/automations/automationsStore';
import { CalendarIcon } from '@desktop/features/calendar/CalendarIcon';
import {
  UNAVAILABLE_TABLE_LABEL,
  useLiveTableName,
  type LiveTableName,
} from '@desktop/features/database/tableNameCache';
import { HUB_HOME_FLAG } from '@snaglet/shared/types';
import { useFeatureFlag } from '@desktop/features/featureFlags/FeatureFlagsContext';
import type { DetailSelection } from './types';

/**
 * The canonical kind tag for a non-null `DetailSelection`. Container
 * selections collapse into either `container` or `project`, depending
 * on whether the container's `category === 'project'` — this is the
 * same split the pane surfaces (project vs plain container) make
 * downstream, so the descriptor matches what the user actually sees.
 */
export type SelectionKind =
  | 'agent'
  | 'container'
  | 'doc'
  | 'file'
  | 'thread'
  | 'dm'
  | 'image'
  | 'sketch'
  | 'calendar'
  | 'project'
  | 'profile'
  | 'hub'
  | 'get-started'
  | 'provider'
  | 'providers'
  | 'cli'
  | 'theme'
  | 'agent-instructions'
  | 'storage'
  | 'browser'
  | 'mcp-client-connection'
  | 'mcp-server-connection'
  | 'embeddings'
  | 'tool'
  | 'hook'
  | 'skill'
  | 'tool-create'
  | 'hook-create'
  | 'automation-detail'
  | 'automation-create'
  | 'table'
  | 'table-draft';

/**
 * Workspace content-node kinds that render as a `/ancestor/.../Title`
 * breadcrumb in the pane topbar. Everything else (agents, settings panes,
 * single tools) renders as a plain name with no leading slash or icon.
 * `image` and a project `file` are tree content nodes with a path, so they
 * render as breadcrumbs too (`file` has its own kind only so it does not take
 * the Doc color).
 */
const PATH_KINDS: ReadonlySet<SelectionKind> = new Set<SelectionKind>([
  'doc',
  'file',
  'thread',
  'container',
  'project',
  'image',
]);

/** True when the descriptor kind renders as a breadcrumb path (vs a plain name). */
export function isPathKind(kind: SelectionKind): boolean {
  return PATH_KINDS.has(kind);
}

/**
 * Entity kinds backed by a real workspace/DB node with a copyable id — the
 * only kinds that expose the "Copy ID" chip. Agents carry an id but have no
 * tree path, so they're an entity without a breadcrumb (plain name + chip).
 */
export function isEntityKind(kind: SelectionKind): boolean {
  return kind === 'agent' || isPathKind(kind);
}

export interface SelectionDescriptor {
  kind: SelectionKind;
  /** Database id of the displayed node (used by copy-id chips). */
  id: string;
  /** User-visible title — falls back to a kind-named default when missing. */
  title: string;
  /** Icon node ready to drop into a `<span>`-style icon slot. */
  icon: ReactNode;
}

/**
 * Single source of truth for "given a selection, what does it look like
 * in chrome / breadcrumb / history menu UI?" Rendered through
 * `useSelectionDescriptor` by `PaneChromePath` and `PaneHistoryNav`. Each
 * consumer maps `kind` to its own CSS class for tinting — the icon component
 * itself fills with `currentColor`, so tint propagates via the surrounding
 * `<span>`.
 */
function selectionDescriptor(
  selection: Exclude<DetailSelection, null>,
  liveTable: LiveTableName,
  liveAutomationName: string | undefined
): SelectionDescriptor {
  if (selection.kind === 'agent') {
    return {
      kind: 'agent',
      id: selection.agent.id,
      title: selection.agent.name || 'Agent',
      icon: <span aria-hidden>☺</span>,
    };
  }
  if (selection.kind === 'profile') {
    return {
      kind: 'profile',
      id: 'profile',
      title: 'My profile',
      icon: <span aria-hidden>☻</span>,
    };
  }
  if (selection.kind === 'hub') {
    return { kind: 'hub', id: 'hub', title: 'Home', icon: <span aria-hidden>⌂</span> };
  }
  if (selection.kind === 'providers') {
    return {
      kind: 'providers',
      id: 'providers',
      title: 'Providers',
      icon: <span aria-hidden>⚡</span>,
    };
  }
  if (selection.kind === 'provider') {
    return {
      kind: 'provider',
      id: selection.provider_id,
      title: selection.name || selection.provider_id,
      icon: <span aria-hidden>✦</span>,
    };
  }
  if (selection.kind === 'cli') {
    return {
      kind: 'cli',
      id: 'cli',
      title: 'Command line',
      icon: <span aria-hidden>$</span>,
    };
  }
  if (selection.kind === 'mcp-client-connection') {
    return {
      kind: 'mcp-client-connection',
      id: selection.client_id,
      title: selection.name || 'MCP client',
      icon: <span aria-hidden>⇢</span>,
    };
  }
  if (selection.kind === 'mcp-server-connection') {
    return {
      kind: 'mcp-server-connection',
      id: selection.server_id,
      title: selection.name || 'MCP server',
      icon: <span aria-hidden>⇠</span>,
    };
  }
  if (selection.kind === 'embeddings') {
    const tabTitles: Record<NonNullable<typeof selection.tab>, string> = {
      embeddings: 'Embeddings',
      backups: 'Backups',
    };
    return {
      kind: 'embeddings',
      id: selection.tab ? `embeddings:${selection.tab}` : 'embeddings',
      title: selection.tab ? tabTitles[selection.tab] : 'Embeddings',
      icon: <span aria-hidden>⋯</span>,
    };
  }
  if (selection.kind === 'tool') {
    return {
      kind: 'tool',
      id: selection.tool.id,
      title: selection.tool.name || selection.tool.id || 'Tool',
      icon: <ToolIcon />,
    };
  }
  if (selection.kind === 'tool-create') {
    return { kind: 'tool-create', id: 'tool-create', title: 'New tool', icon: <ToolIcon /> };
  }
  if (selection.kind === 'hook') {
    return {
      kind: 'hook',
      id: selection.hook.hookName,
      title: selection.hook.hookName || 'Script',
      icon: <HookIcon />,
    };
  }
  if (selection.kind === 'hook-create') {
    return { kind: 'hook-create', id: 'hook-create', title: 'New script', icon: <HookIcon /> };
  }
  if (selection.kind === 'automation-detail') {
    return {
      kind: 'automation-detail',
      id: selection.automation_id,
      title: liveAutomationName || selection.name || 'Automation',
      icon: <SwirlIcon size={14} />,
    };
  }
  if (selection.kind === 'automation-create') {
    return {
      kind: 'automation-create',
      id: 'automation-create',
      title: 'New automation',
      icon: <SwirlIcon size={14} />,
    };
  }
  if (selection.kind === 'skill') {
    return {
      kind: 'skill',
      id: `${selection.skill_id}:${selection.path}`,
      title: `${selection.slug} / ${selection.path}`,
      icon: <DocIcon />,
    };
  }
  if (selection.kind === 'table') {
    return {
      kind: 'table',
      id: selection.table_id,
      title: liveTable.unavailable
        ? UNAVAILABLE_TABLE_LABEL
        : liveTable.name || selection.table?.name || 'Table',
      icon: <TableIcon />,
    };
  }
  if (selection.kind === 'table-draft') {
    return { kind: 'table-draft', id: selection.draft_id, title: 'New table', icon: <TableIcon /> };
  }
  // Workspace selections carry a canonical id plus an optional hydrated node
  // for their current user-facing title.
  if (selection.kind === 'doc') {
    return {
      kind: 'doc',
      id: selection.doc_id,
      title: selection.node?.title || `Doc ${selection.doc_id}`,
      icon: <DocIcon />,
    };
  }
  if (selection.kind === 'thread') {
    return {
      kind: 'thread',
      id: selection.thread_id,
      title: selection.node?.title || `Thread ${selection.thread_id}`,
      icon: <ChatBubbleIcon />,
    };
  }
  if (selection.kind === 'dm') {
    return {
      kind: 'dm',
      id: selection.thread_id,
      title: selection.title || 'Direct messages',
      icon: <DmsViewIcon size={14} />,
    };
  }
  if (selection.kind === 'file') {
    return {
      kind: 'file',
      id: selection.node.id,
      title: selection.node.name || selection.node.relativePath || 'File',
      icon: <DocIcon />,
    };
  }
  if (selection.kind === 'container') {
    // A project is a container with `category === 'project'` — tint + label
    // it as a project so the chrome matches what the user sees.
    if (selection.node?.category === 'project') {
      return {
        kind: 'project',
        id: selection.container_id,
        title: selection.node?.name || `Project ${selection.container_id}`,
        icon: <ProjectIcon />,
      };
    }
    return {
      kind: 'container',
      id: selection.container_id,
      title: selection.node?.name || `Container ${selection.container_id}`,
      icon: <BoxIcon />,
    };
  }
  // There is no Sketch view; a stray `sketch-…` id renders through the
  // unresolved-item pane, so it only needs a neutral descriptor.
  if (selection.kind === 'sketch')
    return {
      kind: 'sketch',
      id: selection.sketch_id,
      title: 'Sketch',
      icon: <DocIcon />,
    };
  if (selection.kind === 'calendar') {
    return { kind: 'calendar', id: 'calendar', title: 'Calendar', icon: <CalendarIcon /> };
  }
  if (selection.kind === 'image') {
    return {
      kind: 'image',
      id: selection.image_id,
      title: selection.node?.name || `Image ${selection.image_id}`,
      icon: <ImageIcon />,
    };
  }
  if (selection.kind === 'theme') {
    return {
      kind: 'theme',
      id: 'theme',
      title: 'Theme',
      icon: <span aria-hidden>◐</span>,
    };
  }
  if (selection.kind === 'agent-instructions') {
    return {
      kind: 'agent-instructions',
      id: 'agent-instructions',
      title: 'Agents',
      // Matches the General-group row glyph in SettingsView.
      icon: <span aria-hidden>☺</span>,
    };
  }
  if (selection.kind === 'browser') {
    return { kind: 'browser', id: 'browser', title: 'Browser', icon: <span aria-hidden>◎</span> };
  }
  if (selection.kind === 'get-started') {
    return {
      kind: 'get-started',
      id: 'get-started',
      title: 'Get started',
      // Matches the General-group row glyph in SettingsView.
      icon: <span aria-hidden>✦</span>,
    };
  }
  if (selection.kind === 'storage') {
    return {
      kind: 'storage',
      id: 'storage',
      title: 'Local storage',
      // Matches the Data-group row glyph in SettingsView — settings surfaces
      // keep one icon across sidebar row, pane chrome, and view header.
      icon: <span aria-hidden>↺</span>,
    };
  }

  const _exhaustive: never = selection;
  return _exhaustive;
}

/**
 * The descriptor for a selection, or `null` for an empty pane. A table's
 * title reads the shared live name cache first: the selection's catalog
 * snapshot is only patched by `table.updated` events this client hears, so a
 * layout restored from storage or a rename missed while disconnected would
 * otherwise keep an old name. An archived table keeps its name; a table
 * neither the catalog nor the archive has reads as unavailable, like a
 * table chip.
 */
export function useSelectionDescriptor(selection: DetailSelection): SelectionDescriptor | null {
  const liveTable = useLiveTableName(selection?.kind === 'table' ? selection.table_id : null);
  // An automation's title follows renames by agents or the Edit form.
  const liveAutomation = useAutomation(
    selection?.kind === 'automation-detail' ? selection.automation_id : null
  );
  // With `hub_home` on, a profile selection renders the Home pane (see
  // DetailRouter), so it is named like one.
  const hubEnabled = useFeatureFlag(HUB_HOME_FLAG);
  const shown =
    hubEnabled && selection?.kind === 'profile' && !selection.account
      ? ({ kind: 'hub' } as const)
      : selection;
  return shown ? selectionDescriptor(shown, liveTable, liveAutomation?.name) : null;
}
