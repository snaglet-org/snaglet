import type { ReactNode } from 'react';

/**
 * Status bar types. The bar is a global slot system: any feature registers
 * content into one of three zones. Content is declarative (a union on `type`),
 * so the bar controls presentation and callers only say what to show.
 */

/** The three horizontal regions of the bar, left → right. */
export type StatusBarZone = 'left' | 'center' | 'right';

/** Tone vocabulary — mirrors the Chip tones so both read the same. */
export type StatusBarTone =
  | 'neutral'
  | 'muted'
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

interface StatusBarItemBase {
  /** Color treatment. Defaults to `muted` (the quiet resting tone). */
  tone?: StatusBarTone;
  /** Native tooltip on hover. */
  title?: string;
}

/** Plain text label (optionally with a leading glyph). */
export interface StatusBarTextItem extends StatusBarItemBase {
  type: 'text';
  label: string;
  icon?: ReactNode;
}

/** Icon + label chip. Clickable when `onClick` is supplied. */
export interface StatusBarChipItem extends StatusBarItemBase {
  type: 'chip';
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
}

/**
 * Toggle button that opens a small popover above the bar. `render` supplies the
 * popover body and receives a `close` callback so its own controls can dismiss
 * it. The popover closes on outside-click / Escape automatically.
 */
export interface StatusBarToggleItem extends StatusBarItemBase {
  type: 'toggle';
  label: string;
  icon?: ReactNode;
  /** Optional controlled "pressed" visual, independent of the popover state. */
  active?: boolean;
  render: (ctx: { close: () => void }) => ReactNode;
}

/** A single row inside a `menu` item's popover. */
interface StatusBarMenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  tone?: StatusBarTone;
}

/** Expandable menu trigger — opens a list of actions above the bar. */
export interface StatusBarMenuItem extends StatusBarItemBase {
  type: 'menu';
  label: string;
  icon?: ReactNode;
  actions: StatusBarMenuAction[];
}

/**
 * Ephemeral alert badge. Auto-dismisses after `timeoutMs` (default 4000ms),
 * removing itself from the registry. Pass `timeoutMs: 0` to disable
 * auto-dismiss (the caller must then unregister it explicitly).
 */
export interface StatusBarAlertItem extends StatusBarItemBase {
  type: 'alert';
  label: string;
  icon?: ReactNode;
  timeoutMs?: number;
  onDismiss?: () => void;
}

/** Escape hatch — render arbitrary content. Use sparingly; prefer the typed items. */
export interface StatusBarCustomItem {
  type: 'custom';
  render: () => ReactNode;
}

type StatusBarItem =
  | StatusBarTextItem
  | StatusBarChipItem
  | StatusBarToggleItem
  | StatusBarMenuItem
  | StatusBarAlertItem
  | StatusBarCustomItem;

/**
 * A registered slot. Re-registering the same `id` replaces the slot in place;
 * `order` sorts within a zone (ascending, ties keep registration order).
 */
export interface StatusBarSlot {
  id: string;
  zone: StatusBarZone;
  order?: number;
  item: StatusBarItem;
}
