import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Chip } from '@desktop/components/Chip';
import {
  useAnchoredPosition,
  useDismissable,
  type DismissReason,
} from '@desktop/components/Popover';
import { cn } from '@desktop/utils/classNames';
import { useStatusBarStore } from './StatusBarContext';
import type {
  StatusBarAlertItem,
  StatusBarChipItem,
  StatusBarCustomItem,
  StatusBarMenuItem,
  StatusBarSlot,
  StatusBarTextItem,
  StatusBarToggleItem,
  StatusBarTone,
  StatusBarZone,
} from './types';
import styles from './StatusBar.module.scss';

const DEFAULT_ALERT_TIMEOUT_MS = 4000;

/** Widest a popover grows; narrower content keeps its own width. */
const POPOVER_MAX_WIDTH = 320;

/** Gap kept between a popover and its trigger, and from the window edges. */
const POPOVER_GAP = 4;

const toneClass: Record<StatusBarTone, string> = {
  neutral: styles.toneNeutral,
  muted: styles.toneMuted,
  primary: styles.tonePrimary,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  error: styles.toneError,
  info: styles.toneInfo,
};

function tone(t: StatusBarTone | undefined): string {
  return toneClass[t ?? 'muted'];
}

const TextView: FC<{ item: StatusBarTextItem }> = ({ item }) => (
  <span className={cn(styles.text, tone(item.tone))} title={item.title}>
    {item.icon !== undefined && (
      <span className={styles.icon} aria-hidden="true">
        {item.icon}
      </span>
    )}
    <span className={styles.label}>{item.label}</span>
  </span>
);

const ChipView: FC<{ item: StatusBarChipItem }> = ({ item }) => (
  <Chip
    size="xs"
    variant="outline"
    tone={item.tone ?? 'muted'}
    icon={item.icon}
    onClick={item.onClick}
    title={item.title}
  >
    {item.label}
  </Chip>
);

type PopoverRole = 'dialog' | 'menu';

/** How a popover closed: Escape, a press outside it, or a control inside it. */
type CloseReason = DismissReason | 'action';

/** A menu's enabled items, in order. */
function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
}

/** Arrow keys, Home and End move between a menu's enabled items, wrapping at the ends. */
function moveMenuFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  const items = menuItems(event.currentTarget);
  if (items.length === 0) return;
  const current = items.findIndex((item) => item === document.activeElement);
  const last = items.length - 1;
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = current < 0 || current === last ? 0 : current + 1;
      break;
    case 'ArrowUp':
      next = current <= 0 ? last : current - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    default:
      return;
  }
  event.preventDefault();
  items[next].focus();
}

/**
 * The floating surface a toggle or menu opens. It is portaled to `<body>`, so
 * the bar's sideways scroll can't clip it and it follows the app zoom (⌘+/⌘−)
 * rather than a pane's. `useAnchoredPosition` places it in that fixed layer:
 * above the trigger when it fits (else below, else slid inside the window),
 * lined up with the trigger's left edge, or its right edge in the right zone,
 * scrolling only when it is taller than the window. Escape or a press outside
 * closes it (`useDismissable`); a modal stacked above it keeps it open.
 */
const StatusBarPopover: FC<{
  id: string;
  anchor: HTMLElement;
  triggerRef: RefObject<HTMLButtonElement | null>;
  zone: StatusBarZone;
  role: PopoverRole;
  label: string;
  className?: string;
  /** Opened from the keyboard: focus moves in so its controls can be reached. */
  focusOnOpen: boolean;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
}> = ({ id, anchor, triggerRef, zone, role, label, className, focusOnOpen, onClose, children }) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { position } = useAnchoredPosition({
    anchor,
    surfaceRef,
    width: POPOVER_MAX_WIDTH,
    fitContent: true,
    side: 'above',
    align: zone === 'right' ? 'end' : 'start',
    maxHeight: Number.POSITIVE_INFINITY,
    gap: POPOVER_GAP,
    padding: POPOVER_GAP,
  });

  // Focus goes back to the trigger after Escape, or when a control inside
  // closes the popover while holding focus (a menu choice); after a press
  // elsewhere it stays where that press put it.
  const returnFocus = useRef(false);
  const close = useCallback(
    (reason: CloseReason) => {
      returnFocus.current =
        reason === 'escape' ||
        (reason === 'action' && (surfaceRef.current?.contains(document.activeElement) ?? false));
      onClose();
    },
    [onClose]
  );
  const closeFromInside = useCallback(() => close('action'), [close]);
  useEffect(
    () => () => {
      const trigger = triggerRef.current;
      const active = document.activeElement;
      const lost = active === null || active === document.body || !active.isConnected;
      if (returnFocus.current && lost && trigger?.isConnected)
        trigger.focus({ preventScroll: true });
    },
    [triggerRef]
  );

  // Capture phase: a press whose own handler stops propagation still closes it.
  const dismissProps = useDismissable({
    open: true,
    onDismiss: close,
    surfaceRef,
    triggerRef,
    capture: true,
  });

  // A hidden surface can't take focus, so move it in once the popover is placed.
  const placed = position !== null;
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!placed || !focusOnOpen || !surface || surface.contains(document.activeElement)) return;
    const target = role === 'menu' ? (menuItems(surface)[0] ?? surface) : surface;
    target.focus({ preventScroll: true });
  }, [placed, focusOnOpen, role]);

  return createPortal(
    <div
      ref={surfaceRef}
      id={id}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={cn(styles.popover, className)}
      style={position ?? { visibility: 'hidden' }}
      onKeyDown={role === 'menu' ? moveMenuFocus : undefined}
      {...dismissProps}
    >
      {children(closeFromInside)}
    </div>,
    document.body
  );
};

