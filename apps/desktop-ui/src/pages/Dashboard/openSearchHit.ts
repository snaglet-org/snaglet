/**
 * Open a raw `PaletteSearchHit` from the workspace tree's inline search the
 * same way the Cmd+K palette opens it: the hit is mapped to a palette node
 * and routed through `openPaletteResult`, the single dispatcher for
 * "user picked a search result".
 *
 * Workspace nodes (container / doc / thread / image) are skipped:
 * the tree opens those itself from its loaded node index, which carries the
 * fully hydrated node a raw hit lacks. Everything else — memory /
 * thread_summary / message (a thread focused on that entry), agent and
 * tool (fetched by id) — is dispatched here.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import type { ThreadTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import type { ToolRow } from '@desktop/utils/api/types';
import type { PaletteSearchHit } from '@desktop/utils/api/palette-search';
import type { SnagletAgent } from '@snaglet/shared/types';
import { openPaletteResult } from './components/CommandPalette/paletteActions';
import { serverHitToNode } from './components/CommandPalette/paletteResultMappers';

export interface OpenSearchHitDeps {
  openWorkspaceNode: (node: LibraryTreeChild) => void;
  openThreadAgent: (
    thread: ThreadTreeNode,
    agentId: string,
    opts?: { focus?: { kind: 'memory' | 'summary'; id: string } }
  ) => void;
  /**
   * Open a thread focused on a specific message — the chat loads a
   * window centered on `messageId` and holds that row in view, highlighted.
   */
  openThreadWithFocusMessage: (thread: ThreadTreeNode, messageId: string) => void;
  openAgent: (agent: SnagletAgent) => void;
  openTool: (tool: ToolRow) => void;
}

const WORKSPACE_NODE_KINDS = new Set<string>(['container', 'doc', 'thread', 'image']);

export async function openSearchHit(hit: PaletteSearchHit, deps: OpenSearchHitDeps): Promise<void> {
  if (WORKSPACE_NODE_KINDS.has(hit.kind)) return;
  try {
    await openPaletteResult(serverHitToNode(hit), {
      onSelect: deps.openWorkspaceNode,
      onOpenThreadAgent: deps.openThreadAgent,
      onOpenThreadWithFocusMessage: deps.openThreadWithFocusMessage,
      onOpenTool: deps.openTool,
      onOpenAgent: deps.openAgent,
    });
  } catch (err) {
    // The pick already switched the sidebar; a failed agent/tool fetch just
    // leaves the pane where it was.
    console.error('openSearchHit: failed to open search hit', getErrorMessage(err));
  }
}
