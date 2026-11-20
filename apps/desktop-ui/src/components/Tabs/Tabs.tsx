import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from '../Icons';
import styles from './Tabs.module.scss';
import { cn } from '@desktop/utils/classNames';

/**
 * Room kept clear at a scrolled strip's edge: its chevron button's band plus
 * the fade beside it (`--tabs-edge` in Tabs.module.scss).
 */
const EDGE_FADE = 44;

/**
 * Scroll a horizontal tab strip just enough to show `tab` clear of the edge
 * fades. Offsets are in the strip's own pixels (it is the tabs' offset
 * parent), so the app's UI zoom doesn't skew them.
 */
function revealTab(list: HTMLElement, tab: HTMLElement): void {
  const start = tab.offsetLeft;
  const end = start + tab.offsetWidth;
  if (start - EDGE_FADE < list.scrollLeft) {
    list.scrollLeft = Math.max(0, start - EDGE_FADE);
  } else if (end + EDGE_FADE > list.scrollLeft + list.clientWidth) {
    list.scrollLeft = end + EDGE_FADE - list.clientWidth;
  }
}

/** Page a horizontal strip by most of its width toward `direction`. */
function scrollStrip(list: HTMLElement | null, direction: 1 | -1): void {
  if (!list) return;
  const left = list.scrollLeft + direction * Math.max(EDGE_FADE, list.clientWidth * 0.7);
  if (typeof list.scrollTo === 'function') list.scrollTo({ left, behavior: 'smooth' });
  else list.scrollLeft = left;
}

/**
 * The visible "more tabs this way" cue at an end of a strip that scrolls:
 * a chevron over the edge fade that pages the strip on click. Pointer only:
 * arrow keys already move through the tabs, and each one scrolls into view.
 */
const ScrollButton = ({
  direction,
  onClick,
}: {
  direction: 'start' | 'end';
  onClick: () => void;
}) => (
  <button
    type="button"
    tabIndex={-1}
    aria-hidden
    title={direction === 'start' ? 'Earlier tabs' : 'More tabs'}
    className={cn(
      styles.scrollButton,
      direction === 'start' ? styles.scrollStart : styles.scrollEnd
    )}
    data-tabs-scroll={direction}
    onClick={onClick}
    // Keep focus where it is (a tab, or the content below).
    onMouseDown={(event) => event.preventDefault()}
  >
    {direction === 'start' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
  </button>
);

type TabsOrientation = 'horizontal' | 'vertical';
type TabsVariant = 'underline' | 'rail';
type TabsSize = 'sm' | 'md';

interface TabsContextValue {
  value: string;
  onChange: (next: string) => void;
  orientation: TabsOrientation;
  variant: TabsVariant;
  size: TabsSize;
  groupId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('<Tabs.Tab> must be rendered inside a <Tabs> parent.');
  }
  return ctx;
}

interface TabsProps {
  /** Value of the currently-selected tab. */
  value: string;
  /** Called when the user selects a different tab. */
  onChange: (next: string) => void;
  orientation?: TabsOrientation;
  /**
   * underline — horizontal/vertical strip with a primary-colored underline
   *             (or left-rail accent when vertical) on the active tab.
   * rail      — vertical icon column with a filled active state and a
   *             left-edge accent bar. The ActivityBar pattern.
   */
  variant?: TabsVariant;
  size?: TabsSize;
  /** Accessible label for the tablist. */
  'aria-label'?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Tabs — keyboard-navigable tablist with `role="tablist"` semantics.
 *
 * The primitive is "headless on the panel side": consumers render their
 * own panel content driven by the same `value` they pass in. This keeps
 * the API tiny while covering every Dashboard tab pattern (icon rails,
 * underline strips, sub-nav rails).
 *
 * Keyboard: Arrow keys move within the tablist (axis-aware), Home/End
 * jump to the ends. Activation is on click — focus follows.
 *
 * A horizontal strip that doesn't fit scrolls sideways (no scrollbar; a
 * vertical wheel scrolls it too), fades at an end with more tabs past it,
 * and keeps the active tab and a focused tab in view. A strip that fits
 * looks and behaves as before.
 */
