import {
  useEffect,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { TransclusionBlock } from '@desktop/features/rich-markdown/renderer';
import {
  INCLUDABLE_KINDS,
  chipTitleWithoutRange,
  parseFilePathChipHref,
  parseFolderPathChipHref,
  parseNodeRef,
} from '@desktop/features/rich-markdown/renderer/nodeRef';
import { docAnchorLabel, lineRefLabel } from '@snaglet/shared/utils';
import { useChipCopy } from '@desktop/features/rich-markdown/renderer/useChipCopy';
import {
  TRANSCLUDE_TIP,
  useTransclusionGuard,
} from '@desktop/features/rich-markdown/renderer/transclusions';
import { useHostDocId } from '@desktop/features/rich-markdown/lineLinks/hostDoc';
import { requestInDocFocus } from '@desktop/features/rich-markdown/lineLinks/lineFocusStore';
import { nodeToChipMarkdown, parseEntryChipId } from '@desktop/utils/nodeChip';
import {
  UNAVAILABLE_ENTRY_LABEL,
  untitledEntryLabel,
  useLiveEntryName,
} from '@desktop/features/table-entries/entryNameCache';
import {
  WikiLinkPreviewModal,
  type WikiNodeKind,
} from '@desktop/features/rich-markdown/preview/WikiLinkPreviewModal';
import { FilePreviewModal, FolderPreviewModal } from '@desktop/components/FilePreview';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import {
  UNAVAILABLE_TABLE_LABEL,
  useLiveTableName,
} from '@desktop/features/database/tableNameCache';
import { AuthenticatedImageContent } from '@desktop/components/AuthenticatedImageContent';
import styles from './ChipNodeView.module.scss';

/** Map a chip `kind` to the preview modal's `WikiNodeKind`, where a doc is
 *  `page`. Returns null for kinds the modal can't render. */
function toWikiKind(kind: string): WikiNodeKind | null {
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
 * Whether the editor's selection is this chip as a node (arrowed onto, or
 * clicked). Read from the selection itself on each change: TipTap's own
 * `selected` prop (and the `ProseMirror-selectednode` class) can drop a
 * chip's live selection when its cached position goes stale.
 */
function useChipNodeSelected(
  editor: NodeViewProps['editor'],
  getPos: NodeViewProps['getPos']
): boolean {
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    const check = () => {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      const { selection } = editor.state;
      setSelected(
        typeof pos === 'number' && selection instanceof NodeSelection && selection.from === pos
      );
    };
    editor.on('selectionUpdate', check);
    return () => {
      editor.off('selectionUpdate', check);
    };
  }, [editor, getPos]);
  return selected;
}

/**
 * React NodeView for the chip node. A link chip renders as a pill (global
 * `.md-chip` styles); an include chip renders `TransclusionBlock` so the user
 * sees the content that gets inlined. Expanding a mid-paragraph chip splits the
 * paragraph so the block sits on its own line.
 */
