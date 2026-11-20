import { useEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { fixedLayerViewport, toFixedLayer } from '@desktop/utils/cssZoom';
import { escapeChipTitle } from '@desktop/utils/nodeChip';
import {
  docAnchorLabel,
  formatHeadingFragment,
  lineRefLabel,
  withLineRef,
  type DocAnchor,
  type LineRef,
} from '@snaglet/shared/utils';
import styles from './CopyLineLinkButton.module.scss';

/** Rect (viewport px) the selection occupies. */
export interface SelectionAnchor {
  top: number;
  left: number;
  right: number;
}

const SIZE = 28;
const GAP = 6;

/** The chip markdown for a line link: `[Doc title › L12–20](doc-…#L12-L20)`. */
export function lineLinkMarkdown(docId: string, docTitle: string, lines: LineRef): string {
  const label = `${docTitle || 'Untitled doc'} › ${lineRefLabel(lines)}`;
  return `[${escapeChipTitle(label)}](${withLineRef(docId, lines)})`;
}

/** The chip markdown for a heading link: `[Doc title › Rate limits](doc-…#h=rate-limits)`. */
export function headingLinkMarkdown(
  docId: string,
  docTitle: string,
  headingText: string,
  anchor: Extract<DocAnchor, { heading: unknown }>
): string {
  const label = `${docTitle || 'Untitled doc'} › ${headingText || anchor.heading.slug}`;
  return `[${escapeChipTitle(label)}](${docId}#${formatHeadingFragment(anchor.heading)})`;
}

/**
 * The small link button that floats above a text selection in a doc. Click
 * copies a chip that points at exactly that text; the button turns into a
 * check for a moment. Rendered in a body portal so pane zoom and overflow
 * can't clip it.
 */
export const CopyLineLinkButton: FC<{
  anchor: SelectionAnchor;
  docId: string;
  docTitle: string;
  /** What to link: lines, or a heading's section. */
  target: DocAnchor;
  /** Heading text for the chip title (heading links). */
  headingText?: string;
  /** `above` a selection (default) or `left` of a heading. */
  placement?: 'above' | 'left';
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}> = ({
  anchor,
  docId,
  docTitle,
  target,
  headingText,
  placement = 'above',
  onMouseEnter,
  onMouseLeave,
}) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const viewport = fixedLayerViewport();
  let left: number;
  let top: number;
  if (placement === 'left') {
    // In the gutter just left of the heading, vertically centered on it.
    left = Math.max(4, anchor.left - SIZE - GAP);
    top = anchor.top;
  } else {
    const center = (anchor.left + anchor.right) / 2;
    left = Math.min(Math.max(8, center - SIZE / 2), viewport.width - SIZE - 8);
    // Above the selection; below it when there's no room above.
    top = anchor.top - SIZE - GAP < 8 ? anchor.top + 24 : anchor.top - SIZE - GAP;
  }
  const label = docAnchorLabel(target, lineRefLabel);

  const copy = async () => {
    const value =
      'heading' in target
        ? headingLinkMarkdown(docId, docTitle, headingText ?? '', target)
        : lineLinkMarkdown(docId, docTitle, target.lines);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can refuse when the window isn't focused; nothing to show.
    }
  };

  return createPortal(
    <button
      type="button"
      className={`${styles.button} ${copied ? styles.copied : ''}`}
      style={{ position: 'fixed', ...toFixedLayer({ top, left }) }}
      // Keep the selection: a mousedown here would collapse it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={copy}
      title={copied ? 'Link copied' : `Copy link to ${label}`}
      aria-label={copied ? 'Link copied' : `Copy link to ${label}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-testid={'heading' in target ? 'copy-heading-link' : 'copy-line-link'}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.4-2.4a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.1 9.2a2.6 2.6 0 0 0 3.7 3.7l.9-.9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>,
    document.body
  );
};
