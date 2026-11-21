import { useEffect, useRef, type FC, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition, useDismissable } from '@desktop/components/Popover';
import type { HistoryMenuRow } from '../../layout/paneTree';
import type { NonNullableSelection } from '../../layout/paneTreeTypes';
import { useSelectionDescriptor, type SelectionKind } from '../../selection/selectionDescriptor';
import styles from './PaneHistoryNav.module.scss';

/** Widest the menu grows; narrower content keeps its own width. */
const MENU_MAX_WIDTH = 360;
const MENU_MAX_HEIGHT = 380;
/** Rows past the ninth have no number key. */
const NUMBERED_ROWS = 9;
/** Letters typed within this window build one search ("st" for Storage). */
const TYPEAHEAD_RESET_MS = 700;

/** Kind → icon-tint class, parallel to the one in PaneChrome.tsx. */
const KIND_TO_ICON_CLASS: Record<SelectionKind, string> = {
  agent: styles.iconAgent,
  container: styles.iconContainer,
  doc: styles.iconDoc,
  thread: styles.iconThread,
  dm: styles.iconThread, // a DM conversation is a thread
  project: styles.iconProject,

  profile: styles.iconAgent, // profile is the human peer — reuse the agent tint
  hub: styles.iconAgent, // Home replaces the profile pane — same tint
  'get-started': styles.iconAgent, // settings-adjacent — reuse the agent tint
  provider: styles.iconAgent,
  providers: styles.iconAgent, // settings-adjacent — reuse the agent tint
  cli: styles.iconAgent, // settings-adjacent — reuse the agent tint
  theme: styles.iconAgent, // settings-adjacent — reuse the agent tint
  'agent-instructions': styles.iconAgent, // settings-adjacent — reuse the agent tint
  storage: styles.iconAgent, // settings-adjacent — reuse the agent tint
  browser: styles.iconAgent,
  updates: styles.iconAgent, // settings-adjacent — reuse the agent tint
  'mcp-client-connection': styles.iconAgent,
  'mcp-server-connection': styles.iconAgent,
  embeddings: styles.iconAgent, // settings-adjacent — reuse the agent tint
  // Everything else keeps the shared accent; only docs take the Doc color.
  file: styles.iconOther,
  image: styles.iconOther,
  sketch: styles.iconOther, // no Sketch view; stray sketch-… ids can still sit in history
  calendar: styles.iconOther,
  tool: styles.iconOther,
  hook: styles.iconOther,
  'tool-create': styles.iconOther,
  'hook-create': styles.iconOther,
  'automation-detail': styles.iconOther,
  'automation-create': styles.iconOther,
  skill: styles.iconOther,
  table: styles.iconOther,
  'table-draft': styles.iconOther,
};

