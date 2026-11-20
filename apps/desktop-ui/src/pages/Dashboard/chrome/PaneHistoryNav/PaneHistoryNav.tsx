import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FC,
  type Ref,
} from 'react';
import { historyMenuRows, type HistoryMenuRow, type PaneHistory } from '../../layout/paneTree';
import type { NonNullableSelection } from '../../layout/paneTreeTypes';
import { useSelectionDescriptor } from '../../selection/selectionDescriptor';
import { paneShortcutAria, paneShortcutHint } from '../PaneChrome/paneShortcuts';
import { LeafToggle } from '@desktop/components/Icons';
import { HistoryMenu } from './HistoryMenu';
import styles from './PaneHistoryNav.module.scss';

/** Lets the pane's ⌘Y shortcut open (or close) the menu. */
export interface PaneHistoryNavHandle {
  openMenu: () => void;
}

interface PaneHistoryNavProps {
  history: PaneHistory;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onJumpTo: (index: number) => void;
  /** Open a place in a new pane beside this one (⌘Enter or ⌘-click on a row). */
  onOpenInSplit?: (entry: NonNullableSelection) => void;
  ref?: Ref<PaneHistoryNavHandle>;
}

/**
 * Browser-style back/forward nav for a single pane: back, forward, and the
 * Recently visited menu listing each place once, newest first. The tooltips
 * name the entry back/forward would land on and each button's shortcut.
 */
export const PaneHistoryNav: FC<PaneHistoryNavProps> = ({
  history,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onJumpTo,
  onOpenInSplit,
  ref,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hasEntries = history.entries.length > 0;

  // Focus goes back to where it was before the menu opened (an editor the
  // user was typing in, else this button) after Escape, Tab or a pick in
  // this pane. Restored after the close commits, so a pick that swapped the
  // view lands on the button rather than an editor that has just unmounted.
  // A press elsewhere, focus moving away, or a pick into a new pane leaves
  // focus where that put it.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const restorePending = useRef(false);
  const openMenu = useCallback(() => {
    const active = document.activeElement;
    returnFocusTo.current = active instanceof HTMLElement ? active : null;
    setMenuOpen(true);
  }, []);
  const closeMenu = useCallback((returnFocus: boolean) => {
    if (returnFocus) restorePending.current = true;
    setMenuOpen(false);
  }, []);
  useEffect(() => {
    if (menuOpen || !restorePending.current) return;
    restorePending.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const previous = returnFocusTo.current;
    const target =
      previous && previous !== document.body && previous.isConnected ? previous : trigger;
    target?.focus({ preventScroll: true });
  }, [menuOpen, trigger]);

  useImperativeHandle(
    ref,
    () => ({
      openMenu: () => {
        if (menuOpen) closeMenu(true);
        else if (hasEntries) openMenu();
      },
    }),
    [closeMenu, hasEntries, menuOpen, openMenu]
  );

  const backTarget = canGoBack ? history.entries[history.index - 1] : null;
  const forwardTarget = canGoForward ? history.entries[history.index + 1] : null;
  const backDesc = useSelectionDescriptor(backTarget);
  const forwardDesc = useSelectionDescriptor(forwardTarget);
  const backLabel = backDesc ? `Back to ${backDesc.title}` : 'No earlier entry';
  const forwardLabel = forwardDesc ? `Forward to ${forwardDesc.title}` : 'No later entry';

  // Most recent at the top, each place once (the stack keeps revisits for
  // back and forward).
  const rows = historyMenuRows(history);

  const pick = (row: HistoryMenuRow, inSplit: boolean) => {
    if (inSplit && onOpenInSplit) {
      // The new pane becomes the active one; focus must not pull it back.
      closeMenu(false);
      onOpenInSplit(row.entry);
      return;
    }
    closeMenu(true);
    onJumpTo(row.index);
  };

  return (
    <div className={styles.wrap} ref={wrapRef} data-pane-history-nav>
      <button
        type="button"
        className={styles.btn}
        disabled={!canGoBack}
        title={`${backLabel} (${paneShortcutHint('back')})`}
        aria-label={backLabel}
        aria-keyshortcuts={paneShortcutAria('back')}
        onClick={(e) => {
          e.stopPropagation();
          onGoBack();
        }}
      >
        <LeafToggle open={false} className={`${styles.navLeaf} ${styles.navLeafBack}`} />
      </button>
      <button
        type="button"
        className={styles.btn}
        disabled={!canGoForward}
        title={`${forwardLabel} (${paneShortcutHint('forward')})`}
        aria-label={forwardLabel}
        aria-keyshortcuts={paneShortcutAria('forward')}
        onClick={(e) => {
          e.stopPropagation();
          onGoForward();
        }}
      >
        <LeafToggle open={false} className={`${styles.navLeaf} ${styles.navLeafForward}`} />
      </button>
      <button
        ref={setTrigger}
        type="button"
        className={`${styles.btn} ${styles.menuTrigger} ${menuOpen ? styles.menuOpen : ''}`}
        disabled={!hasEntries}
        title={`Recently visited (${paneShortcutHint('history')})`}
        aria-label="Recently visited"
        aria-keyshortcuts={paneShortcutAria('history')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen) closeMenu(false);
          else openMenu();
        }}
      >
        <LeafToggle open={false} className={`${styles.navLeaf} ${styles.navLeafDown}`} />
      </button>
      {menuOpen && trigger && rows.length > 0 && (
        <HistoryMenu
          anchor={trigger}
          navRef={wrapRef}
          rows={rows}
          onPick={pick}
          onClose={closeMenu}
        />
      )}
    </div>
  );
};
