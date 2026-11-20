import { useEffect, useState, type FC, type ReactNode } from 'react';
import type { DocAnchor } from '@snaglet/shared/utils';
import { requestDocLineFocus } from '@desktop/features/rich-markdown/lineLinks/lineFocusStore';
import { Modal } from '@desktop/components';
import { CopyChipButton } from '@desktop/components';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer/MarkdownRenderer';
import { Chip } from '@desktop/features/rich-markdown/renderer/Chip';
import { chipHrefForNode } from '@desktop/utils/nodeChip';
import { MarkdownToggleView } from '@desktop/features/rich-markdown/markdown-toggle-view';
import { BoxIcon, ChatBubbleIcon, DocIcon, ImageIcon, ToolIcon } from '@desktop/components/Icons';
import { ProjectIcon } from '@desktop/components/Icons/ProjectIcon';
import {
  agentsApi,
  containersApi,
  docsApi,
  imagesApi,
  memoriesApi,
  threadsApi,
  toolsApi,
} from '@desktop/utils/api';
import type {
  ContainerTreeNode,
  DocRecord,
  DocTreeNode,
  LibraryTreeChild,
  MemoryDetailRecord,
  StoredImage,
  ThreadMessage,
  ThreadSummary,
  ThreadSummaryRecord,
  ToolRow,
} from '@desktop/utils/api';
import type { SnagletAgent } from '@snaglet/shared/types';

// The preview reuses the Dashboard's pane views. They register topbar controls
// through the pane chrome context, which reaches through the modal's portal;
// PaneChromeBoundary cuts it so a preview never takes over its pane's topbar.
import { PaneChromeBoundary } from '@desktop/pages/Dashboard/chrome/PaneChrome/PaneChrome';
import { AgentView } from '@desktop/pages/Dashboard/views/AgentView';
import { ChatView } from '@desktop/pages/Dashboard/views/ChatView';
import { ContainerView } from '@desktop/pages/Dashboard/views/ContainerView';
import { PaneFindProvider } from '@desktop/features/pane-find/PaneFindContext';
import { DocView } from '@desktop/pages/Dashboard/views/DocView';
import { ImageViewer } from '@desktop/components/ImageViewer';

import { ToolView } from '@desktop/pages/Dashboard/views/ToolView';

import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import styles from './WikiLinkPreviewModal.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';

/**
 * Kinds the preview can render, matching the node-link vocabulary in
 * `packages/db/tables/links/LinkModel.ts`. Each has an API client and a render
 * branch below.
 */
export type WikiNodeKind =
  | 'page'
  | 'container'
  | 'library_node'
  | 'thread'
  | 'thread_summary'
  | 'message'
  | 'memory'
  | 'agent'
  | 'project'
  | 'tool'
  | 'image';

export interface WikiLinkPreviewModalProps {
  kind: WikiNodeKind;
  id: string;
  onClose: () => void;
  /** Fires when the user clicks a wiki-link chip inside the previewed
   *  content. Lets the host component replace the modal's node to
   *  follow the link, instead of opening yet another stacked modal. */
  onChipClick?: (kind: WikiNodeKind, id: string) => void;
  /** Partial-doc link: open the doc scrolled to that part, highlighted. */
  anchor?: DocAnchor;
}

type LoadedPage = { kind: 'page'; data: DocRecord };
/** ChatView streams the thread itself; the summary gives the header a title
 *  before it connects. */
type LoadedThread = { kind: 'thread'; data: ThreadSummary };
/** Loaded from `containersApi.listTree` so ContainerView mounts with its
 *  children. A project is a container with `category === 'project'`. */
type LoadedContainer = { kind: 'container'; data: ContainerTreeNode };
type LoadedAgent = { kind: 'agent'; data: SnagletAgent };
type LoadedTool = { kind: 'tool'; data: ToolRow };
type LoadedMessage = { kind: 'message'; data: ThreadMessage };
type LoadedMemory = { kind: 'memory'; data: MemoryDetailRecord };
type LoadedThreadSummary = { kind: 'thread_summary'; data: ThreadSummaryRecord };
type LoadedImage = { kind: 'image'; data: StoredImage };

