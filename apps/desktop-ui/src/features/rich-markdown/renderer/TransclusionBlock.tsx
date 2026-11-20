import { useEffect, useState, type DragEvent as ReactDragEvent, type FC } from 'react';
import { docsApi } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { setChipDragPayload } from '@desktop/utils/nodeChip';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useChipCopy } from './useChipCopy';
import { TransclusionChainProvider, useTransclusionChain } from './transclusions';
import styles from './TransclusionBlock.module.scss';
import {
  docAnchorLabel,
  getErrorMessage,
  lineRefLabel,
  sliceDocAnchor,
  splitDocRef,
} from '@snaglet/shared/utils';

/** How many levels of nested transclusions render before falling back to chips. */
export const MAX_TRANSCLUSION_DEPTH = 3;

interface TransclusionBlockProps {
  /** Original chip URL, e.g. `page:<uuid>` or `doc-<id>`. */
  href: string;
  /** The chip's own title (`![Title](href)`), often empty. The live doc
   *  title wins once fetched. */
  title: string;
  /** Collapse back to a link. Receives the live doc title for the new
   *  `[Title](href)`, or null if it hasn't loaded yet. */
  onToggleToLink?: (liveTitle: string | null) => void;
  /** Called from the "×" button to delete the chip; hidden when unset. */
  onRemove?: () => void;
  /** Nesting depth. At MAX_TRANSCLUSION_DEPTH, nested transclusions render as chips. */
  depth?: number;
}

/**
 * A transclusion: a small header (title, show-as-link, copy, remove) above the
 * transcluded doc's content. Each block fetches its doc on mount, with no
 * shared cache. A doc already shown above it (a loop in stored content) gets
 * a short notice instead, and is never fetched or expanded.
 */
export const TransclusionBlock: FC<TransclusionBlockProps> = ({
  href,
  title,
  onToggleToLink,
  onRemove,
  depth = 0,
}) => {
  // `![](doc-…#L12-L20)` / `![](doc-…#h=slug)` transclude only that part of the doc.
  const { id: bareHref, anchor } = splitDocRef(href);
  const [anchorNote, setAnchorNote] = useState<string | null>(null);
  const docId = parseHrefForDocId(bareHref);
  const chain = useTransclusionChain();
  const loops = docId !== null && chain.includes(docId);
  const [content, setContent] = useState<string | null>(null);
  const [docTitle, setDocTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useChipCopy();

  useEffect(() => {
    if (!docId) {
      setError('Unrecognized transclusion reference');
      return;
    }
    if (loops) return;
    let canceled = false;
    const show = (body: string) => {
      if (anchor) {
        const part = sliceDocAnchor(body, anchor);
        setContent(part.text ?? '');
        setAnchorNote(part.note ?? null);
      } else {
        setContent(body);
      }
    };
    setContent(null);
    setDocTitle(null);
    setError(null);
    docsApi
      .get(docId)
      .then((doc) => {
        if (canceled) return;
        show(doc.content ?? '');
        setDocTitle(doc.title);
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load doc'));
      });
    // A save of the transcluded doc (an agent's edit routed to it, or the
    // person editing it in another pane) shows here without a reload.
    const stop = onLibraryEvent((event) => {
      if (!canceled && event.type === 'doc-saved' && event.id === docId) show(event.content);
    });
    return () => {
      canceled = true;
      stop();
    };
    // `anchor` is derived from href, so href covers it.
  }, [docId, href, loops]);

  // Live title, else the chip's own title, else a placeholder while loading.
  const headerTitle = docTitle ?? (title.length > 0 ? title : 'Untitled doc');

  /**
   * Drag-out with the same payload as a chip drag. Only the header drags, so
   * text in the body stays selectable.
   */
  const handleHeaderDragStart = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!docId) return;
    setChipDragPayload(e, {
      chip: { id: docId, kind: 'doc', title: headerTitle },
      dragLabel: `doc: ${headerTitle}`,
    });
  };

  return (
    <div className={styles.block} data-transclusion-href={href}>
      <div
        className={styles.header}
        data-transclusion-part="header"
        draggable
        onDragStart={handleHeaderDragStart}
      >
        <span className={styles.indicator} aria-hidden>
          ↳
        </span>
        <span className={styles.title} title={headerTitle}>
          {headerTitle}
        </span>
        {anchor && (
          <span
            className={styles.lines}
            data-transclusion-part="anchor"
            title={anchorNote ?? undefined}
          >
            {docAnchorLabel(anchor, lineRefLabel)}
            {anchorNote ? ' ⚠' : ''}
          </span>
        )}
        {/* A host can quiet these until the header is hovered or focused
            (the agent Behavior fields do, via the data attributes). */}
        <span className={styles.actions} data-transclusion-part="actions">
          {onToggleToLink && (
            <button
              type="button"
              className={styles.toggle}
              onClick={() => onToggleToLink(docTitle)}
              title="Turn this transclusion back into a link"
              aria-label="Show as link"
            >
              Show as link
            </button>
          )}
          <button
            type="button"
            className={styles.copyBtn}
            onClick={() => void copy(`!${href}`)}
            title={copied ? 'Copied!' : 'Copy reference'}
            aria-label={copied ? 'Copied' : 'Copy link'}
            data-copied={copied ? 'true' : undefined}
          >
            {copied ? '✓' : '⧉'}
          </button>
          {onRemove && (
            <button
              type="button"
              className={styles.removeBtn}
              onClick={onRemove}
              title="Remove this link from the text"
              aria-label="Remove link"
            >
              ×
            </button>
          )}
        </span>
      </div>
      <div className={styles.body}>
        {loops && (
          <div className={styles.status} role="note" data-transclusion-loop="true">
            Not shown: this doc is already shown above, so showing it here would loop.
          </div>
        )}
        {!loops && content === null && !error && (
          <div className={styles.status}>Loading doc content…</div>
        )}
        {error && <div className={styles.error}>Couldn't load this doc — {error}</div>}
        {!loops && content !== null && content.length === 0 && (
          <div className={styles.status}>(this doc is empty)</div>
        )}
        {!loops && content !== null && content.length > 0 && (
          <TransclusionChainProvider ids={docId ? [...chain, docId] : chain}>
            <MarkdownRenderer content={content} className={styles.markdown} depth={depth + 1} />
          </TransclusionChainProvider>
        )}
      </div>
    </div>
  );
};

/**
 * The doc id in a transclusion's URL: `doc-<id>`, or the uuid of the scheme
 * form `page:<uuid>` (passed to the API as-is). Anything else returns null and
 * the block shows an error.
 */
function parseHrefForDocId(href: string): string | null {
  if (href.startsWith('doc-')) return href;
  const m = /^page:([0-9a-fA-F-]{36})$/i.exec(href);
  if (m) return m[1];
  return null;
}
