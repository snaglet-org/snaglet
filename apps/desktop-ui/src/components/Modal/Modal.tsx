import React, { createContext, useCallback, useContext, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@desktop/utils/classNames';
import styles from './Modal.module.scss';

export interface ModalProps {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
  unstyled?: boolean;
  /**
   * Extra class applied to the inner `.panel` (the actual dialog box), on
   * top of the default width/height caps — e.g. widening a specific modal
   * that needs more room (a code editor, a wide table) without touching
   * every other Modal consumer, which all keep the default 520px cap.
   */
  panelClassName?: string;
  /** Accessible name for custom/unstyled dialogs that do not render Modal.Header. */
  'aria-label'?: string;
}

interface ModalHeaderProps {
  children: React.ReactNode;
  className?: string;
}

interface ModalBodyProps {
  children: React.ReactNode;
  className?: string;
}

interface ModalFooterProps {
  children: React.ReactNode;
  className?: string;
}

const ModalContext = createContext<{ titleId: string } | null>(null);

const ModalHeader: React.FC<ModalHeaderProps> = ({ children, className }) => (
  <div id={useContext(ModalContext)?.titleId} className={cn(styles.header, className)}>
    {children}
  </div>
);
ModalHeader.displayName = 'Modal.Header';

const ModalBody: React.FC<ModalBodyProps> = ({ children, className }) => (
  <div className={cn(styles.body, className)}>{children}</div>
);
ModalBody.displayName = 'Modal.Body';

const ModalFooter: React.FC<ModalFooterProps> = ({ children, className }) => (
  <div className={cn(styles.footer, className)}>{children}</div>
);
ModalFooter.displayName = 'Modal.Footer';

const ModalRoot: React.FC<ModalProps> = ({
  children,
  onClose,
  className,
  unstyled = false,
  panelClassName,
  'aria-label': ariaLabel,
}) => {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // One press, one layer: a press on the backdrop while a floating layer is
  // open over the dialog (a picker's list, a date picker) closes that layer
  // only, so the click it ends in must not close the dialog too. Read in the
  // capture phase, before the layer closes itself.
  const backdropPressClosesLayer = useRef(false);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const overlay = overlayRef.current;
      backdropPressClosesLayer.current =
        overlay !== null && event.target === overlay && hasFloatingLayerOver(overlay);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const onBackdropClick = () => {
    if (backdropPressClosesLayer.current) {
      backdropPressClosesLayer.current = false;
      return;
    }
    onClose();
  };

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      // One key press closes one layer. A nested surface (a popover inside
      // the dialog, an inline editor) that already consumed Escape marks it
      // defaultPrevented, a dialog opened over this one takes it first, and
      // this one marks it in turn so no dialog below closes with it.
      if (e.key !== 'Escape' || e.defaultPrevented || hasModalAbove(overlayRef.current)) return;
      e.preventDefault();
      onClose();
    },
    [onClose]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [handleEscape]);

  useEffect(() => {
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const panel = panelRef.current;
      const target = panel ? focusableElements(panel)[0] : null;
      (target ?? panel)?.focus();
    });

    return () => {
      active = false;
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  const handlePanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusable = focusableElements(panel);
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !panel.contains(current))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (current === last || !panel.contains(current))) {
      event.preventDefault();
      first?.focus();
    }
  }, []);

  // Portal to <body> so the modal escapes the ancestor it was rendered
  // from. Critical when the trigger lives inside a markdown-rendered
  // `<p>` (e.g. WikiLinkPreviewModal opening from a chip in chat copy):
  // without the portal, the modal's <header>/<h2>/<div> become invalid
  // descendants of <p> and React fires hydration warnings.
  return createPortal(
    <ModalContext.Provider value={{ titleId }}>
      <div
        ref={overlayRef}
        className={cn(!unstyled && styles.overlay, className)}
        onClick={onBackdropClick}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel ?? (unstyled ? 'Dialog' : undefined)}
          aria-labelledby={ariaLabel || unstyled ? undefined : titleId}
          tabIndex={-1}
          className={cn(!unstyled && styles.panel, !unstyled && panelClassName)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handlePanelKeyDown}
        >
          {children}
        </div>
      </div>
    </ModalContext.Provider>,
    document.body
  );
};
ModalRoot.displayName = 'Modal';

export const Modal = Object.assign(ModalRoot, {
  Header: ModalHeader,
  Body: ModalBody,
  Footer: ModalFooter,
});

const MODAL_SELECTOR = '[aria-modal="true"]';

/** A modal dialog after this one's overlay in the document: opened over it. */
function hasModalAbove(overlay: HTMLElement | null): boolean {
  if (!overlay) return false;
  return Array.from(document.querySelectorAll(MODAL_SELECTOR)).some(
    (modal) =>
      !overlay.contains(modal) &&
      (overlay.compareDocumentPosition(modal) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

/** Floating surfaces that close on an outside press mark themselves with this. */
const FLOATING_LAYER_SELECTOR = '[data-floating-layer]';

/** A floating layer opened from the dialog: inside the overlay, or portaled after it. */
function hasFloatingLayerOver(overlay: HTMLElement): boolean {
  return Array.from(document.querySelectorAll(FLOATING_LAYER_SELECTOR)).some(
    (layer) => (overlay.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Tabbable elements inside `root`, in document order. */
export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true'
  );
}
