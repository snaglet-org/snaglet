/**
 * Two-handle range control over a thread's ordered messages. A handle left at
 * its end means that side is not cut. The domain is message ordinals, not
 * time, so a handle lands on an exact message. Both handles are `role="slider"`
 * widgets driven by arrows, Home and End.
 *
 * It shows where the handles are, never how much would be deleted: the server
 * may widen the kept span to keep runs whole, and the only removal figures
 * come from its preview. Handle positions are local state in `useThreadTrim`,
 * so a drag never waits on a preview round trip.
 */

import { useCallback, useRef, type FC, type KeyboardEvent, type PointerEvent } from 'react';
import styles from './TrimRangeSlider.module.scss';

interface TrimRangeSliderProps {
  /** Number of messages; the domain is `[0, messageCount - 1]`. */
  messageCount: number;
  firstIndex: number;
  lastIndex: number;
  onChangeFirst: (index: number) => void;
  onChangeLast: (index: number) => void;
  disabled?: boolean;
}

/** Arrow = 1 message, PageUp/Down = 5% of the thread (min 5). */
function pageStep(messageCount: number): number {
  return Math.max(5, Math.round(messageCount * 0.05));
}

export const TrimRangeSlider: FC<TrimRangeSliderProps> = ({
  messageCount,
  firstIndex,
  lastIndex,
  onChangeFirst,
  onChangeLast,
  disabled = false,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const maxIndex = Math.max(0, messageCount - 1);
  const span = Math.max(1, maxIndex);

  const pct = useCallback((index: number): number => (index / span) * 100, [span]);

  const indexFromClientX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return Math.round(ratio * maxIndex);
    },
    [maxIndex]
  );

  const makePointerHandlers = (edge: 'first' | 'last') => {
    const commit = (index: number): void => {
      if (edge === 'first') onChangeFirst(index);
      else onChangeLast(index);
    };
    return {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        // Capture on the handle so the drag survives the pointer leaving the
        // track — otherwise a fast drag drops the boundary mid-gesture.
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
        commit(indexFromClientX(event.clientX));
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        commit(indexFromClientX(event.clientX));
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      },
    };
  };

  const makeKeyHandler =
    (edge: 'first' | 'last', value: number) =>
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (disabled) return;
      const step = pageStep(messageCount);
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          next = value - 1;
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          next = value + 1;
          break;
        case 'PageDown':
          next = value - step;
          break;
        case 'PageUp':
          next = value + step;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = maxIndex;
          break;
        default:
          return;
      }
      event.preventDefault();
      const clamped = Math.min(maxIndex, Math.max(0, next));
      if (edge === 'first') onChangeFirst(clamped);
      else onChangeLast(clamped);
    };

  const handle = (edge: 'first' | 'last', value: number, label: string) => (
    <div
      key={edge}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={maxIndex}
      aria-valuenow={value}
      aria-valuetext={`Message ${value + 1} of ${messageCount}`}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      className={`${styles.handle} ${edge === 'first' ? styles.handleFirst : styles.handleLast}`}
      style={{ left: `${pct(value)}%` }}
      data-tid={edge === 'first' ? 'trimHandleFirst' : 'trimHandleLast'}
      onKeyDown={makeKeyHandler(edge, value)}
      {...makePointerHandlers(edge)}
    >
      <span className={styles.handleGrip} aria-hidden="true" />
    </div>
  );

  return (
    <div className={styles.wrap} data-disabled={disabled || undefined}>
      <div className={styles.track} ref={trackRef} data-tid="trimTrack">
        {/* Removed prefix region — absent while the first handle sits at 0. */}
        {firstIndex > 0 && (
          <div
            className={styles.removedRegion}
            style={{ left: 0, width: `${pct(firstIndex)}%` }}
            aria-hidden="true"
          />
        )}
        {/* Retained region. */}
        <div
          className={styles.retainedRegion}
          style={{ left: `${pct(firstIndex)}%`, width: `${pct(lastIndex) - pct(firstIndex)}%` }}
          aria-hidden="true"
        />
        {/* Removed tail region — absent while the last handle sits at the end. */}
        {lastIndex < maxIndex && (
          <div
            className={styles.removedRegion}
            style={{ left: `${pct(lastIndex)}%`, right: 0 }}
            aria-hidden="true"
          />
        )}
        {handle('first', firstIndex, 'First retained message')}
        {handle('last', lastIndex, 'Last retained message')}
      </div>
      <div className={styles.scale} aria-hidden="true">
        <span>oldest</span>
        {/* Where the handles are: a position, never a count of removals. */}
        <span className={styles.scaleCounts} data-tid="trimSpanLabel">
          keeping {(firstIndex + 1).toLocaleString()}–{(lastIndex + 1).toLocaleString()} of{' '}
          {messageCount.toLocaleString()}
        </span>
        <span>newest</span>
      </div>
    </div>
  );
};