const TabsInner = forwardRef<HTMLDivElement, TabsProps>(
  (
    {
      value,
      onChange,
      orientation = 'horizontal',
      variant = 'underline',
      size = 'md',
      className,
      children,
      'aria-label': ariaLabel,
    },
    ref
  ) => {
    const groupId = useId();
    const listRef = useRef<HTMLDivElement | null>(null);
    const setListRef = useCallback(
      (node: HTMLDivElement | null) => {
        listRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref]
    );
    const horizontal = orientation === 'horizontal';
    // Which ends of a horizontal strip have tabs scrolled past them (each
    // gets an edge fade as the hint that there is more).
    const [overflow, setOverflow] = useState({ start: false, end: false });
    const measureOverflow = useCallback(() => {
      const list = listRef.current;
      if (!list) return;
      const start = list.scrollLeft > 1;
      const end = list.scrollWidth - list.clientWidth - list.scrollLeft > 1;
      setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    }, []);

    // A horizontal strip that doesn't fit scrolls sideways: track its ends,
    // and let a vertical wheel scroll it while it still can.
    useLayoutEffect(() => {
      const list = listRef.current;
      if (!list || !horizontal) return;
      measureOverflow();
      const onWheel = (event: WheelEvent) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        const room = list.scrollWidth - list.clientWidth;
        if (room <= 0) return;
        const canMove = event.deltaY > 0 ? list.scrollLeft < room - 1 : list.scrollLeft > 0;
        if (!canMove) return;
        event.preventDefault();
        list.scrollLeft += event.deltaY;
      };
      list.addEventListener('scroll', measureOverflow, { passive: true });
      list.addEventListener('wheel', onWheel, { passive: false });
      const observer =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureOverflow);
      observer?.observe(list);
      return () => {
        list.removeEventListener('scroll', measureOverflow);
        list.removeEventListener('wheel', onWheel);
        observer?.disconnect();
      };
    }, [horizontal, measureOverflow]);

    // The active tab stays in view: on mount and whenever it changes.
    useLayoutEffect(() => {
      const list = listRef.current;
      if (!list || !horizontal) return;
      const active = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (active) revealTab(list, active);
      measureOverflow();
    }, [horizontal, value, measureOverflow]);

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const horizontalKeys = orientation === 'horizontal';
        const next = horizontalKeys ? 'ArrowRight' : 'ArrowDown';
        const prev = horizontalKeys ? 'ArrowLeft' : 'ArrowUp';
        if (![next, prev, 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();

        const root = listRef.current;
        if (!root) return;
        const tabs = Array.from(
          root.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')
        );
        if (tabs.length === 0) return;
        const current = document.activeElement as HTMLButtonElement | null;
        const currentIdx = current ? tabs.indexOf(current) : -1;
        let targetIdx: number;
        if (e.key === 'Home') targetIdx = 0;
        else if (e.key === 'End') targetIdx = tabs.length - 1;
        else if (e.key === next) targetIdx = (currentIdx + 1) % tabs.length;
        else targetIdx = (currentIdx - 1 + tabs.length) % tabs.length;
        tabs[targetIdx]?.focus();
      },
      [orientation]
    );

    const ctx: TabsContextValue = {
      value,
      onChange,
      orientation,
      variant,
      size,
      groupId,
    };

    const strip = (
      <div
        ref={setListRef}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation={orientation}
        onKeyDown={handleKeyDown}
        // A tab reached by arrow keys or Tab scrolls into view.
        onFocus={(event) => {
          const list = listRef.current;
          if (horizontal && list && event.target.getAttribute('role') === 'tab')
            revealTab(list, event.target);
        }}
        data-overflow-start={horizontal && overflow.start ? '' : undefined}
        data-overflow-end={horizontal && overflow.end ? '' : undefined}
        className={cn(
          styles.tablist,
          orientation === 'vertical' ? styles.orientationVertical : styles.orientationHorizontal,
          variant === 'rail' ? styles.variantRail : styles.variantUnderline,
          size === 'sm' ? styles.sizeSm : styles.sizeMd,
          className
        )}
      >
        {children}
      </div>
    );

    return (
      <TabsContext.Provider value={ctx}>
        {horizontal ? (
          // A horizontal strip sits in a frame that holds its scroll buttons:
          // outside the tablist (only tabs belong in one) and outside its edge
          // fade, so they stay solid while the tabs behind them fade out.
          <div className={styles.frame}>
            {strip}
            {overflow.start && (
              <ScrollButton direction="start" onClick={() => scrollStrip(listRef.current, -1)} />
            )}
            {overflow.end && (
              <ScrollButton direction="end" onClick={() => scrollStrip(listRef.current, 1)} />
            )}
          </div>
        ) : (
          strip
        )}
      </TabsContext.Provider>
    );
  }
);

TabsInner.displayName = 'Tabs';

interface TabProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'value' | 'type' | 'role' | 'aria-selected' | 'id' | 'onClick'
> {
  /** Stable identifier — when this equals the parent's `value`, the tab is active. */
  value: string;
  disabled?: boolean;
  /** Accessible label (required when children is icon-only). */
  'aria-label'?: string;
  title?: string;
  className?: string;
  children: ReactNode;
}

const Tab = forwardRef<HTMLButtonElement, TabProps>(
  ({ value, disabled, title, className, children, 'aria-label': ariaLabel, ...rest }, ref) => {
    const { value: activeValue, onChange, groupId } = useTabsContext();
    const isActive = activeValue === value;

    return (
      <button
        {...rest}
        ref={ref}
        type="button"
        role="tab"
        aria-selected={isActive}
        aria-label={ariaLabel}
        // Standard tablist pattern: only the active tab is in the tab order;
        // arrow keys move focus among the others.
        tabIndex={isActive ? 0 : -1}
        id={`${groupId}-tab-${value}`}
        title={title}
        disabled={disabled}
        onClick={() => onChange(value)}
        className={cn(styles.tab, isActive && styles.tabActive, className)}
      >
        {children}
      </button>
    );
  }
);

Tab.displayName = 'Tabs.Tab';

// Compound API: <Tabs><Tabs.Tab .../></Tabs>
type TabsCompound = typeof TabsInner & {
  Tab: typeof Tab;
};
export const Tabs = TabsInner as TabsCompound;
Tabs.Tab = Tab;
