import { useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition } from '@desktop/components/Popover/useAnchoredPosition';
import { useDismissable } from '@desktop/components/Popover/useDismissable';
import styles from './FieldEditorPopover.module.scss';

interface Props {
  id: string;
  label: string;
  anchor: HTMLElement;
  resolveAnchor?: () => HTMLElement | null;
  onRequestClose: () => void;
  children: ReactNode;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** A non-modal form keeps chip browsing available while owning its dismissal. */
export function FieldEditorPopover({
  id,
  label,
  anchor,
  resolveAnchor,
  onRequestClose,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onRequestClose);
  close.current = onRequestClose;
  const resolver = useRef(resolveAnchor);
  resolver.current = resolveAnchor;
  const { position } = useAnchoredPosition({
    anchor,
    resolveAnchor,
    surfaceRef: ref,
    // A schema refresh can replace the insertion boundary with a new header
    // without changing the surrounding grid's dimensions.
    mutationScope: (target) =>
      target.closest('[data-table-entries-grid]') ?? target.closest('table')?.parentElement,
  });

  // The shared dismiss contract: capture-phase outside presses (the grid's
  // header controls stop theirs), Escape unless a nested control claimed it,
  // and presses in portals the form opened (a date picker) count as inside.
  const opener = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return resolver.current?.() ?? anchor;
      },
    }),
    [anchor]
  );
  const dismissProps = useDismissable({
    open: true,
    onDismiss: () => close.current(),
    surfaceRef: ref,
    triggerRef: opener,
    // The grid's save-error actions and undo act on the open form.
    keepOpenSelector: '[data-keeps-cell]',
  });

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={label}
      aria-modal="false"
      tabIndex={-1}
      className={styles.popover}
      style={position ?? { opacity: 0, pointerEvents: 'none' }}
      data-field-editor-popover=""
      onPointerDownCapture={dismissProps.onPointerDownCapture}
      onKeyDownCapture={(event) => {
        const panel = ref.current;
        if (
          event.key !== 'Tab' ||
          !panel ||
          !(event.target instanceof Node) ||
          !panel.contains(event.target)
        ) {
          return;
        }
        const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (element) =>
            element.getAttribute('tabindex') !== '-1' &&
            !element.closest('[hidden], [aria-hidden="true"]')
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) {
          event.preventDefault();
          panel.focus();
        } else if (event.shiftKey && (document.activeElement === first || event.target === panel)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || event.target === panel)) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {/* Inherited visibility can transition on descendants and block autofocus. */}
      {position && children}
    </div>,
    document.body
  );
}