type Loaded =
  | LoadedPage
  | LoadedThread
  | LoadedContainer
  | LoadedAgent
  | LoadedTool
  | LoadedMessage
  | LoadedMemory
  | LoadedThreadSummary
  | LoadedImage;

const KIND_LABEL: Record<WikiNodeKind, string> = {
  page: 'Doc',
  container: 'Container',
  library_node: 'Workspace node',
  thread: 'Thread',
  thread_summary: 'Thread summary',
  message: 'Message',
  memory: 'Memory',
  agent: 'Agent',
  project: 'Project',
  tool: 'Tool',
  image: 'Image',
};

/**
 * Kinds whose preview is the main detail view, which brings its own padding
 * and scroll, so the modal body drops its padding for them.
 */
const KINDS_HOSTING_MAIN_VIEW: ReadonlySet<WikiNodeKind> = new Set<WikiNodeKind>([
  'page',
  'thread',
  'container',
  'library_node',
  'project',
  'agent',
  'tool',
  'message',
  'image',
]);

/** Icon for the header's kind badge, matching the chip's kind styling. */
const KindIcon: FC<{ kind: WikiNodeKind }> = ({ kind }) => {
  // A project is a container (category='project'); it draws the container
  // box with a star.
  if (kind === 'project') return <ProjectIcon />;
  if (kind === 'container' || kind === 'library_node') return <BoxIcon />;
  if (kind === 'thread' || kind === 'thread_summary' || kind === 'message')
    return <ChatBubbleIcon />;
  if (kind === 'page') return <DocIcon />;
  if (kind === 'tool') return <ToolIcon />;
  if (kind === 'image') return <ImageIcon />;
  return null;
};

/**
 * Modal that fetches a node by kind and id and previews it, on an `unstyled`
 * `Modal` panel sized for content. Kinds with a pane view (doc, agent, thread,
 * container, project) mount that same view; memory and thread summary show a
 * small inline summary.
 */
import {
  chipMd,
  containerRecordToTreeNode,
  findContainerInTree,
  firstNonEmptyLine,
  parseChipUrl,
} from './helpers';

/**
 * Convert a `Loaded` node into a `LibraryTreeChild` the Dashboard can
 * select. Returns null if the node has no equivalent in the library
 * tree's selection vocabulary.
 */
