import {
  type FileTreeNode,
  type LibraryTreeChild,
  type PaletteFileNodeItem,
  type PaletteFilesystemItem,
  type ThreadTreeNode,
  type ToolRow,
  toolsApi,
  agentsApi,
} from '@desktop/utils/api';
import type { SnagletAgent, TableCatalogEntry } from '@snaglet/shared/types';
import { paletteTableEntry } from '@desktop/utils/api/palette-search';
import { type PaletteResultNode } from './paletteResultMappers';

/**
 * Handlers the palette owner supplies for opening a resolved result. These are
 * the exact `CommandPalette` props used by {@link openPaletteResult}, kept as a
 * focused subset so the dispatch logic lives outside the component body.
 */
export interface PaletteResultOpenHandlers {
  onSelect: (node: LibraryTreeChild) => void;
  onOpenThreadAgent: (
    thread: ThreadTreeNode,
    agentId: string,
    opts?: { focus?: { kind: 'memory' | 'summary'; id: string } }
  ) => void;
  onOpenThreadWithFocusMessage: (thread: ThreadTreeNode, messageId: string) => void;
  onOpenTool: (tool: ToolRow) => void;
  onOpenAgent: (agent: SnagletAgent) => void;
  /**
   * Open a Database table pane by catalog id; `table` is the hit's catalog
   * entry when its payload carries one. Optional.
   */
  onOpenTable?: (tableId: string, table?: TableCatalogEntry) => void;
  /**
   * Open a table row: `window` opens the table with that row's window (the
   * entry modal) over it; `highlight` opens the table with the row sought out
   * and highlighted in its grid. Optional like `onOpenPost`.
   */
  onOpenEntry?: (tableId: string, entryId: string, how: PaletteEntryOpen) => void;
}

/** How a picked table row opens: its window, or highlighted in the table. */
export type PaletteEntryOpen = 'window' | 'highlight';

/** How a result was picked. `secondary` is a ⌘/Ctrl-click or ⌘/Ctrl+Enter. */
export interface PaletteOpenOptions {
  secondary?: boolean;
}

/**
 * The file-pane node for a file result: an indexed project file keeps its
 * node id and project, a filesystem hit opens by absolute path.
 */
export function paletteFileToTreeNode(
  file: PaletteFileNodeItem | PaletteFilesystemItem
): FileTreeNode {
  if (file.type === 'file-node') {
    return {
      kind: 'file',
      id: file.nodeId,
      containerId: null,
      projectId: file.projectId,
      relativePath: file.relativePath,
      name: file.relativePath.split('/').pop() ?? file.relativePath,
      sizeBytes: file.sizeBytes,
      updatedAt: file.updatedAt,
    };
  }
  return {
    kind: 'file',
    id: file.path,
    containerId: null,
    projectId: '',
    relativePath: file.path,
    name: file.name,
    absolutePath: file.path,
    sizeBytes: 0,
    updatedAt: new Date().toISOString(),
  };
}

/** A non-empty string field from a search-hit payload, else null. */
function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Route a resolved palette node to the correct owner callback. Library kinds
 * (container/doc/thread/image) go through `onSelect`; auxiliary kinds resolve
 * their parent thread/agent (message/memory/summary) or fetch the full record
 * (tool/agent) before handing off. A table row opens its window, or with a
 * secondary pick (⌘/Ctrl) the table with that row highlighted.
 */
export async function openPaletteResult(
  node: PaletteResultNode,
  handlers: PaletteResultOpenHandlers,
  options: PaletteOpenOptions = {}
): Promise<void> {
  const {
    onSelect,
    onOpenThreadAgent,
    onOpenThreadWithFocusMessage,
    onOpenTool,
    onOpenAgent,
    onOpenTable,
    onOpenEntry,
  } = handlers;

  // A row's ids are its table's catalog id and its own UUID — never a node id.
  if (node.kind === 'entry') {
    onOpenEntry?.(node.tableId, node.id, options.secondary ? 'highlight' : 'window');
    return;
  }

  // A table hit's id is a catalog id, not a node id — it never goes through
  // `onSelect` or any node lookup.
  if (node.kind === 'table') {
    onOpenTable?.(node.id, paletteTableEntry(node.id, node.payload) ?? undefined);
    return;
  }

  if (
    node.kind === 'container' ||
    node.kind === 'doc' ||
    node.kind === 'thread' ||
    node.kind === 'image'
  ) {
    onSelect(node);
    return;
  }

  const payload = node.payload;
  const makeThreadNode = (threadId: string, title: string | null): ThreadTreeNode => ({
    kind: 'thread',
    id: threadId,
    projectId: null,
    title,
    sortOrder: 0,
    lastMessageAt: null,
    createdAt: '',
    updatedAt: null,
  });

  if (node.kind === 'message') {
    const threadId = payloadString(payload, 'threadId');
    if (threadId) {
      onOpenThreadWithFocusMessage(
        makeThreadNode(threadId, payloadString(payload, 'threadTitle')),
        node.id
      );
    }
    return;
  }
  if (node.kind === 'memory') {
    const threadId = payloadString(payload, 'sourceThreadId');
    const agentId = payloadString(payload, 'agentId');
    if (threadId && agentId) {
      onOpenThreadAgent(
        makeThreadNode(threadId, payloadString(payload, 'sourceThreadTitle')),
        agentId,
        {
          focus: { kind: 'memory', id: node.id },
        }
      );
    } else if (threadId) {
      onSelect(makeThreadNode(threadId, payloadString(payload, 'sourceThreadTitle')));
    }
    return;
  }
  if (node.kind === 'thread_summary') {
    const threadId = payloadString(payload, 'threadId');
    const agentId = payloadString(payload, 'agentId');
    if (threadId && agentId) {
      onOpenThreadAgent(makeThreadNode(threadId, payloadString(payload, 'threadTitle')), agentId, {
        focus: { kind: 'summary', id: node.id },
      });
    } else if (threadId) {
      onSelect(makeThreadNode(threadId, payloadString(payload, 'threadTitle')));
    }
    return;
  }
  if (node.kind === 'tool') {
    const tool = await toolsApi.get(node.id);
    onOpenTool(tool);
    return;
  }
  if (node.kind === 'agent') {
    const agent = await agentsApi.get(node.id);
    if (agent) onOpenAgent(agent);
    return;
  }
}
