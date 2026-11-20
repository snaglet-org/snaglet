import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@desktop/utils/classNames';
import { fixedLayerScale, fixedLayerViewport, toFixedLayer } from '@desktop/utils/cssZoom';
import styles from './Tooltip.module.scss';

export type TooltipSide = 'right' | 'left' | 'top' | 'bottom';

export interface TooltipProps {
  /** Text shown inside the chat-bubble. */
  label: ReactNode;
  /** Which side of the trigger the bubble opens toward. Default: 'right'. */
  side?: TooltipSide;
  /** Hover delay (ms) before the bubble appears. Default: 350. */
  delay?: number;
  /** Gap (px) between the trigger and the bubble tail. Default: 10. */
  gap?: number;
  className?: string;
  /**
   * The single focusable/hoverable trigger element. Its ref is used to
   * anchor the bubble, so it must forward a ref (an intrinsic element like
   * <button> does automatically).
   */
  children: ReactElement;
}

// Keep the bubble fully on-screen near the viewport edges.
const VIEWPORT_PADDING = 8;

interface Placement {
  style: CSSProperties;
  sideClass: string;
}

/**
 * Tooltip — a small chat-bubble tooltip that opens to the side of its
 * trigger on hover or keyboard focus.
 *
 * Behavior is intentionally accessible-first: it shows on focus as well
 * as hover, closes on Escape and blur, and associates the bubble with the
 * trigger via `aria-describedby` so screen readers announce it. The bubble
 * is portaled to <body> with `position: fixed` so it renders above
 * neighboring panes and is never clipped by an overflow container; the
 * placement is computed in rect px and converted to the fixed layer's CSS px
 * (it sits inside the root zoom, see utils/cssZoom).
 *
 * Designed for icon-only controls (the ActivityBar) but reusable anywhere
 * a compact label is wanted.
 */
export function Tooltip({
  label,
  side = 'right',
  delay = 350,
  gap = 10,
  className,
  children,
}: TooltipProps): ReactElement {
  const triggerRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const describedById = useId();

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const computePlacement = useCallback((): Placement | null => {
    const el = triggerRef.current;
    if (!el || typeof window === 'undefined') return null;
    const rect = el.getBoundingClientRect();
    // Rect px throughout; the gap and edge inset are CSS px, so scale them.
    const scale = fixedLayerScale();
    const { width: vw, height: vh } = fixedLayerViewport();
    const offset = gap * scale;
    const inset = VIEWPORT_PADDING * scale;

    // Anchor point + which edge the tail sits on, per requested side. We
    // position the bubble container, then let CSS draw the tail toward the
    // trigger. Cross-axis is centered on the trigger, then clamped.
    let box: { left?: number; top?: number; right?: number; bottom?: number };
    switch (side) {
      case 'left':
        box = { right: vw - rect.left + offset, top: rect.top + rect.height / 2 };
        break;
      case 'top':
        box = { left: rect.left + rect.width / 2, bottom: vh - rect.top + offset };
        break;
      case 'bottom':
        box = { left: rect.left + rect.width / 2, top: rect.bottom + offset };
        break;
      case 'right':
      default:
        box = { left: rect.right + offset, top: rect.top + rect.height / 2 };
        break;
    }

    // Clamp the cross-axis so a near-edge trigger doesn't push the bubble
    // off-screen. For left/right the cross-axis is vertical (top); for
    // top/bottom it's horizontal (left).
    if (side === 'left' || side === 'right') {
      box.top = Math.min(Math.max(inset, box.top ?? 0), vh - inset);
    } else {
      box.left = Math.min(Math.max(inset, box.left ?? 0), vw - inset);
    }

    // Inline so no caller class can turn it back on: the bubble often sits
    // over the next field, and clicks must reach it.
    return {
      style: { position: 'fixed', pointerEvents: 'none', ...toFixedLayer(box) },
      sideClass: styles[`side-${side}`],
    };
  }, [gap, side]);

  const open = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setPlacement(computePlacement());
    }, delay);
  }, [clearTimer, computePlacement, delay]);

  const close = useCallback(() => {
    clearTimer();
    setPlacement(null);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  // Close on scroll/resize — a stale fixed-position bubble would detach
  // from its trigger.
  useEffect(() => {
    if (!placement) return;
    const onDismiss = () => close();
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [placement, close]);

  // React 19 types element.props as `unknown`; give the trigger a concrete
  // shape so we can chain the caller's own handlers instead of clobbering them.
  interface TriggerProps {
    ref?: unknown;
    onMouseEnter?: (e: MouseEvent) => void;
    onMouseLeave?: (e: MouseEvent) => void;
    onFocus?: (e: FocusEvent) => void;
    onBlur?: (e: FocusEvent) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
    'aria-describedby'?: string;
  }
  const child = children as ReactElement<TriggerProps>;
  const childProps = child.props;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && placement) {
      close();
    }
    childProps.onKeyDown?.(e);
  };

  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      // Preserve any ref the caller already set on the child.
      const ref = childProps.ref;
      if (typeof ref === 'function') ref(node);
      else if (ref && typeof ref === 'object') {
        (ref as { current: HTMLElement | null }).current = node;
      }
    },
    onMouseEnter: (e: MouseEvent) => {
      open();
      childProps.onMouseEnter?.(e);
    },
    onMouseLeave: (e: MouseEvent) => {
      close();
      childProps.onMouseLeave?.(e);
    },
    onFocus: (e: FocusEvent) => {
      // Show immediately on keyboard focus (no hover delay).
      clearTimer();
      setPlacement(computePlacement());
      childProps.onFocus?.(e);
    },
    onBlur: (e: FocusEvent) => {
      close();
      childProps.onBlur?.(e);
    },
    onKeyDown: handleKeyDown,
    'aria-describedby': placement ? describedById : childProps['aria-describedby'],
  } as Partial<TriggerProps>);

  return (
    <>
      {trigger}
      {placement &&
        createPortal(
          <div
            id={describedById}
            role="tooltip"
            className={cn(styles.bubble, placement.sideClass, className)}
            style={placement.style}
          >
            {label}
          </div>,
          document.body
        )}
    </>
  );
}