function loadedToTreeChild(node: Loaded): LibraryTreeChild | null {
  if (node.kind === 'page') {
    const d = node.data;
    return {
      kind: 'doc',
      id: d.id,
      containerId: d.containerId,
      title: d.title,
      content: d.content,
      sortOrder: d.sortOrder,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }
  if (node.kind === 'thread') {
    const t = node.data;
    // ThreadSummary doesn't carry sortOrder — it is inert for threads, so the
    // preview surface treats it as 0.
    return {
      kind: 'thread',
      id: t.id,
      projectId: t.projectId,
      title: t.title ?? null,
      sortOrder: (t as ThreadSummary & { sortOrder?: number }).sortOrder ?? 0,
      lastMessageAt: (t as ThreadSummary & { lastMessageAt?: string | null }).lastMessageAt ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
  if (node.kind === 'container') {
    // Already a ContainerTreeNode — strip the children so the dashboard
    // refetches its own subtree on open instead of trusting our snapshot.
    const c = node.data;
    return { ...c, children: [] };
  }
  if (node.kind === 'image') {
    const img = node.data;
    return {
      kind: 'image',
      id: img.id,
      containerId: img.containerId,
      name: img.name,
      description: img.description ?? null,
      tags: img.tags ?? [],
      mimeType: img.mimeType,
      sizeBytes: img.sizeBytes,
      sortOrder: img.sortOrder,
      url: img.url,
      createdAt: img.createdAt,
      updatedAt: img.updatedAt,
    };
  }
  // Memories, thread summaries, agents, tools and messages have no library
  // tree row, so there is nothing for `openInPane` to select.
  return null;
}

export const WikiLinkPreviewModal: FC<WikiLinkPreviewModalProps> = ({
  kind: initialKind,
  id: initialId,
  onClose,
  onChipClick,
  anchor: initialAnchor,
}) => {
  const nav = useDashboardNavigation();
  // Items opened from inside the preview (a doc icon in a previewed
  // container) replace its subject, so the modal follows the click instead of
  // closing. The trail lets Back return to where the click came from; it
  // starts over when the caller points the modal at something else.
  const [trail, setTrail] = useState<{ kind: WikiNodeKind; id: string }[]>([]);
  useEffect(() => setTrail([]), [initialKind, initialId]);
  const followed = trail[trail.length - 1];
  const kind = followed?.kind ?? initialKind;
  const id = followed?.id ?? initialId;
  // A line link's anchor belongs to the doc the modal first opened.
  const anchor = followed ? undefined : initialAnchor;
  const openInside = (nextKind: WikiNodeKind, nextId: string) =>
    setTrail((prev) => [...prev, { kind: nextKind, id: nextId }]);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | { status: 'loaded'; node: Loaded }
    | { status: 'unsupported' }
  >({ status: 'loading' });

  useEffect(() => {
    let canceled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        if (kind === 'page') {
          const data = await docsApi.get(id);
          if (!canceled) setState({ status: 'loaded', node: { kind: 'page', data } });
        } else if (kind === 'thread') {
          const thread = await threadsApi.get(id);
          if (!canceled) setState({ status: 'loaded', node: { kind: 'thread', data: thread } });
        } else if (kind === 'thread_summary') {
          const data = await threadsApi.getSummary(id);
          if (!canceled) setState({ status: 'loaded', node: { kind: 'thread_summary', data } });
        } else if (kind === 'message') {
          const data = await threadsApi.getMessage(id);
          if (!canceled) setState({ status: 'loaded', node: { kind: 'message', data } });
        } else if (kind === 'memory') {
          const data = await memoriesApi.getById(id);
          if (!canceled) setState({ status: 'loaded', node: { kind: 'memory', data } });
        } else if (kind === 'container' || kind === 'library_node' || kind === 'project') {
          // Try the global tree first so the embedded ContainerView gets
          // real children; fall back to the bare record (children: []) if
          // the row lives in a project-scoped tree we don't have id for.
          const [record, tree] = await Promise.all([
            containersApi.get(id),
            containersApi.listTree(null).catch(() => [] as LibraryTreeChild[]),
          ]);
          if (canceled) return;
          const found = findContainerInTree(tree, id);
          const node = found ?? containerRecordToTreeNode(record);
          setState({ status: 'loaded', node: { kind: 'container', data: node } });
        } else if (kind === 'agent') {
          const data = await agentsApi.get(id);
          if (!canceled) setState({ status: 'loaded', node: { kind: 'agent', data } });
        } else if (kind === 'tool') {
          const data = await toolsApi.get(id);
          if (!canceled) setState({ status: 'loaded', node: { kind: 'tool', data } });
        } else if (kind === 'image') {
          const data = await imagesApi.getMetadata(id);
          if (!canceled) setState({ status: 'loaded', node: { kind: 'image', data } });
        } else {
          if (!canceled) setState({ status: 'unsupported' });
        }
      } catch (err) {
        if (canceled) return;
        const msg = getErrorMessage(err, 'Failed to load node');
        setState({ status: 'error', error: msg });
      }
    })();
    return () => {
      canceled = true;
    };
  }, [kind, id]);

  const title = (() => {
    if (state.status !== 'loaded') return KIND_LABEL[kind];
    const e = state.node;
    if (e.kind === 'page') return e.data.title || 'Untitled doc';
    if (e.kind === 'thread') return e.data.title || 'Untitled thread';
    if (e.kind === 'container') return e.data.name || 'Untitled container';
    if (e.kind === 'agent') return e.data.name || 'Untitled agent';
    if (e.kind === 'tool') return e.data.name || e.data.id;
    if (e.kind === 'message') return firstNonEmptyLine(e.data.content) || 'Message';
    if (e.kind === 'memory')
      return e.data.key?.trim() || firstNonEmptyLine(e.data.content) || 'Memory';
    if (e.kind === 'thread_summary')
      return `Thread summary v${e.data.version}${e.data.isCurrent ? ' · current' : ''}`;
    if (e.kind === 'image') return e.data.name || e.data.mimeType || 'Image';
    return KIND_LABEL[kind];
  })();

  const bodyHostsMainView = KINDS_HOSTING_MAIN_VIEW.has(kind);

  return (
    <Modal onClose={onClose} unstyled className={styles.overlay} aria-label={`${title} preview`}>
      <PaneChromeBoundary>
        <div
          className={`${styles.panel} ${styles[`panelKind-${kind}`] ?? ''} ${bodyHostsMainView ? styles.panelWide : ''}`}
          data-testid="wiki-link-preview"
        >
          <header className={styles.header}>
            {trail.length > 0 && (
              <button
                type="button"
                className={styles.closeBtn}
                onClick={() => setTrail((prev) => prev.slice(0, -1))}
                aria-label="Back"
                title="Back"
                data-testid="wiki-link-preview-back"
              >
                ←
              </button>
            )}
            <span className={`${styles.icon} ${styles[`iconKind-${kind}`] ?? ''}`} aria-hidden>
              <KindIcon kind={kind} />
            </span>
            <h2 className={styles.title} title={title}>
              {title}
            </h2>
            <span className={styles.kindBadge}>{KIND_LABEL[kind]}</span>
            <CopyChipButton label="id" value={id} idleTitle="Copy ID" copiedTitle="ID copied!" />
            {nav && state.status === 'loaded' && loadedToTreeChild(state.node) !== null && (
              <button
                type="button"
                className={styles.openBtn}
                onClick={() => {
                  const node = loadedToTreeChild(state.node);
                  if (!node) return;
                  // A line link keeps its lines: the pane's DocView picks
                  // the request up and highlights them.
                  if (anchor && node.kind === 'doc') requestDocLineFocus(node.id, anchor);
                  nav.openInPane(node);
                  onClose();
                }}
                aria-label="Open in pane"
                title="Open in active pane"
                data-testid="wiki-link-preview-open"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                  aria-hidden
                >
                  <path d="M9 2H14V7" />
                  <path d="M14 2L7.5 8.5" />
                  <path d="M12 9V13H3V4H7" />
                </svg>
                <span>Open</span>
              </button>
            )}
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close preview"
              title="Close (Esc)"
            >
              ×
            </button>
          </header>

          <div
            className={`${styles.body} ${bodyHostsMainView ? styles.bodyView : ''}`}
            data-testid="wiki-link-preview-body"
            onClick={(e) => {
              // Chips can render as either <a class="md-chip" href="..."> (preview
              // markdown renderer) or <span class="md-chip" data-node-url="..."> (editor
              // ChipNodeView mount). Match both, and read the URL from whichever attr exists.
              const chip = (e.target as Element).closest?.('.md-chip');
              if (!chip) return;
              const url = chip.getAttribute('data-node-url') ?? chip.getAttribute('href') ?? '';
              const parsed = parseChipUrl(url);
              if (!parsed) return;
              e.preventDefault();
              e.stopPropagation();
              onChipClick?.(parsed.kind, parsed.id);
            }}
          >
            {state.status === 'loading' && <div className={styles.loading}>Loading…</div>}
            {state.status === 'error' && (
              <div className={styles.error}>
                <div className={styles.errorTitle}>Couldn&apos;t load preview</div>
                <div className={styles.errorMessage}>{state.error}</div>
              </div>
            )}
            {state.status === 'unsupported' && (
              <div className={styles.error}>
                <div className={styles.errorTitle}>Preview not supported</div>
                <div className={styles.errorMessage}>
                  <code className={styles.codeInline}>
                    {kind}:{id}
                  </code>{' '}
                  — open the node directly to view.
                </div>
              </div>
            )}
            {state.status === 'loaded' && (
              // The preview's own find: Cmd/Ctrl+F searches the previewed doc
              // or thread, not the pane behind the modal.
              <PaneFindProvider isActive inDialog>
                <LoadedBody
                  node={state.node}
                  onChipClick={onChipClick}
                  onOpenInside={openInside}
                  onClose={onClose}
                  anchor={anchor}
                />
              </PaneFindProvider>
            )}
          </div>
        </div>
      </PaneChromeBoundary>
    </Modal>
  );
};

