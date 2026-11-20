import {
  useEffect,
  useId,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@desktop/components';
import { useAnchoredPosition, useDismissable, useReturnFocus } from '@desktop/components/Popover';
import type { DocSnapshotMeta } from '@desktop/utils/api/docs';
import { PropertiesGroup } from '../shared/PropertiesPanel';
import styles from '../DetailRouter.module.scss';
import docStyles from './DocView.module.scss';
import { snapshotLabel } from './snapshotLabel';

interface VersionListProps {
  snapshots: DocSnapshotMeta[] | null;
  /** The server's true total (may exceed the listed page); `null` = unresolved. */
  count: number | null;
  loading: boolean;
  error: string | null;
  /** The version shown in the preview, if any. */
  selectedId: string | null;
  onSelect: (snapshotId: string) => void;
  onClearAll: () => void;
  /** Every version is being cleared: both controls lock. */
  clearing: boolean;
  /** Another version action (snapshot, restore, delete) is running. */
  busy: boolean;
}

interface DocVersionsProps extends VersionListProps {
  onSnapshot: () => void;
  snapshotting: boolean;
  /** The current body is already saved as a version. */
  snapshotted: boolean;
  snapshotError: string | null;
  /** The version list is open. DocView owns it: selecting, clearing and switching docs close it. */
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /**
   * Told when this group mounts and unmounts. The Properties panel unmounts it
   * when it closes, and an open list must go with it and not come back open
   * with the panel.
   */
  onMountChange: (mounted: boolean) => void;
}

/**
 * DocVersions — the Versions group in the doc's Properties panel: Snapshot
 * saves the current body as a version, and the Versions button opens the list
 * of versions to preview (with Restore and Delete) or clear.
 */
export const DocVersions: FC<DocVersionsProps> = ({
  onSnapshot,
  snapshotting,
  snapshotted,
  snapshotError,
  open,
  onToggle,
  onClose,
  onMountChange,
  ...list
}) => {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const listId = useId();
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false);

  const mountChange = useRef(onMountChange);
  mountChange.current = onMountChange;
  useEffect(() => {
    mountChange.current(true);
    return () => mountChange.current(false);
  }, []);

  return (
    <PropertiesGroup label="Versions">
      <div className={docStyles.versionsActions} role="group" aria-label="Versions">
        <Button
          variant="neutral"
          size="sm"
          className={styles.docHeaderControl}
          onClick={onSnapshot}
          disabled={snapshotted || list.clearing}
          loading={snapshotting}
          loadingText="Snapshotting…"
          title={
            snapshotError
              ? `Snapshot failed: ${snapshotError}`
              : snapshotted
                ? 'This version is snapshotted. Edit the doc to take another.'
                : 'Save the current doc as a version. Pending edits are saved first.'
          }
        >
          {snapshotted ? 'Snapshotted ✓' : 'Snapshot'}
        </Button>
        <Button
          variant="neutral"
          size="sm"
          className={styles.docHeaderControl}
          ref={setTrigger}
          onClick={(event) => {
            // A click with no pointer press behind it came from Enter or Space.
            setOpenedByKeyboard(event.detail === 0);
            onToggle();
          }}
          disabled={list.clearing}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-pressed={open}
          aria-controls={open ? listId : undefined}
          title="Show prior versions of this doc"
        >
          {/* Count is the server's true total; omitted (not 0) until it resolves. */}
          {list.count === null ? 'Versions ▾' : `Versions ${list.count} ▾`}
        </Button>
      </div>
      {open && trigger ? (
        <VersionList
          {...list}
          id={listId}
          anchor={trigger}
          focusFirst={openedByKeyboard}
          onClose={onClose}
        />
      ) : null}
    </PropertiesGroup>
  );
};

/**
 * The open list, portaled to `<body>` and anchored to its trigger like every
 * other popover. It must not render inside the panel (or the pane topbar):
 * both are overflow scroll containers, and WebKit (the packaged app's
 * WKWebView) hit-tests a `position: fixed` descendant of one but never paints
 * it, so the list opened invisibly there while it worked in Chrome.
 */
