import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { fixedLayerScale, fixedLayerViewport, toFixedLayer } from '@desktop/utils/cssZoom';
import styles from './EditorPopover.module.scss';

/** A caret or element rect, in rect px (`getBoundingClientRect` / `coordsAtPos`). */
export type EditorPopoverAnchor = {
  left: number;
  top: number;
  bottom: number;
  width?: number;
} | null;

type EditorPopoverOptions = {
  width?: number;
  maxHeight?: number;
  gap?: number;
  viewportPadding?: number;
};

const DEFAULT_WIDTH = 360;
const DEFAULT_MAX_HEIGHT = 320;
const DEFAULT_GAP = 8;
const DEFAULT_VIEWPORT_PADDING = 12;

/**
 * The card's whole height in its own CSS px: its border plus each child at
 * full size (the list child scrolls, so its scrollHeight is its content).
 */
function naturalHeight(card: HTMLElement): number {
  let total = card.offsetHeight - card.clientHeight;
  for (const child of Array.from(card.children)) {
    if (child instanceof HTMLElement) total += Math.max(child.scrollHeight, child.offsetHeight);
  }
  return total;
}

/**
 * Placement for the body-portaled card. The math runs in rect px — the
 * anchor, the viewport, and the option sizes (CSS px) times the fixed layer's
 * scale — and is converted back to the card's CSS px once at the end, since
 * the portal sits inside the root zoom (see utils/cssZoom).
 *
 * It orients so the whole card shows: below the caret when it fits there,
 * else above when it fits there, else on the roomier side, scrolling inside.
 * It never slides over the caret's line (the text being typed stays in view).
 * `natural` is the card's measured height in CSS px (0 before it is measured).
 */
function useEditorPopoverStyle(
  anchor: EditorPopoverAnchor,
  natural: number,
  options: EditorPopoverOptions = {}
): CSSProperties {
  return useMemo(() => {
    if (!anchor || typeof window === 'undefined') {
      return { opacity: 0, pointerEvents: 'none' };
    }

    const scale = fixedLayerScale();
    const viewport = fixedLayerViewport();
    const viewportPadding = (options.viewportPadding ?? DEFAULT_VIEWPORT_PADDING) * scale;
    const gap = (options.gap ?? DEFAULT_GAP) * scale;
    const maxHeightLimit = Math.max(80 * scale, viewport.height - viewportPadding * 2);
    const targetMaxHeight = Math.min(
      (options.maxHeight ?? DEFAULT_MAX_HEIGHT) * scale,
      maxHeightLimit
    );
    const width = Math.min(
      (options.width ?? DEFAULT_WIDTH) * scale,
      Math.max(120 * scale, viewport.width - viewportPadding * 2)
    );
    const left = Math.min(
      Math.max(viewportPadding, anchor.left),
      Math.max(viewportPadding, viewport.width - width - viewportPadding)
    );

    const spaceBelow = viewport.height - anchor.bottom - gap - viewportPadding;
    const spaceAbove = anchor.top - gap - viewportPadding;
    const wanted = Math.min(natural * scale, targetMaxHeight);
    const openBelow = wanted <= spaceBelow || (wanted > spaceAbove && spaceBelow >= spaceAbove);
    const availableHeight = Math.max(openBelow ? spaceBelow : spaceAbove, 80 * scale);
    const maxHeight = Math.min(targetMaxHeight, availableHeight);
    const shown = Math.min(wanted, maxHeight);
    const preferredTop = openBelow ? anchor.bottom + gap : anchor.top - gap - shown;
    const top = Math.min(
      Math.max(viewportPadding, preferredTop),
      Math.max(viewportPadding, viewport.height - shown - viewportPadding)
    );

    return {
      position: 'fixed',
      ...toFixedLayer({ top, left, width, maxHeight }),
      zIndex: 2000,
    };
  }, [anchor, natural, options.gap, options.maxHeight, options.viewportPadding, options.width]);
}

type EditorPopoverProps = {
  anchor: EditorPopoverAnchor;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  maxHeight?: number;
  width?: number;
  /** `listbox` (default) for pickers; `dialog` for a small form. */
  role?: 'listbox' | 'dialog';
};

export function EditorPopover({
  anchor,
  ariaLabel,
  children,
  className,
  maxHeight,
  width,
  role = 'listbox',
}: EditorPopoverProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState(0);
  const open = anchor !== null;
  // Measure before paint, and again whenever the results inside change.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!open || !card) return;
    const measure = () => setNatural(naturalHeight(card));
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(card, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [open]);
  const style = useEditorPopoverStyle(anchor, natural, { maxHeight, width });
  if (!anchor) return null;

  return createPortal(
    <div
      ref={cardRef}
      className={clsx(styles.popover, className)}
      style={style}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>,
    document.body
  );
}

type EditorPopoverHeaderProps = {
  glyph: string;
  text: string;
  muted?: boolean;
};

export function EditorPopoverHeader({ glyph, text, muted }: EditorPopoverHeaderProps) {
  return (
    <div className={styles.header}>
      <span className={styles.glyph} aria-hidden="true">
        {glyph}
      </span>
      <span className={clsx(styles.query, muted && styles.queryMuted)}>{text}</span>
    </div>
  );
}

export { styles as editorPopoverStyles };
