import { forwardRef, type PointerEventHandler, type ReactNode } from 'react';
import styles from './Popover.module.scss';

type PopoverPlacement = 'inline' | 'floating';

export interface PopoverProps {
  /** Rendered only while open, so children mount fresh and autofocus works. */
  open: boolean;
  /** Accessible name. Required: an unlabeled dialog is announced as nothing. */
  label: string;
  id?: string;
  /**
   * `inline` keeps the surface in flow beneath its trigger (ProjectView's
   * container settings) and carries no chrome of its own — the caller's
   * `className` decides how it blends into the panel around it. `floating`
   * lifts it out with fixed positioning and the card chrome a menu or picker
   * needs. Inline is the default because it is the common case and cannot be
   * clipped or mis-anchored.
   */
  placement?: PopoverPlacement;
  /**
   * `dialog` for a surface holding form controls; `group` for a plain
   * disclosure of content. A disclosure announced as a dialog is a lie that
   * makes screen-reader users hunt for a close button that is not there.
   */
  role?: 'dialog' | 'group';
  className?: string;
  /** Supplied by `usePopover().surfaceProps`; lets portaled children count as inside. */
  onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
  children: ReactNode;
}

/**
 * Popover — the visual shell paired with `usePopover`'s behavior.
 *
 * Owns presentation and ARIA only; dismissal lives in `useDismissable` so a
 * caller needing bespoke layout can keep the contract without this component.
 *
 * Positioning for `floating` is intentionally NOT implemented here: TableView's
 * FieldEditorPopover already solves anchored positioning (pane clamping,
 * flip-above, ResizeObserver, MutationObserver) and that logic should be lifted
 * into this file rather than reimplemented.
 */
export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  {
    open,
    label,
    id,
    placement = 'inline',
    role = 'group',
    className,
    onPointerDownCapture,
    children,
  },
  ref
) {
  if (!open) return null;

  const classes = [
    styles.surface,
    placement === 'floating' ? styles.floating : styles.inline,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      {...(role === 'dialog' ? { 'aria-modal': false as const, tabIndex: -1 } : {})}
      className={classes}
      data-popover=""
      data-placement={placement}
      onPointerDownCapture={onPointerDownCapture}
    >
      {children}
    </div>
  );
});
