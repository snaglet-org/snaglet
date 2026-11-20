import type { ToolHandler } from '@server/services/ToolService/types';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import {
  KIND_GLYPH,
  KIND_TO_LINK_SCHEME,
  parseKinds,
  resolveContainerScope,
  type WorkspaceNodeKind,
} from '@server/services/ToolService/lib/workspaceScope';
import { formatRelativeTime, isoStamp, wordCount } from '@snaglet/shared/utils';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import { Threads } from '@snaglet/db/tables/threads';
import {
  activeRunMarker,
  getThreadActivity,
  type ThreadActivity,
} from '@server/services/activeThreadRuns';
import { containerCategoryMarker } from '@server/services/ToolService/lib/containerCategoryMarker';
import type { ContainerCategory } from '@snaglet/shared/constants';

interface ContainerNode {
  kind: 'container';
  id: string;
  name: string;
  updatedAt: string;
  /** Optional semantic category rendered as an inline marker. */
  category: ContainerCategory | null;
  children: TreeNode[];
}
interface DocNode {
  kind: 'doc';
  id: string;
  title: string;
  updatedAt: string;
  wordCount: number;
}
interface ThreadNode {
  kind: 'thread';
  id: string;
  title: string;
  updatedAt: string;
}
/**
 * The Threads block under a project (or at the workspace level for flat
 * threads). Threads are not in the folder tree — a thread is scoped to a
 * project or is flat — so they render grouped, in their manual sidebar order,
 * rather than interleaved with docs and sub-folders.
 */
interface ThreadGroupNode {
  kind: 'threads';
  threads: ThreadNode[];
}
type TreeNode = ContainerNode | DocNode | ThreadNode | ThreadGroupNode;

const THREADS_BLOCK_LABEL = `${KIND_GLYPH.thread} Threads`;

function fmtLink(kind: WorkspaceNodeKind, id: string, label: string | null): string {
  return linkForm(KIND_TO_LINK_SCHEME[kind], id, label);
}

function renderNode(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  lines: string[],
  activityByThread: Map<string, ThreadActivity>
): void {
  const connector = isLast ? '└── ' : '├── ';
  if (node.kind === 'threads') {
    lines.push(`${prefix}${connector}${THREADS_BLOCK_LABEL}`);
    const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
    for (let i = 0; i < node.threads.length; i++) {
      renderNode(
        node.threads[i],
        childPrefix,
        i === node.threads.length - 1,
        lines,
        activityByThread
      );
    }
    return;
  }
  const updated = formatRelativeTime(node.updatedAt);
  if (node.kind === 'doc') {
    const link = fmtLink('doc', node.id, node.title);
    lines.push(`${prefix}${connector}${KIND_GLYPH.doc} ${link}  · ${updated} · ${node.wordCount}w`);
    return;
  }
  if (node.kind === 'thread') {
    const link = fmtLink('thread', node.id, node.title);
    const marker = activeRunMarker(activityByThread.get(node.id));
    const runTag = marker ? `  · ${marker}` : '';
    lines.push(`${prefix}${connector}${KIND_GLYPH.thread} ${link}  · ${updated}${runTag}`);
    return;
  }
  const link = fmtLink('container', node.id, node.name);
  // Categories annotate the existing container link; they never create a
  // second node or alter the ready-to-paste link form.
  const categoryMarker = containerCategoryMarker(node.category);
  const categoryTag = categoryMarker ? `  · ${categoryMarker}` : '';
  lines.push(`${prefix}${connector}${KIND_GLYPH.container} ${link}  · ${updated}${categoryTag}`);
  const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
  for (let i = 0; i < node.children.length; i++) {
    renderNode(
      node.children[i],
      childPrefix,
      i === node.children.length - 1,
      lines,
      activityByThread
    );
  }
}

