import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { fixedLayerScale, fixedLayerViewport, toFixedLayer } from '@desktop/utils/cssZoom';
import styles from './ContextMenu.module.scss';

export interface ContextMenuProps {
  ariaLabel: string;
  x: number;
  y: number;
  items: Array<{
    label: string;
    disabled?: boolean;
    onSelect: () => void;
    /** Makes the item draggable (into a pane split, say); the menu closes when the drag ends. */
    onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
    /** A toggle: shows a check mark when on (a `menuitemcheckbox`). */
    checked?: boolean;
    /** Keyboard shortcut hint shown at the item's right edge. */
    shortcut?: string;
    /** Draws a divider above the item, to start a new group. */
    separatorBefore?: boolean;
  }>;
  onClose: () => void;
}

/** Enabled items, plain and toggles (`menuitemcheckbox`), in menu order. */
const ENABLED_ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)';

/**
 * `x` / `y` are pointer coordinates (`clientX` / `clientY`, rect px). The menu
 * is portaled to `<body>` inside the root zoom, so the clamped point is
 * converted to the fixed layer's CSS px (see utils/cssZoom).
 */
export function ContextMenu({ x, y, items, onClose, ariaLabel }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState(() => toFixedLayer({ left: x, top: y }));

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const scale = fixedLayerScale();
    const viewport = fixedLayerViewport();
    const bounds = menu.getBoundingClientRect();
    const padding = 8 * scale;
    const width = bounds.width || 220 * scale;
    const height = bounds.height || 40 * scale;
    setPosition(
      toFixedLayer({
        left: Math.max(padding, Math.min(x, viewport.width - width - padding)),
        top: Math.max(padding, Math.min(y, viewport.height - height - padding)),
      })
    );
  }, [x, y, items.length]);

  useLayoutEffect(() => {
    const previousFocus = document.activeElement;
    const menu = ref.current;
    const first = ref.current?.querySelector<HTMLButtonElement>(ENABLED_ITEMS);
    (first ?? ref.current)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) closeRef.current();
    };
    const close = () => closeRef.current();
    window.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      // Outside clicks should keep their newly chosen focus. Restore focus only
      // when the menu itself still owns it (Escape or an action dismissal).
      if (
        menu?.contains(document.activeElement) &&
        (previousFocus instanceof HTMLElement || previousFocus instanceof SVGSVGElement)
      ) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      closeRef.current();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>(ENABLED_ITEMS) ?? []
    );
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={styles.menu}
      style={position}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={item.checked}
          aria-keyshortcuts={item.shortcut}
          disabled={item.disabled}
          className={clsx(styles.item, item.separatorBefore && styles.separatorBefore)}
          draggable={item.onDragStart && !item.disabled ? true : undefined}
          onDragStart={item.onDragStart}
          onDragEnd={item.onDragStart ? () => closeRef.current() : undefined}
          onClick={(event) => {
            event.stopPropagation();
            closeRef.current();
            item.onSelect();
          }}
        >
          {item.checked === undefined && item.shortcut === undefined ? (
            item.label
          ) : (
            <span className={styles.row}>
              {item.checked !== undefined && (
                <span className={styles.check} aria-hidden>
                  {item.checked ? '✓' : ''}
                </span>
              )}
              <span className={styles.label}>{item.label}</span>
              {item.shortcut && (
                <span className={styles.shortcut} aria-hidden>
                  {item.shortcut}
                </span>
              )}
            </span>
          )}
        </button>
      ))}
    </div>,
    document.body
  );
}