/** One row of the menu; its own component so a table row reads its live name. */
const HistoryMenuEntry: FC<{
  entry: NonNullableSelection;
  isCurrent: boolean;
  /** 1–9 for the first nine rows. */
  number: number | null;
  onSelect: (inSplit: boolean) => void;
}> = ({ entry, isCurrent, number, onSelect }) => {
  const desc = useSelectionDescriptor(entry);
  if (!desc) return null;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`${styles.entry} ${isCurrent ? styles.entryCurrent : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(e.metaKey || e.ctrlKey);
      }}
      title={desc.title}
      aria-current={isCurrent ? 'page' : undefined}
      aria-keyshortcuts={number === null ? undefined : String(number)}
    >
      <span className={`${styles.entryIcon} ${KIND_TO_ICON_CLASS[desc.kind]}`}>{desc.icon}</span>
      <span className={styles.entryLabel} data-row-label>
        {desc.title}
      </span>
      {isCurrent && (
        <span className={styles.entryCurrentDot} aria-hidden>
          •
        </span>
      )}
      {number !== null && (
        <span className={styles.entryNumber} data-row-hint aria-hidden>
          {number}
        </span>
      )}
    </button>
  );
};

function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

/**
 * Where focus starts: the place before the current one, so ⌘Y then Enter
 * goes back to where you just were.
 */
function startIndex(rows: HistoryMenuRow[]): number {
  const current = rows.findIndex((row) => row.isCurrent);
  if (current >= 0 && current + 1 < rows.length) return current + 1;
  return Math.max(
    0,
    rows.findIndex((row) => !row.isCurrent)
  );
}

/**
 * The row a typed search lands on, or -1. A new single letter, or the same
 * letter again, moves past the focused row, so repeating it cycles through
 * the rows that start with it.
 */
function typeaheadIndex(labels: string[], focused: number, text: string): number {
  const query = [...text].every((char) => char === text[0]) ? text[0] : text;
  const start = query.length === 1 ? focused + 1 : Math.max(focused, 0);
  for (let step = 0; step < labels.length; step += 1) {
    const index = (start + step) % labels.length;
    if (labels[index].startsWith(query)) return index;
  }
  return -1;
}

interface HistoryMenuProps {
  /** The Recently visited button the menu hangs from. */
  anchor: HTMLElement;
  /** The nav buttons: a press on them never dismisses the menu. */
  navRef: RefObject<HTMLElement | null>;
  rows: HistoryMenuRow[];
  /** A row was chosen: in this pane, or with ⌘ in a new pane beside it. */
  onPick: (row: HistoryMenuRow, inSplit: boolean) => void;
  /** Close; `returnFocus` gives focus back to where it was before the menu opened. */
  onClose: (returnFocus: boolean) => void;
}

/**
 * The Recently visited menu. It takes focus when it opens (the row before the
 * current one), and the keyboard drives it like a native menu: arrows, Home
 * and End move; Enter opens the row here, ⌘Enter in a new pane; 1–9 open the
 * Nth row; a letter jumps to the next row starting with it; Escape or Tab
 * closes it and gives focus back. It hangs below the button, flipping above
 * or sliding along the window to stay whole (useAnchoredPosition).
 */
export const HistoryMenu: FC<HistoryMenuProps> = ({ anchor, navRef, rows, onPick, onClose }) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { position } = useAnchoredPosition({
    anchor,
    surfaceRef,
    width: MENU_MAX_WIDTH,
    fitContent: true,
    maxHeight: MENU_MAX_HEIGHT,
    gap: 6,
  });

  // Outside press or Escape closes the menu through the shared dismiss
  // contract, so one press closes one layer: Escape that a surface above
  // already claimed leaves the menu open. Capture phase, so the press that
  // opens another element's menu still dismisses this one first.
  const dismissProps = useDismissable({
    open: true,
    onDismiss: (reason) => onClose(reason === 'escape'),
    surfaceRef,
    triggerRef: navRef,
    capture: true,
  });

  // A hidden surface can't take focus, so move in once the menu is placed.
  const placed = position !== null;
  const startAt = useRef(startIndex(rows));
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!placed || !surface || surface.contains(document.activeElement)) return;
    menuItems(surface)[startAt.current]?.focus();
  }, [placed]);

  const typed = useRef({ text: '', at: 0 });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(event.currentTarget);
    const focused = items.findIndex((item) => item === document.activeElement);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const focusRow = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        if (plain) focusRow(focused + 1);
        return;
      case 'ArrowUp':
        if (plain) focusRow(focused < 0 ? -1 : focused - 1);
        return;
      case 'Home':
        if (plain) focusRow(0);
        return;
      case 'End':
        if (plain) focusRow(-1);
        return;
      case 'Enter': {
        const row = rows[focused];
        if (!row) return;
        event.preventDefault();
        onPick(row, event.metaKey || event.ctrlKey);
        return;
      }
      case 'Tab':
        event.preventDefault();
        onClose(true);
        return;
      default:
        break;
    }
    // Space stays a click on the focused row.
    if (!plain || event.key.length !== 1 || event.key === ' ') return;
    event.preventDefault();
    if (/^[1-9]$/.test(event.key)) {
      const row = rows[Number(event.key) - 1];
      if (row) onPick(row, false);
      return;
    }
    const now = Date.now();
    const char = event.key.toLowerCase();
    typed.current = {
      text: now - typed.current.at > TYPEAHEAD_RESET_MS ? char : typed.current.text + char,
      at: now,
    };
    const labels = items.map(
      (item) => item.querySelector('[data-row-label]')?.textContent?.toLowerCase() ?? ''
    );
    const match = typeaheadIndex(labels, focused, typed.current.text);
    if (match >= 0) items[match].focus();
  };

  return createPortal(
    <div
      ref={surfaceRef}
      className={styles.menu}
      style={position ?? { visibility: 'hidden' }}
      role="menu"
      aria-label="Recently visited"
      onKeyDown={onKeyDown}
      // Focus that leaves for anything but the nav buttons (another pane, the
      // sidebar) closes the menu and stays where it went.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node)) return;
        if (event.currentTarget.contains(next) || navRef.current?.contains(next)) return;
        onClose(false);
      }}
      {...dismissProps}
    >
      <div className={styles.menuHeader} aria-hidden>
        Recently visited
      </div>
      {rows.map((row, at) => (
        <HistoryMenuEntry
          key={`${row.index}:${row.entry.kind}`}
          entry={row.entry}
          isCurrent={row.isCurrent}
          number={at < NUMBERED_ROWS ? at + 1 : null}
          onSelect={(inSplit) => onPick(row, inSplit)}
        />
      ))}
    </div>,
    document.body
  );
};
