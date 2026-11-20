import {
  useState,
  type DragEvent as ReactDragEvent,
  type FC,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  WikiLinkPreviewModal,
  type WikiNodeKind,
} from '@desktop/features/rich-markdown/preview/WikiLinkPreviewModal';
import { FilePreviewModal, FolderPreviewModal } from '@desktop/components/FilePreview';
import {
  setChipDragPayload,
  fallbackTitleForKind,
  isChipKind,
  isRetiredKind,
  nodeToChipMarkdown,
  parseEntryChipId,
} from '@desktop/utils/nodeChip';
import {
  UNAVAILABLE_ENTRY_LABEL,
  untitledEntryLabel,
  useLiveEntryName,
} from '@desktop/features/table-entries/entryNameCache';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import {
  UNAVAILABLE_TABLE_LABEL,
  useLiveTableName,
} from '@desktop/features/database/tableNameCache';
import { INCLUDABLE_KINDS, chipTitleWithoutRange } from './nodeRef';
import { TRANSCLUDE_TIP } from './transclusions';
import { useHostDocId } from '../lineLinks/hostDoc';
import { requestInDocFocus } from '../lineLinks/lineFocusStore';
import { docAnchorLabel, lineRefLabel, type DocAnchor } from '@snaglet/shared/utils';
import { useChipCopy } from './useChipCopy';
import { useWorkspaceAncestors } from './useWorkspaceAncestors';

interface ChipProps {
  /** Lowercased node kind ('doc', 'thread', 'task', etc.). */
  kind: string;
  /** Bare node id (scheme/prefix stripped if applicable). */
  nodeId: string;
  /** The href exactly as written in the source. */
  href: string;
  /** Display title (the text between `[` and `]` in markdown). */
  title: ReactNode;
  /** Partial-doc link: the lines or heading section this chip points at. */
  anchor?: DocAnchor;
  /** True when the source used the `![]()` form. Only meaningful for
   *  doc/page kinds; ignored otherwise. */
  include?: boolean;
  /** Render the link/include toggle, for a host that owns the markdown.
   *  Default false: read-only surfaces (chat messages, previews) show none. */
  showIncludeToggle?: boolean;
  /** Called from the chip's "×" button to strip it from the source. The
   *  button shows only when this is set. */
  onRemove?: (href: string) => void;
  interactive?: boolean;
  draggable?: boolean;
  knownEntryName?: string;
  /**
   * For a reference whose state the caller knows (a table relation to a Snaglet
   * item): `archived` is muted and not draggable but still opens;
   * `unavailable` (purged) is muted and inert. Both explain themselves in a
   * tooltip naming `itemNoun` ("doc", "agent", …).
   */
  availability?: 'archived' | 'unavailable';
  itemNoun?: string;
}

/**
 * Map a chip `kind` to the preview modal's `WikiNodeKind`. Returns null for
 * kinds the modal can't render.
 */
function toWikiKind(kind: string): WikiNodeKind | null {
  // Workspace nodes use `doc`; markdown links and the preview modal use the
  // `page` scheme.
  if (kind === 'doc') return 'page';
  const allowed: WikiNodeKind[] = [
    'page',
    'container',
    'library_node',
    'thread',
    'thread_summary',
    'message',
    'memory',
    'agent',
    'project',
    'tool',
    'image',
  ];
  return (allowed as string[]).includes(kind) ? (kind as WikiNodeKind) : null;
}

/**
 * Node-reference chip: an `<a class="md-chip md-chip-{kind}">` with title,
 * ancestor path and optional include toggle, copy and remove buttons. A click
 * opens the node's preview in place; the `<a>` never navigates. Toggle clicks
 * and shift-clicks bubble to the host surface, which owns the markdown.
 */
