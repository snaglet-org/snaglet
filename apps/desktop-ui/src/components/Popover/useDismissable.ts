import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/**
 * useDismissable — the one dismiss contract for anything that opens.
 *
 * Listens on `pointerdown` rather than `mousedown`: it fires first, covers
 * touch and pen, and is the same event every surface in the app shares.
 * Note the event choice is not what prevents the dismiss-then-reopen
 * double-fire on the trigger; excluding the trigger from outside presses is.
 *
 * Deliberately headless: it owns behavior only, no DOM and no styling, so an
 * inline disclosure and a portaled popover share one contract without either
 * inheriting the other's layout.
 *
 * A press outside closes the surface even while a layer it opened (a
 * select's list, a date picker) is still open: that layer closes on the same
 * press, so one click outside everything closes everything. A press inside
 * such a layer is inside the surface (React's portal bubbling says so) and
 * closes nothing above it.
 */

const MODAL_SELECTOR = '[aria-modal="true"]';

export interface DismissableOptions {
  /** Inert when false, so callers may keep the hook mounted with the surface closed. */
  open: boolean;
  /**
   * Invoked for an outside press or Escape, saying which. Identity may change
   * between renders.
   */
  onDismiss: (reason: DismissReason) => void;
  /** The surface itself; presses inside never dismiss. */
  surfaceRef: RefObject<HTMLElement | null>;
  /**
   * The control that opened the surface. Presses on it are ignored so its own
   * onClick toggle runs instead of dismiss-then-reopen (the double-fire that
   * makes a trigger feel dead).
   */
  triggerRef?: RefObject<HTMLElement | null>;
  /** Opt out of Escape, e.g. when a parent already owns the key. */
  closeOnEscape?: boolean;
  /** Opt out of outside-press dismissal for deliberately sticky surfaces. */
  closeOnOutsidePress?: boolean;
  /**
   * Escape hatch for descendants that are neither DOM nor React children —
   * native pickers, suggestion lists rendered by a third party. A press inside
   * a match never dismisses. Mirrors `[data-keeps-cell]` in TableView.
   */
  keepOpenSelector?: string;
  /**
   * On by default: hear outside presses before anything can stop them, so a
   * press whose own handler stops propagation (a grid header's column
   * controls, a tree row's export button, a canvas tool) still dismisses.
   * The decision waits until the press reaches its target, after React's
   * capture handlers have run, so content portaled out of the surface still
   * counts as inside. False listens in the bubble phase only.
   */
  capture?: boolean;
}

export type DismissReason = 'escape' | 'outside';

export interface DismissableSurfaceProps {
  /**
   * Must be attached to the surface element. React capture events bubble
   * through portals along the React tree, so this sees a press on a modal the
   * surface opened even though that modal is a DOM child of `<body>`; the
   * document listener then treats that press as inside.
   */
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function useDismissable({
  open,
  onDismiss,
  surfaceRef,
  triggerRef,
  closeOnEscape = true,
  closeOnOutsidePress = true,
  keepOpenSelector,
  capture = true,
}: DismissableOptions): DismissableSurfaceProps {
  // Read through refs so a caller passing an inline closure does not re-bind
  // listeners on every render.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const selector = useRef(keepOpenSelector);
  selector.current = keepOpenSelector;
  const insidePress = useRef<Event | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (event === insidePress.current) return;
      if (surfaceRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      if (target instanceof Element) {
        // A modal stacked above the popover, whoever opened it, keeps it open:
        // letting a press on it dismiss us would unmount the modal before its
        // click. The modal the surface lives in is below it, so a press
        // elsewhere in that modal is an ordinary outside press.
        const modal = target.closest(MODAL_SELECTOR);
        if (modal !== null && !modalIsBelow(modal, surfaceRef.current)) return;
        if (selector.current && target.closest(selector.current) !== null) return;
      }
      dismiss.current('outside');
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // defaultPrevented lets a nested control (a suggestion list, an inline
      // editor) claim Escape first and keep the surface open.
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (hasModalAbove(surfaceRef.current)) return;
      event.preventDefault();
      dismiss.current('escape');
    };

    // Capture: note the press at the document, then decide at its target.
    // The target is reached after React's root capture listener (which runs
    // the surface's onPointerDownCapture, portals included) and before any
    // bubble handler can stop the press on its way back up.
    // A press stopped before it reaches its target (an ancestor's capture
    // handler) is decided once its dispatch is over instead.
    let pending: {
      target: EventTarget;
      event: Event;
      listener: EventListener;
      timer: number;
    } | null = null;
    const dropPending = () => {
      if (!pending) return;
      pending.target.removeEventListener('pointerdown', pending.listener, true);
      window.clearTimeout(pending.timer);
      pending = null;
    };
    const onCapture = (event: PointerEvent) => {
      dropPending();
      const target = event.target;
      if (!(target instanceof Element)) {
        onPointerDown(event);
        return;
      }
      const listener: EventListener = (atTarget) => {
        if (atTarget !== event) return;
        dropPending();
        onPointerDown(event);
      };
      const timer = window.setTimeout(() => {
        if (pending?.event !== event) return;
        dropPending();
        onPointerDown(event);
      }, 0);
      pending = { target, event, listener, timer };
      target.addEventListener('pointerdown', listener, true);
    };

    const pressListener = capture ? onCapture : onPointerDown;
    if (closeOnOutsidePress) document.addEventListener('pointerdown', pressListener, capture);
    if (closeOnEscape) document.addEventListener('keydown', onKeyDown);
    return () => {
      dropPending();
      document.removeEventListener('pointerdown', pressListener, capture);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeOnEscape, closeOnOutsidePress, capture, surfaceRef, triggerRef]);

  return {
    onPointerDownCapture: (event) => {
      insidePress.current = event.nativeEvent;
    },
  };
}

/**
 * The modal a surface lives in sits below it: one that holds it, or one it
 * was portaled out of (opened from inside the modal, it comes after it in
 * the document). A modal that comes after the surface was opened over it.
 */
function modalIsBelow(modal: Element, surface: HTMLElement | null): boolean {
  return (
    surface !== null &&
    (modal.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

/**
 * True when a modal dialog is stacked above the surface, so Escape belongs to
 * the modal first. The modal the surface lives in sits below it and does not
 * count — the popover closes and the modal, seeing defaultPrevented, stays
 * open.
 */
function hasModalAbove(surface: HTMLElement | null): boolean {
  return Array.from(document.querySelectorAll(MODAL_SELECTOR)).some(
    (modal) => !modalIsBelow(modal, surface)
  );
}
