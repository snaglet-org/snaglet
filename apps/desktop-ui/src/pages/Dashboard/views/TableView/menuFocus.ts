import type { KeyboardEvent } from 'react';

/**
 * Arrow Up/Down (wrapping), Home and End move focus between a menu's enabled
 * `menuitemradio` items. Bound on the `role="menu"` element.
 */
export function moveMenuFocus(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')
  );
  if (!items.length) return;
  const current = items.findIndex((item) => item === document.activeElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}