export const Chip: FC<ChipProps> = ({
  kind,
  nodeId,
  href,
  title,
  anchor,
  include = false,
  showIncludeToggle = false,
  onRemove,
  interactive = true,
  draggable = true,
  knownEntryName,
  availability,
  itemNoun = 'item',
}) => {
  const includable = INCLUDABLE_KINDS.has(kind);
  const isInclude = include && includable;
  const renderToggle = includable && showIncludeToggle;
  // Model ids and table catalog ids are not workspace node ids.
  const isTable = kind === 'table';
  const entry = kind === 'entry' ? parseEntryChipId(nodeId) : null;
  const liveEntry = useLiveEntryName(entry ? nodeId : null, knownEntryName);
  const ancestors = useWorkspaceAncestors(kind === 'model' || isTable || entry ? null : nodeId);
  const path = ancestors && ancestors.length > 0 ? ancestors.join(' / ') : '';
  const [showPreview, setShowPreview] = useState(false);
  const { copied, copy } = useChipCopy();
  const nav = useDashboardNavigation();
  const hostDocId = useHostDocId();
  // Table chips show the catalog's current name, not the title frozen into
  // the markdown, and an honest unavailable state once the table is gone.
  // An archived table keeps its name and opens its (archived) pane.
  const liveTable = useLiveTableName(isTable ? nodeId : null);
  const tableUnavailable = isTable && liveTable.unavailable;
  // A retired kind (`sketch-…`, `post-…`) has no row to open: it keeps its
  // label and renders as unavailable.
  const retired = isRetiredKind(kind);
  const itemUnavailable = availability === 'unavailable' || retired;
  const itemArchived = availability === 'archived';
  const unavailable = tableUnavailable || liveEntry.unavailable || itemUnavailable;
  const entryName = liveEntry.name ?? (typeof title === 'string' ? title : '');
  // A chip written with no label (`![](sketch-…)`, `[](doc-…)`) shows the
  // kind's default title instead of an empty pill.
  const titleIsBlank = title == null || (typeof title === 'string' && title.trim() === '');
  // The link label as written, so a copied chip pastes back with it whole
  // (the shown title may drop a trailing range, see chipTitleWithoutRange).
  const labelTitle = typeof title === 'string' && !titleIsBlank ? title : undefined;
  const titleOrDefault: ReactNode =
    titleIsBlank && isChipKind(kind)
      ? fallbackTitleForKind(kind)
      : typeof title === 'string'
        ? chipTitleWithoutRange(title, anchor)
        : title;
  const displayTitle: ReactNode = entry
    ? liveEntry.unavailable
      ? UNAVAILABLE_ENTRY_LABEL
      : entryName.trim() || untitledEntryLabel(liveEntry.position)
    : isTable
      ? tableUnavailable
        ? UNAVAILABLE_TABLE_LABEL
        : (liveTable.name ?? (title || 'Table'))
      : titleOrDefault;

  const baseClasses = isInclude
    ? `md-chip md-chip-${kind} md-chip-include`
    : `md-chip md-chip-${kind}`;
  const classes = unavailable
    ? `${baseClasses} md-chip-unavailable`
    : itemArchived
      ? `${baseClasses} md-chip-archived`
      : baseClasses;
  const stateTitle = itemUnavailable
    ? `This ${retired ? kind : itemNoun} no longer exists`
    : itemArchived
      ? `This ${itemNoun} is archived`
      : unavailable
        ? `This ${entry ? 'entry' : 'table'} no longer exists`
        : isTable && liveTable.archived
          ? 'This table is archived'
          : undefined;
  const canDrag = draggable && !unavailable && !itemArchived;

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Chip hrefs (`doc-…`, `page:uuid`) aren't real URLs; never navigate.
    e.preventDefault();
    // Remove button. Stop propagation so the host's toggle handler doesn't
    // also fire.
    if ((e.target as Element).closest?.('.md-chip-remove')) {
      e.stopPropagation();
      if (onRemove) onRemove(href);
      return;
    }
    // Copy button: copies the reference in its link or include form, so a
    // paste recreates the same chip.
    if ((e.target as Element).closest?.('.md-chip-copy')) {
      e.stopPropagation();
      void copy(
        entry
          ? nodeToChipMarkdown({ kind: 'entry', id: nodeId, title: entryName })
          : `${isInclude ? '!' : ''}${href}`
      );
      return;
    }
    // Toggle clicks and shift-clicks bubble to the surface that owns the
    // markdown.
    if ((e.target as Element).closest?.('.md-chip-toggle')) return;
    if (e.shiftKey) return;
    // Plain click opens the preview; stop propagation so the host doesn't
    // open a second one.
    e.stopPropagation();
    // A purged item has nothing to open.
    if (itemUnavailable) return;
    if (entry) {
      if (!unavailable) nav?.openTableEntry?.(entry.tableId, entry.entryId);
      return;
    }
    // Table chips open the table pane; a deleted table opens nothing.
    if (isTable) {
      if (!tableUnavailable) nav?.openTable?.(nodeId);
      return;
    }
    // An anchored chip into the doc being read scrolls there in place; the
    // doc's own view applies the request.
    if (kind === 'doc' && anchor && nodeId === hostDocId) {
      requestInDocFocus(hostDocId, anchor);
      return;
    }
    // File and folder chips hold an absolute path, not a node id, so they
    // open the path-based File/FolderPreviewModal instead of the wiki modal.
    if (kind === 'file' || kind === 'folder') {
      setShowPreview(true);
      return;
    }
    const wikiKind = toWikiKind(kind);
    if (!wikiKind) return;
    setShowPreview(true);
  };

  const wikiKind = toWikiKind(kind);

  if (!interactive) {
    return (
      <span
        className={classes}
        data-node-kind={kind}
        data-node-id={nodeId}
        data-node-url={href}
        data-chip-title={labelTitle}
        title={stateTitle}
      >
        <span className="md-chip-title">{displayTitle}</span>
        {anchor && <span className="md-chip-lines">{docAnchorLabel(anchor, lineRefLabel)}</span>}
      </span>
    );
  }

  return (
    <>
      <a
        href={href}
        className={classes}
        data-node-kind={kind}
        data-node-id={nodeId}
        data-node-url={href}
        data-chip-title={labelTitle}
        data-transclusion={isInclude ? 'true' : undefined}
        aria-disabled={unavailable ? true : undefined}
        title={stateTitle}
        onClick={onClick}
        draggable={canDrag}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e: ReactDragEvent<HTMLAnchorElement>) => {
          // Every rendered chip is a drag source for chip-aware editors and
          // pane drop zones. `setChipDragPayload` writes NODE_CHIP_MIME, a
          // text/plain fallback and a pill drag image.
          if (!canDrag || !isChipKind(kind)) return;
          e.stopPropagation();
          const dragTitle = entry
            ? entryName
            : isTable
              ? (liveTable.name ?? (typeof title === 'string' ? title : null))
              : typeof title === 'string'
                ? title
                : null;
          setChipDragPayload(e, {
            chip: { id: nodeId, kind, title: dragTitle },
            dragLabel: `${kind}: ${dragTitle ?? nodeId}`,
          });
        }}
      >
        {isInclude && (
          <span className="md-chip-include-mark" aria-hidden>
            ↳
          </span>
        )}
        <span className="md-chip-title">{displayTitle}</span>
        {anchor && <span className="md-chip-lines">{docAnchorLabel(anchor, lineRefLabel)}</span>}
        {/* Ancestor path; hidden via :empty when none resolved. */}
        <span className="md-chip-path" aria-hidden>
          {path}
        </span>
        {/* Shown while the chip is hovered or focused (global
            `.md-chip-actions` styles), floating over the line so the chip
            never changes width. */}
        <span className="md-chip-actions">
          {renderToggle && (
            <span
              className="md-chip-toggle"
              role="button"
              tabIndex={-1}
              data-toggle-direction={isInclude ? 'link' : 'include'}
              title={isInclude ? 'Turn this transclusion back into a link' : TRANSCLUDE_TIP}
            >
              {isInclude ? 'Show as link' : 'Transclude'}
            </span>
          )}
          <span
            className="md-chip-copy"
            role="button"
            tabIndex={-1}
            aria-label={copied ? 'Copied' : 'Copy link'}
            title={copied ? 'Copied!' : 'Copy reference'}
            data-copied={copied ? 'true' : undefined}
          >
            {copied ? '✓' : '⧉'}
          </span>
          {onRemove && (
            <span
              className="md-chip-remove"
              role="button"
              tabIndex={-1}
              aria-label="Remove link"
              title="Remove this link from the text"
            >
              ×
            </span>
          )}
        </span>
      </a>
      {showPreview && kind === 'file' && (
        <FilePreviewModal path={nodeId} onClose={() => setShowPreview(false)} />
      )}
      {showPreview && kind === 'folder' && (
        <FolderPreviewModal path={nodeId} onClose={() => setShowPreview(false)} />
      )}
      {showPreview && kind !== 'file' && kind !== 'folder' && wikiKind && (
        <WikiLinkPreviewModal
          kind={wikiKind}
          id={nodeId}
          anchor={anchor}
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
  );
};
