import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { cn } from '@desktop/utils/classNames';
import { isCellClick, keepDoubleClick } from './tableClick';
import styles from './ExpandableCell.module.scss';

/** False inside the expanded table view, where every cell shows in full. */
export const CellClampContext = createContext(true);

interface ExpandableCellProps {
  children?: ReactNode;
  /** Alignment style (`text-align`) forwarded from the GFM table cell. */
  style?: CSSProperties;
  /** Column classes MarkdownTable adds (a numeric column's alignment). */
  className?: string;
}

/** The cell's own toggle, which `isCellClick` lets through. */
const TOGGLE = '[data-cell-toggle]';

/** A mouse press on the toggle doesn't focus it: focusing scrolls a wide table sideways. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * A markdown table body cell (`<td>`) that shows at most two lines.
 *
 * A cell holding a paragraph of prose would otherwise run its row tall. The
 * content box clamps at two lines with an ellipsis (see `.clamped` in the
 * stylesheet), and the cell measures itself: only when the text actually
 * runs past those lines does a small "more" button appear under it. The
 * button (or a click anywhere else in the cell) opens the whole cell in
 * place; "less" closes it. Links, chips and buttons inside keep their clicks.
 *
 * Cells that fit read and behave exactly as plain cells. In the expanded
 * table view (CellClampContext false) nothing is clamped.
 */
export function ExpandableCell({ children, style, className }: ExpandableCellProps) {
  const clamp = useContext(CellClampContext);
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [open, setOpen] = useState(false);

  // Measured only while clamped: an open cell keeps its toggle so it can close.
  const measure = useCallback(() => {
    const content = contentRef.current;
    if (!clamp || open || !content) return;
    setOverflowing(content.scrollHeight > content.clientHeight + 1);
  }, [clamp, open]);

  // Every render: streamed text can lengthen a clamped cell without changing
  // its box.
  useLayoutEffect(measure);

  // And between renders: a column narrowing or widening rewraps the text, and
  // content can change without this cell re-rendering (a chip's title that
  // loads later).
  useEffect(() => {
    const content = contentRef.current;
    if (!clamp || !content) return;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resize?.observe(content);
    const mutation = new MutationObserver(measure);
    mutation.observe(content, { childList: true, characterData: true, subtree: true });
    return () => {
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [clamp, measure]);

  if (!clamp)
    return (
      <td style={style} className={className}>
        <div className={styles.content}>{children}</div>
      </td>
    );

  const onClick = (event: MouseEvent<HTMLTableCellElement>) => {
    if (isCellClick(event, TOGGLE)) setOpen((value) => !value);
  };

  return (
    <td
      style={style}
      className={cn(className, overflowing && styles.expandable, open && styles.open) || undefined}
      onClick={overflowing ? onClick : undefined}
      onDoubleClick={overflowing ? keepDoubleClick : undefined}
    >
      <div ref={contentRef} className={cn(styles.content, !open && styles.clamped)}>
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          className={styles.toggle}
          data-cell-toggle=""
          aria-expanded={open}
          aria-label={open ? 'Show less' : 'Show the whole cell'}
          onMouseDown={keepFocus}
        >
          {open ? 'less' : 'more'}
        </button>
      )}
    </td>
  );
}