const tool: ToolHandler = async (input) => {
  const kinds = new Set<WorkspaceNodeKind>(parseKinds(input.kinds));

  const [containerRows, docRows, threadRows] = await Promise.all([
    Containers.listAllOrdered(),
    kinds.has('doc') ? Docs.listAllOrdered() : Promise.resolve([]),
    kinds.has('thread') ? Threads.listAllOrdered() : Promise.resolve([]),
  ]);

  const scope = resolveContainerScope(input, containerRows);
  if (scope.kind === 'error') return scope.message;
  const rootContainerId = scope.kind === 'scoped' ? scope.containerId : null;

  // One pass over containerRows builds two indexes used by both the
  // allowed-set BFS and the actual node materialization.
  const parentIdById = new Map<string, string | null>();
  const childrenByParent = new Map<string | null, string[]>();
  for (const c of containerRows) {
    parentIdById.set(c.id, c.parentId);
    const key = c.parentId ?? null;
    const list = childrenByParent.get(key);
    if (list) list.push(c.id);
    else childrenByParent.set(key, [c.id]);
  }

  let allowedContainerIds: Set<string> | null = null;
  if (rootContainerId) {
    allowedContainerIds = new Set<string>();
    const queue: string[] = [rootContainerId];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (allowedContainerIds.has(id)) continue;
      allowedContainerIds.add(id);
      const kids = childrenByParent.get(id);
      if (kids) queue.push(...kids);
    }
  }

  const containerById = new Map<string, ContainerNode>();
  if (kinds.has('container')) {
    for (const c of containerRows) {
      if (allowedContainerIds && !allowedContainerIds.has(c.id)) continue;
      containerById.set(c.id, {
        kind: 'container',
        id: c.id,
        name: c.name,
        updatedAt: c.updatedAt,
        category: c.category,
        children: [],
      });
    }
  }

  const roots: ContainerNode[] = [];
  for (const [id, node] of containerById) {
    const parentId = parentIdById.get(id) ?? null;
    const parent = parentId ? containerById.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else if (!rootContainerId || id === rootContainerId) {
      roots.push(node);
    }
  }

  // Scope is applied before rendering. If container rows are hidden, keep
  // their matching leaves at the top level instead of dropping them.
  const looseLeaves: TreeNode[] = [];
  let scopedDocCount = 0;
  let scopedThreadCount = 0;
  // Thread ids rendered in this tree — feeds ONE batched active-run lookup.
  const scopedThreadIds: string[] = [];

  for (const d of docRows) {
    const inScope =
      !allowedContainerIds || (d.containerId !== null && allowedContainerIds.has(d.containerId));
    if (!inScope) continue;
    scopedDocCount++;
    const leaf: DocNode = {
      kind: 'doc',
      id: d.id,
      title: d.title,
      updatedAt: d.updatedAt,
      wordCount: wordCount(d.content),
    };
    const container = d.containerId ? containerById.get(d.containerId) : undefined;
    if (container) {
      container.children.push(leaf);
    } else {
      looseLeaves.push(leaf);
    }
  }

  // Threads attach to a project, not to any other container. A project thread is in scope
  // when its project is; a flat thread only when the whole workspace is. A
  // non-project scope therefore shows no threads of its own, while a nested
  // project's threads render under that project. `listAllOrdered` already
  // lists each project's threads in their manual (sidebar) order.
  const threadsByProject = new Map<string | null, ThreadNode[]>();
  for (const t of threadRows) {
    const inScope = allowedContainerIds
      ? t.projectId !== null && allowedContainerIds.has(t.projectId)
      : true;
    if (!inScope) continue;
    scopedThreadCount++;
    scopedThreadIds.push(t.id);
    const leaf: ThreadNode = {
      kind: 'thread',
      id: t.id,
      title: t.title ?? 'Untitled thread',
      // For threads, "recency" = last activity, not config edit time.
      // Fallback chain: last message → spine updatedAt → spine createdAt.
      updatedAt: t.lastMessageAt ?? t.updatedAt ?? t.createdAt ?? isoStamp(0),
    };
    // A project whose container row is not rendered (containers filtered out
    // by `kinds`) falls back to the top-level Threads block.
    const key = t.projectId !== null && containerById.has(t.projectId) ? t.projectId : null;
    const list = threadsByProject.get(key);
    if (list) list.push(leaf);
    else threadsByProject.set(key, [leaf]);
  }
  for (const [projectId, threads] of threadsByProject) {
    const group: ThreadGroupNode = { kind: 'threads', threads };
    if (projectId !== null) containerById.get(projectId)!.children.push(group);
    else looseLeaves.push(group);
  }

  // Single batched lookup: threads with a LIVE run get a `▶ running` marker.
  // Idle workspaces cost nothing (the tracker short-circuits before any query).
  const activityByThread = await getThreadActivity(scopedThreadIds);

  const lines: string[] = [];
  const topLevel: TreeNode[] = [...roots, ...looseLeaves];

  if (topLevel.length === 0) {
    lines.push('(empty workspace)');
  } else {
    for (let i = 0; i < topLevel.length; i++) {
      renderNode(topLevel[i], '', i === topLevel.length - 1, lines, activityByThread);
    }
  }

  const containerCount = kinds.has('container')
    ? allowedContainerIds
      ? allowedContainerIds.size
      : containerRows.length
    : 0;
  const parts: string[] = [];
  if (kinds.has('container')) parts.push(`${containerCount} container(s)`);
  if (kinds.has('doc')) parts.push(`${scopedDocCount} doc(s)`);
  if (kinds.has('thread')) parts.push(`${scopedThreadCount} thread(s)`);
  lines.push('');
  lines.push(parts.join(', '));

  return lines.join('\n');
};

export default tool;
