import { isMacPlatform, shortcutLabel } from '@desktop/utils/platform';
import { isEditableTarget } from '../../hooks/useHotkey';

/**
 * The keyboard shortcuts for getting around the panes: one table for the key
 * handlers, the tooltips that advertise them and the user guide.
 *
 * ⌘ and Ctrl both count as `Mod`, as in useHotkey. ⌃Tab means the Control
 * key on every platform, since ⌘Tab belongs to macOS.
 */
export type PaneShortcut =
  | 'back'
  | 'forward'
  | 'history'
  | 'home'
  | 'up'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'focusNext'
  | 'focusPrevious';

/** Key parts for `shortcutLabel`. */
const PANE_SHORTCUT_KEYS: Record<PaneShortcut, string[]> = {
  back: ['Mod', '['],
  forward: ['Mod', ']'],
  history: ['Mod', 'Y'],
  home: ['Mod', 'Shift', 'H'],
  up: ['Mod', '↑'],
  focusLeft: ['Mod', 'Alt', '←'],
  focusRight: ['Mod', 'Alt', '→'],
  focusUp: ['Mod', 'Alt', '↑'],
  focusDown: ['Mod', 'Alt', '↓'],
  focusNext: ['Ctrl', 'Tab'],
  focusPrevious: ['Ctrl', 'Shift', 'Tab'],
};

const FOCUS_BY_ARROW: Record<string, PaneShortcut> = {
  ArrowLeft: 'focusLeft',
  ArrowRight: 'focusRight',
  ArrowUp: 'focusUp',
  ArrowDown: 'focusDown',
};

/** Label parts as `aria-keyshortcuts` names them (UI Events key values). */
const ARIA_KEYS: Record<string, string> = {
  Ctrl: 'Control',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
};

/** "⌘[" on macOS, "Ctrl+[" elsewhere. */
export function paneShortcutHint(shortcut: PaneShortcut): string {
  return shortcutLabel(PANE_SHORTCUT_KEYS[shortcut]);
}

/** The `aria-keyshortcuts` value: "Meta+[" on macOS, "Control+[" elsewhere. */
export function paneShortcutAria(shortcut: PaneShortcut): string {
  const mod = isMacPlatform() ? 'Meta' : 'Control';
  return PANE_SHORTCUT_KEYS[shortcut]
    .map((key) => (key === 'Mod' ? mod : (ARIA_KEYS[key] ?? key)))
    .join('+');
}

/** Which pane shortcut a keydown is, or null. */
export function matchPaneShortcut(event: KeyboardEvent): PaneShortcut | null {
  if (event.isComposing) return null;
  if (event.key === 'Tab') {
    if (!event.ctrlKey || event.metaKey || event.altKey) return null;
    return event.shiftKey ? 'focusPrevious' : 'focusNext';
  }
  if (!(event.metaKey || event.ctrlKey)) return null;
  if (event.altKey) return event.shiftKey ? null : (FOCUS_BY_ARROW[event.key] ?? null);
  if (event.shiftKey) return event.key.toLowerCase() === 'h' ? 'home' : null;
  if (event.key.toLowerCase() === 'y') return 'history';
  if (event.key === '[') return 'back';
  if (event.key === ']') return 'forward';
  if (event.key === 'ArrowUp') return 'up';
  return null;
}

/**
 * Shortcuts left to text fields and editors: there ⌘Y redoes and ⌘↑ moves
 * the caret to the start, and Home and Recently visited would pull the user
 * out of what they are writing. Back, forward and the pane moves mean
 * nothing to a text field, so they work while typing, as ⌘[ does in Notion.
 */
const NOT_WHILE_TYPING: ReadonlySet<PaneShortcut> = new Set(['history', 'home', 'up']);

/** A text field, or anything inside a rich or code editor. */
function isTyping(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  return (
    target instanceof Element &&
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

/**
 * The pane shortcut a keydown asks for, or null when something else owns
 * it: a control that already handled the key (a code editor indents on ⌘[,
 * adds a cursor on ⌘⌥↑), a modal dialog above the panes, or a text field
 * for the shortcuts that stay out of one.
 */
export function paneShortcutFor(event: KeyboardEvent): PaneShortcut | null {
  if (event.defaultPrevented) return null;
  const shortcut = matchPaneShortcut(event);
  if (!shortcut) return null;
  if (NOT_WHILE_TYPING.has(shortcut) && isTyping(event.target)) return null;
  if (document.querySelector('[aria-modal="true"]')) return null;
  return shortcut;
}