/** Timestamp for preview metadata, e.g. "September 18, 2026 at 6:46 PM". */
function formatMetaTimestamp(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The memory preview's metadata line: `<agent> · from <thread> · <date>`,
 * with chips. Each separator stays with the part after it, so a wrapped line
 * never ends on a lone dot.
 */
const MemoryMetaLine: FC<{ memory: MemoryDetailRecord }> = ({ memory: m }) => {
  const parts: Array<{ key: string; node: ReactNode }> = [];
  if (m.agentId) {
    parts.push({
      key: 'agent',
      node: (
        <Chip
          kind="agent"
          nodeId={m.agentId}
          href={chipHrefForNode({ kind: 'agent', id: m.agentId })}
          title={m.agentName ?? 'Agent'}
          showIncludeToggle={false}
        />
      ),
    });
  }
  if (m.sourceThreadId) {
    parts.push({
      key: 'thread',
      node: (
        <>
          from
          <Chip
            kind="thread"
            nodeId={m.sourceThreadId}
            href={chipHrefForNode({ kind: 'thread', id: m.sourceThreadId })}
            title={m.sourceThreadTitle ?? 'Source thread'}
            showIncludeToggle={false}
          />
        </>
      ),
    });
  }
  parts.push({
    key: 'created',
    node: <time dateTime={m.createdAt}>{formatMetaTimestamp(m.createdAt)}</time>,
  });
  return (
    <div className={styles.metaLine} data-testid="memory-preview-meta">
      {parts.map((part, i) => (
        <span key={part.key} className={styles.metaLinePart}>
          {i > 0 && (
            <span className={styles.metaLineSeparator} aria-hidden>
              ·
            </span>
          )}
          {part.node}
        </span>
      ))}
    </div>
  );
};

/** The preview kind for a tree child opened inside an embedded ContainerView,
 *  or null if the modal can't preview it. */
function treeChildToChipKind(node: LibraryTreeChild): WikiNodeKind | null {
  if (node.kind === 'doc') return 'page';
  if (node.kind === 'thread') return 'thread';
  if (node.kind === 'container') return 'container';
  if (node.kind === 'image') return 'image';
  return null;
}

const LoadedBody: FC<{
  node: Loaded;
  onChipClick?: (kind: WikiNodeKind, id: string) => void;
  /** Show another item in this same modal. */
  onOpenInside: (kind: WikiNodeKind, id: string) => void;
  onClose: () => void;
  anchor?: DocAnchor;
}> = ({ node, anchor, onChipClick, onOpenInside, onClose }) => {
  const nav = useDashboardNavigation();
  if (node.kind === 'page') {
    const r = node.data;
    const treeNode: DocTreeNode = {
      kind: 'doc',
      id: r.id,
      containerId: r.containerId,
      title: r.title,
      content: r.content,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
    return <DocView node={treeNode} focusAnchor={anchor} />;
  }

  if (node.kind === 'agent') {
    return <AgentView agent={node.data} variant="preview" />;
  }

  if (node.kind === 'tool') {
    return <ToolView tool={node.data} />;
  }

  if (node.kind === 'thread') {
    return <ChatView threadId={node.data.id} threadTitle={node.data.title ?? null} />;
  }

  if (node.kind === 'message') {
    // Same shape openSearchHit uses for message search hits — ChatView
    // loads a window centered on the message, then holds it in view and
    // highlighted via its `focusMessageId` prop / useChatStream pagination.
    return (
      <ChatView threadId={node.data.threadId} threadTitle={null} focusMessageId={node.data.id} />
    );
  }

  if (node.kind === 'container') {
    // The same surface a pane shows: ContainerView owns every container,
    // including a project (category='project'), where it adds the project
    // details plus the Threads and Tables sections. A plain container lists
    // no threads — a thread is in a project or flat.
    return (
      <ContainerView
        container={node.data}
        onOpenNode={(child) => {
          const next = treeChildToChipKind(child);
          if (!next) return;
          // The caller's chained navigation wins when wired; otherwise
          // the modal itself switches to the clicked child.
          if (onChipClick) onChipClick(next, child.id);
          else onOpenInside(next, child.id);
        }}
        // Tables have no preview of their own: open the pane behind the
        // modal and close.
        onOpenTable={(table) => {
          nav?.openTable?.(table.id);
          onClose();
        }}
      />
    );
  }

  if (node.kind === 'image') {
    const img = node.data;
    // The same pan/zoom viewer as the ImageView pane, filling the fixed-size
    // body: zooming moves the image inside it, never the modal frame.
    return (
      <ImageViewer
        imageId={img.id}
        alt={img.name || 'Image'}
        className={styles.imageCanvas}
        imageClassName={styles.imageContent}
        fitPadding={24}
        autoFocus
      />
    );
  }

  if (node.kind === 'memory') {
    const m = node.data;
    return (
      <div className={styles.postBody}>
        <MemoryMetaLine memory={m} />
        <div className={styles.postContent}>
          <MarkdownToggleView content={m.content} />
        </div>
      </div>
    );
  }

  // thread_summary — each related node (thread, agent, last message)
  // gets its own meta row with a chip pill as the value, so the panel
  // visually parallels the simpler text rows. `first_message_id` isn't
  // stored on the row (only `last_message_id`), so first-message chip is
  // skipped.
  const s = node.data;
  return (
    <div className={styles.postBody}>
      <div className={styles.taskMetaGrid}>
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Version</span>
          <span className={styles.metaValue}>
            v{s.version}
            {s.isCurrent ? ' · current' : ''}
          </span>
        </div>
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Thread</span>
          <span className={`${styles.metaValue} ${styles.metaValueChip}`}>
            <MarkdownRenderer content={chipMd('Thread', 'thread', s.threadId)} />
          </span>
        </div>
        {s.agentId ? (
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>Agent</span>
            <span className={`${styles.metaValue} ${styles.metaValueChip}`}>
              <MarkdownRenderer content={chipMd('Agent', 'agent', s.agentId)} />
            </span>
          </div>
        ) : null}
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Created</span>
          <span className={styles.metaValue}>{formatMetaTimestamp(s.createdAt)}</span>
        </div>
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Turns in this compaction</span>
          <span className={styles.metaValue}>{s.messagesInWindow}</span>
        </div>
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Total covered (lifetime)</span>
          <span className={styles.metaValue}>{s.messagesCovered}</span>
        </div>
        {s.lastMessageId ? (
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>Last message</span>
            <span className={`${styles.metaValue} ${styles.metaValueChip}`}>
              <MarkdownRenderer content={chipMd('Last message', 'message', s.lastMessageId)} />
            </span>
          </div>
        ) : null}
      </div>
      <div className={styles.postContent}>
        <MarkdownToggleView content={s.summaryText} />
      </div>
    </div>
  );
};
