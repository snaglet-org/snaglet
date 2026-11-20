import { useCallback, useRef, useState, type FC, type ReactNode } from 'react';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer/MarkdownRenderer';
import { MarkdownTextToggle } from '@desktop/components/MarkdownTextToggle/MarkdownTextToggle';
import { useHorizontalWheelScroll } from '@desktop/hooks/useHorizontalWheelScroll';
import { WHEEL_SCROLL_X_PROPS } from '@desktop/utils/horizontalWheelScroll';
import styles from './MarkdownToggleView.module.scss';

/** Which view the toggle shows: the rendered markdown or the raw source. */
type MarkdownToggleMode = 'rendered' | 'raw';

interface MarkdownToggleViewProps {
  /** Markdown source. Empty string renders the optional `emptyState`. */
  content: string;
  /** Initial mode. Defaults to `'rendered'`. */
  defaultMode?: MarkdownToggleMode;
  /** Optional element shown when `content` is empty. */
  emptyState?: ReactNode;
  /** Optional class for the outer wrapper. */
  className?: string;
  /** Optional class added to the rendered markdown body. */
  bodyClassName?: string;
  /**
   * Hide the toggle entirely (read-only renderer, no source view). Use
   * for surfaces that don't want users to peek at the raw markdown
   * — most callers want the toggle, so this defaults to `false`.
   */
  hideToggle?: boolean;
}

/**
 * MarkdownToggleView — display a chunk of markdown with a tiny
 * `rendered / md` toggle. Default view is the rendered markdown (chips
 * pill, headings format, code highlights, etc.); toggling to `md` shows
 * the raw source in a `<pre>` so users can see exactly what got saved.
 *
 * Used on docs so a reader can switch between the
 * pretty pill view and the raw source `[Title](node-id)` text.
 */
export const MarkdownToggleView: FC<MarkdownToggleViewProps> = ({
  content,
  defaultMode = 'rendered',
  emptyState,
  className,
  bodyClassName,
  hideToggle = false,
}) => {
  const [mode, setMode] = useState<MarkdownToggleMode>(defaultMode);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // The raw `<pre>` view gets the wheel handling the rendered view gets from
  // MarkdownRenderer's own delegated listener (utils/horizontalWheelScroll.ts).
  const rawWheelRef = useHorizontalWheelScroll<HTMLPreElement>();

  const handleToggle = useCallback(() => {
    // Preserve the scroll position of the nearest scrollable ancestor so
    // swapping the rendered ↔ raw DOM doesn't jump the viewport.
    const scrollEl = findScrollParent(wrapRef.current);
    const savedScroll = scrollEl?.scrollTop ?? 0;

    setMode((m) => (m === 'rendered' ? 'raw' : 'rendered'));

    // Restore after React flushes the DOM update.
    if (scrollEl) {
      requestAnimationFrame(() => {
        scrollEl.scrollTop = savedScroll;
      });
    }
  }, []);

  if (!content.trim() && emptyState !== undefined) {
    return <>{emptyState}</>;
  }

  return (
    <div ref={wrapRef} className={`${styles.wrap} ${className ?? ''}`.trim()}>
      {!hideToggle && (
        <div className={styles.toggleRow}>
          <MarkdownTextToggle
            activeSide={mode === 'rendered' ? 'left' : 'right'}
            leftLabel="md"
            rightLabel="txt"
            onToggle={handleToggle}
            title={mode === 'rendered' ? 'Show raw markdown' : 'Back to rendered view'}
            size="xs"
            chrome="pill"
            font="mono"
            ariaPressed={mode === 'raw'}
          />
        </div>
      )}
      {mode === 'raw' ? (
        <pre
          ref={rawWheelRef}
          className={`${styles.raw} ${bodyClassName ?? ''}`.trim()}
          {...WHEEL_SCROLL_X_PROPS}
        >
          {content}
        </pre>
      ) : (
        <div className={bodyClassName}>
          <MarkdownRenderer content={content} showIncludeToggle={false} />
        </div>
      )}
    </div>
  );
};

/** Walk up the DOM to find the first element with scrollable overflow. */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.documentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}