const VersionList: FC<
  VersionListProps & {
    id: string;
    anchor: HTMLButtonElement;
    /** Opened from the keyboard: move focus onto the first version. */
    focusFirst: boolean;
    onClose: () => void;
  }
> = ({
  id,
  anchor,
  focusFirst,
  onClose,
  snapshots,
  count,
  loading,
  error,
  selectedId,
  onSelect,
  onClearAll,
  clearing,
  busy,
}) => {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(anchor);
  anchorRef.current = anchor;
  const { position } = useAnchoredPosition({
    anchor,
    surfaceRef,
    width: 360,
    fitContent: true,
    maxHeight: 320,
  });

  // Escape (wherever focus is) or a press outside the list closes it; the
  // trigger keeps its own toggle. Escape from inside the list returns focus
  // to the trigger so the keyboard user is not left on a removed element.
  const dismissProps = useDismissable({
    open: true,
    surfaceRef,
    triggerRef: anchorRef,
    onDismiss: (reason) => {
      const focusWasInside = surfaceRef.current?.contains(document.activeElement) ?? false;
      onClose();
      if (reason === 'escape' && focusWasInside) anchorRef.current?.focus();
    },
  });

  // Choosing a version or clearing them all removes the list with focus in
  // it: put focus back where it was before the list opened (or the trigger).
  // Declared before the effect below so it records focus before that moves it.
  useReturnFocus(true, surfaceRef, anchorRef);

  // The list lands at the end of <body>, so Tab from the trigger cannot reach
  // it: a keyboard open puts focus on the first version instead, once the list
  // is placed and has one.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focusFirst || position === null) return;
    const first = surfaceRef.current?.querySelector<HTMLElement>('[role="option"]');
    if (!first) return;
    focused.current = true;
    first.focus({ preventScroll: true });
  });

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')
    );
    const at = options.findIndex((option) => option === document.activeElement);
    const next = options[event.key === 'ArrowDown' ? at + 1 : at - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return createPortal(
    // The popup is a listbox of versions plus, below it, the destructive
    // Clear-all button. The button sits outside the listbox on purpose: it is
    // an action, not a selectable option, so it must not be announced as one.
    <div
      ref={surfaceRef}
      id={id}
      className={styles.docVersionsMenu}
      style={position ?? { visibility: 'hidden' }}
      data-floating-layer=""
      {...dismissProps}
    >
      <div role="listbox" aria-label="Doc versions" onKeyDown={onListKeyDown}>
        {snapshots === null && loading ? (
          <div className={styles.docVersionsItem}>Loading…</div>
        ) : error ? (
          <div className={styles.docVersionsItem}>Error: {error}</div>
        ) : snapshots && snapshots.length > 0 ? (
          snapshots.map((snap) => (
            <div
              key={snap.id}
              className={styles.docVersionsItem}
              role="option"
              aria-selected={selectedId === snap.id}
              tabIndex={0}
              onClick={() => onSelect(snap.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(snap.id);
                }
              }}
            >
              {snapshotLabel(snap)}
            </div>
          ))
        ) : (
          <div className={styles.docVersionsItem}>No prior versions.</div>
        )}
      </div>
      {snapshots !== null && count !== null && count > snapshots.length ? (
        <div className={styles.docVersionsNote}>
          Showing the latest {snapshots.length} of {count} versions.
        </div>
      ) : null}
      {count !== null && count > 0 ? (
        <div className={styles.docVersionsFooter}>
          <Button
            variant="danger"
            size="xs"
            onClick={onClearAll}
            disabled={clearing || busy}
            loading={clearing}
            loadingText="Clearing…"
            title="Permanently delete every saved version of this doc. The current doc content is not affected."
          >
            Clear all versions…
          </Button>
        </div>
      ) : null}
    </div>,
    document.body
  );
};