export const ChipNodeView: FC<NodeViewProps> = ({
  node,
  updateAttributes,
  deleteNode,
  editor,
  getPos,
  extension,
}) => {
  const href = String(node.attrs.href ?? '');
  const kind = String(node.attrs.kind ?? 'doc');
  const title = String(node.attrs.title ?? '');
  const include = node.attrs.include === true;
  const showToggle =
    (extension.options as { showIncludeToggle?: boolean }).showIncludeToggle === true &&
    INCLUDABLE_KINDS.has(kind);
  const isIncludable = INCLUDABLE_KINDS.has(kind);
  // A read-only editor (a disabled field, a version preview) still shows
  // its chips, but nothing on them may change the document. Handlers check
  // the live flag too, since toggling editable need not re-render the view.
  const readOnly = !editor.isEditable;
  const removeChip = () => {
    if (editor.isEditable) deleteNode();
  };
  // Editing the label changes this chip's own link text, never the name of
  // the item it points to. `null` while not editing.
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const commitLabel = () => {
    const next = labelDraft?.trim() ?? '';
    setLabelDraft(null);
    if (next && editor.isEditable && next !== title) updateAttributes({ title: next });
  };

  // Clicking the chip opens the preview modal, as in `MarkdownRenderer`'s
  // `Chip`.
  const [showPreview, setShowPreview] = useState(false);
  const wikiKind = toWikiKind(kind);
  // file/folder chips carry a path, not a workspace id — decode it for the
  // path-based preview modals (null for any other kind).
  const chipPath =
    kind === 'file'
      ? parseFilePathChipHref(href)
      : kind === 'folder'
        ? parseFolderPathChipHref(href)
        : null;
  const { copied, copy } = useChipCopy();
  const nodeSelected = useChipNodeSelected(editor, getPos);
  // The modal takes `parseNodeRef`'s id: `doc-abc-123` stays as-is,
  // `page:uuid` becomes `uuid`.
  const parsedRef = parseNodeRef(href);
  const previewId = parsedRef?.id ?? href;
  const anchor = parsedRef?.anchor;
  const nav = useDashboardNavigation();
  const hostDocId = useHostDocId();
  const allowTransclusion = useTransclusionGuard();
  // Table chips show the catalog's current name rather than the title frozen
  // at insert, and an honest unavailable state once the table is gone (an
  // archived table keeps its name). The node's `title` attr is left alone so
  // rendering never rewrites the doc.
  const isTable = kind === 'table';
  const liveTable = useLiveTableName(isTable ? previewId : null);
  const tableUnavailable = isTable && liveTable.unavailable;
  const entry = kind === 'entry' ? parseEntryChipId(previewId) : null;
  const liveEntry = useLiveEntryName(entry ? previewId : null);
  const unavailable = tableUnavailable || liveEntry.unavailable;
  const entryName = liveEntry.name ?? title;
  const displayTitle = entry
    ? liveEntry.unavailable
      ? UNAVAILABLE_ENTRY_LABEL
      : entryName.trim() || untitledEntryLabel(liveEntry.position)
    : isTable
      ? tableUnavailable
        ? UNAVAILABLE_TABLE_LABEL
        : (liveTable.name ?? (title || 'Table'))
      : chipTitleWithoutRange(title, anchor) || kind;

  // Table and entry chips always show the live name, so a label would never
  // be seen: only the other kinds can be relabeled.
  const canEditLabel = !readOnly && !isTable && !entry && labelDraft === null;

  /**
   * Turn the chip into a transclusion, first splitting its paragraph around
   * it if it shares the line with other content. One that would loop back to
   * this doc is refused with a notice, and the doc is left as it was.
   */
  const expandToInclude = async () => {
    if (!isIncludable || !editor.isEditable) return;
    if (!(await allowTransclusion(href)) || !editor.isEditable) return;
    const pos = typeof getPos === 'function' ? getPos() : null;
    if (typeof pos !== 'number') {
      updateAttributes({ include: true });
      return;
    }
    editor
      .chain()
      .command(({ tr, state }) => {
        const $pos = state.doc.resolve(pos);
        const para = $pos.parent;
        if (para.type.name !== 'paragraph') {
          tr.setNodeAttribute(pos, 'include', true);
          return true;
        }
        const offsetInParent = $pos.parentOffset;
        const paraSize = para.content.size;
        const hasBefore = offsetInParent > 0;
        const hasAfter = offsetInParent + node.nodeSize < paraSize;

        // Split after the chip first so `pos` stays valid; the split before
        // it then shifts the chip forward by 2 (the new paragraph boundary).
        if (hasAfter) tr.split(pos + node.nodeSize);
        let chipPos = pos;
        if (hasBefore) {
          tr.split(pos);
          chipPos = pos + 2;
        }
        tr.setNodeAttribute(chipPos, 'include', true);
        return true;
      })
      .run();
  };

  const collapseToLink = (liveTitle: string | null) => {
    if (!editor.isEditable) return;
    updateAttributes({ include: false, title: liveTitle || title || kind });
  };

  // Every chip form is a drag source. `data-drag-handle` tells TipTap a press
  // anywhere on the chip may begin a drag; the chip node's dragstart handler
  // (ChipNode) then writes the chip payload for every chip-aware drop target.
  // Nothing here may preventDefault a mousedown: that cancels the native drag.
  if (include && isIncludable) {
    // A `span`, since a `<div>` can't sit inside the paragraph's `<p>`; CSS
    // makes it `display: block`.
    return (
      <NodeViewWrapper
        as="span"
        className={styles.includeWrap}
        contentEditable={false}
        data-include-host="chip"
        data-node-kind={kind}
        data-node-id={previewId}
        data-node-url={href}
        data-drag-handle=""
      >
        <TransclusionBlock
          href={href}
          title={title}
          onToggleToLink={readOnly ? undefined : collapseToLink}
          onRemove={readOnly ? undefined : removeChip}
        />
      </NodeViewWrapper>
    );
  }

  // Link form: a pill. It leaves `contentEditable` unset: TipTap already
  // sets it on atoms, and setting it again can leave no caret position
  // between two adjacent chips.
  // Image chips render as a card with the image preview. Display only:
  // serialization and drag payloads are unchanged.
  if (kind === 'image') {
    const openPreview = (e: ReactMouseEvent<HTMLElement>) => {
      const target = e.target as Element | null;
      if (target?.closest?.('.md-chip-remove')) return;
      if (target?.closest?.('.md-chip-copy')) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      setShowPreview(true);
    };
    return (
      <>
        <NodeViewWrapper
          as="span"
          className={styles.imageCard}
          data-node-kind={kind}
          data-node-url={href}
          data-chip-include="false"
          role="button"
          tabIndex={0}
          title={title || 'Open image preview'}
          data-drag-handle=""
          onClick={openPreview}
          onKeyDown={(e: ReactKeyboardEvent<HTMLElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setShowPreview(true);
            }
          }}
        >
          <AuthenticatedImageContent
            imageId={previewId}
            alt={title || 'image'}
            className={styles.imageCardImg}
          />
          <span className={styles.imageCardBar}>
            <span className={styles.imageCardTitle}>{title || 'Image'}</span>
            <span
              className={`md-chip-copy ${styles.imageCardAction}`}
              role="button"
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void copy(href);
              }}
              aria-label={copied ? 'Copied' : 'Copy link'}
              title={copied ? 'Copied!' : 'Copy reference'}
              data-copied={copied ? 'true' : undefined}
            >
              {copied ? '✓' : '⧉'}
            </span>
            {!readOnly && (
              <span
                className={`md-chip-remove ${styles.imageCardAction}`}
                role="button"
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeChip();
                }}
                aria-label="Remove image"
                title="Remove image"
              >
                ✕
              </span>
            )}
          </span>
        </NodeViewWrapper>
        {showPreview && (
          <WikiLinkPreviewModal kind="image" id={previewId} onClose={() => setShowPreview(false)} />
        )}
      </>
    );
  }

  const className = unavailable
    ? `md-chip md-chip-${kind} md-chip-unavailable`
    : `md-chip md-chip-${kind}`;
  return (
    <>
      <NodeViewWrapper
        as="span"
        className={className}
        data-node-kind={kind}
        data-node-id={previewId}
        data-node-url={href}
        data-chip-include="false"
        // Selected as a node (arrow keys onto it, or a click): shows its
        // action bar, so the keyboard reaches the same controls as hover.
        data-chip-selected={nodeSelected ? 'true' : undefined}
        role={entry ? 'link' : undefined}
        tabIndex={entry ? 0 : undefined}
        aria-disabled={unavailable ? true : undefined}
        title={
          unavailable
            ? `This ${entry ? 'entry' : 'table'} no longer exists`
            : isTable && liveTable.archived
              ? 'This table is archived'
              : undefined
        }
        draggable={!unavailable && labelDraft === null}
        data-drag-handle=""
        onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
          if (entry && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (!unavailable) nav?.openTableEntry?.(entry.tableId, entry.entryId);
          }
        }}
        // A click on the chip body (not its buttons) opens the preview.
        // ProseMirror selects the chip atom on the press, which is harmless;
        // the press itself is left alone so a drag can begin from it.
        onClick={(e: ReactMouseEvent<HTMLSpanElement>) => {
          const target = e.target as Element | null;
          if (target?.closest?.('.md-chip-toggle')) return;
          if (target?.closest?.('.md-chip-rename, .md-chip-label-input')) return;
          if (target?.closest?.('.md-chip-copy')) return;
          if (target?.closest?.('.md-chip-remove')) return;
          if (e.shiftKey || e.metaKey || e.ctrlKey) return;
          if (entry) {
            e.preventDefault();
            e.stopPropagation();
            if (!unavailable) nav?.openTableEntry?.(entry.tableId, entry.entryId);
            return;
          }
          // Table chips open the table pane; an unavailable table opens nothing.
          if (isTable) {
            if (tableUnavailable || !nav?.openTable) return;
            e.preventDefault();
            e.stopPropagation();
            nav.openTable(previewId);
            return;
          }
          // An anchored chip into the doc being edited scrolls there in place;
          // the doc's own view applies the request.
          if (kind === 'doc' && anchor && previewId === hostDocId) {
            e.preventDefault();
            e.stopPropagation();
            requestInDocFocus(hostDocId, anchor);
            return;
          }
          // file/folder chips open a path-based modal; other kinds need a
          // wiki-renderable kind. Bail if neither applies.
          if (kind !== 'file' && kind !== 'folder' && !wikiKind) return;
          e.preventDefault();
          e.stopPropagation();
          setShowPreview(true);
        }}
      >
        {labelDraft === null ? (
          <span className="md-chip-title">{displayTitle}</span>
        ) : (
          <input
            className="md-chip-label-input"
            aria-label="Chip label"
            value={labelDraft}
            size={Math.max(4, labelDraft.length)}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commitLabel();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setLabelDraft(null);
              }
            }}
          />
        )}
        {anchor && <span className="md-chip-lines">{docAnchorLabel(anchor, lineRefLabel)}</span>}
        {/* Shown while the chip is hovered, focused or selected (global
            `.md-chip-actions` styles), floating over the line so the chip
            never changes width. */}
        <span className="md-chip-actions">
          {showToggle && !readOnly && (
            <span
              className="md-chip-toggle md-chip-toggle-compact"
              role="button"
              tabIndex={-1}
              onMouseDown={(e) => {
                // mousedown beats the editor's default focus handler so the
                // expand happens before the chip becomes a selection.
                e.preventDefault();
                e.stopPropagation();
                void expandToInclude();
              }}
              title={TRANSCLUDE_TIP}
              aria-label="Transclude a doc"
              data-toggle-direction="include"
            >
              ↳
            </span>
          )}
          {canEditLabel && (
            <span
              className="md-chip-rename"
              role="button"
              tabIndex={-1}
              onMouseDown={(e) => {
                // On mousedown, before TipTap selects the chip.
                e.preventDefault();
                e.stopPropagation();
                setLabelDraft(displayTitle);
              }}
              aria-label="Edit label"
              title="Edit this chip's label (the item keeps its name)"
            >
              ✎
            </span>
          )}
          <span
            className="md-chip-copy md-chip-copy-compact"
            role="button"
            tabIndex={-1}
            onMouseDown={(e) => {
              // On mousedown, before TipTap selects the chip; otherwise the
              // copy silently does nothing.
              e.preventDefault();
              e.stopPropagation();
              void copy(
                entry
                  ? nodeToChipMarkdown({ kind: 'entry', id: previewId, title: entryName })
                  : href
              );
            }}
            aria-label={copied ? 'Copied' : 'Copy link'}
            title={copied ? 'Copied!' : 'Copy reference'}
            data-copied={copied ? 'true' : undefined}
          >
            {copied ? '✓' : '⧉'}
          </span>
          {!readOnly && (
            <span
              className="md-chip-remove md-chip-remove-compact"
              role="button"
              tabIndex={-1}
              onMouseDown={(e) => {
                // On mousedown, before TipTap selects the chip; otherwise
                // deleteNode can do nothing.
                e.preventDefault();
                e.stopPropagation();
                removeChip();
              }}
              aria-label="Remove link"
              title="Remove link"
            >
              ✕
            </span>
          )}
        </span>
      </NodeViewWrapper>
      {showPreview && kind === 'file' && chipPath && (
        <FilePreviewModal path={chipPath} onClose={() => setShowPreview(false)} />
      )}
      {showPreview && kind === 'folder' && chipPath && (
        <FolderPreviewModal path={chipPath} onClose={() => setShowPreview(false)} />
      )}
      {showPreview && kind !== 'file' && kind !== 'folder' && wikiKind && (
        <WikiLinkPreviewModal
          kind={wikiKind}
          id={previewId}
          anchor={anchor}
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
  );
};