const MenuActions: FC<{ actions: StatusBarMenuItem['actions']; close: () => void }> = ({
  actions,
  close,
}) => (
  <>
    {actions.map((action) => (
      <button
        key={action.id}
        type="button"
        role="menuitem"
        className={cn(styles.menuAction, action.tone && tone(action.tone))}
        disabled={action.disabled}
        onClick={() => {
          action.onSelect();
          close();
        }}
      >
        {action.icon !== undefined && (
          <span className={styles.icon} aria-hidden="true">
            {action.icon}
          </span>
        )}
        <span className={styles.label}>{action.label}</span>
      </button>
    ))}
  </>
);

/** A toggle or menu: the trigger in the bar and the popover it opens. */
const PopoverItemView: FC<{
  item: StatusBarToggleItem | StatusBarMenuItem;
  zone: StatusBarZone;
}> = ({ item, zone }) => {
  const [open, setOpen] = useState(false);
  const [fromKeyboard, setFromKeyboard] = useState(false);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const close = useCallback(() => setOpen(false), []);
  const role: PopoverRole = item.type === 'menu' ? 'menu' : 'dialog';
  useEffect(() => {
    if (item.title !== 'Background workers: scripts and embeddings') return;
    const show = () => setOpen(true);
    window.addEventListener('snaglet:open-worker-controls', show);
    return () => window.removeEventListener('snaglet:open-worker-controls', show);
  }, [item.title]);
  const active = item.type === 'toggle' && item.active;

  return (
    <div className={styles.anchor} ref={setAnchor}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(styles.trigger, (open || active) && styles.triggerActive, tone(item.tone))}
        onClick={(event) => {
          // Enter / Space click with no pointer detail.
          setFromKeyboard(event.detail === 0);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup={role}
        aria-controls={open ? popoverId : undefined}
        title={item.title}
      >
        {item.icon !== undefined && (
          <span className={styles.icon} aria-hidden="true">
            {item.icon}
          </span>
        )}
        <span className={styles.label}>{item.label}</span>
        <span className={styles.caret} aria-hidden="true">
          ▴
        </span>
      </button>
      {open && anchor && (
        <StatusBarPopover
          id={popoverId}
          anchor={anchor}
          triggerRef={triggerRef}
          zone={zone}
          role={role}
          label={item.label}
          className={item.type === 'menu' ? styles.menu : undefined}
          focusOnOpen={fromKeyboard}
          onClose={close}
        >
          {(closePopover) =>
            item.type === 'menu' ? (
              <MenuActions actions={item.actions} close={closePopover} />
            ) : (
              item.render({ close: closePopover })
            )
          }
        </StatusBarPopover>
      )}
    </div>
  );
};

const AlertView: FC<{ slot: StatusBarSlot; item: StatusBarAlertItem }> = ({ slot, item }) => {
  const store = useStatusBarStore();
  useEffect(() => {
    const ms = item.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS;
    if (ms <= 0) return;
    const handle = window.setTimeout(() => {
      item.onDismiss?.();
      store.unregister(slot.id);
    }, ms);
    return () => window.clearTimeout(handle);
  }, [store, slot.id, item]);

  return (
    <span className={cn(styles.alert, tone(item.tone ?? 'info'))} role="status" title={item.title}>
      {item.icon !== undefined && (
        <span className={styles.icon} aria-hidden="true">
          {item.icon}
        </span>
      )}
      <span className={styles.label}>{item.label}</span>
    </span>
  );
};

const CustomView: FC<{ item: StatusBarCustomItem }> = ({ item }) => <>{item.render()}</>;

/** Renders a single registered slot according to its item type. */
export const StatusBarSlotView: FC<{ slot: StatusBarSlot }> = ({ slot }) => {
  const { item } = slot;
  switch (item.type) {
    case 'text':
      return <TextView item={item} />;
    case 'chip':
      return <ChipView item={item} />;
    case 'toggle':
    case 'menu':
      return <PopoverItemView item={item} zone={slot.zone} />;
    case 'alert':
      return <AlertView slot={slot} item={item} />;
    case 'custom':
      return <CustomView item={item} />;
    default: {
      // Exhaustiveness guard — a new item type must add a branch above.
      const _never: never = item;
      return _never;
    }
  }
};
