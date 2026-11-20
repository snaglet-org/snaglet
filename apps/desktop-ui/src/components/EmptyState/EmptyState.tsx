import type { FC, ReactNode } from 'react';
import { AutofitHeading } from '../AutofitHeading';
import styles from './EmptyState.module.scss';

type EmptyStateLayout = 'centered' | 'inline';

export interface EmptyStateProps {
  /**
   * `centered` (default): icon over title over body, full-bleed pane center.
   * `inline`: left-aligned card block — fits inside flow content (e.g. above
   * a composer when a chat has no participants yet).
   */
  layout?: EmptyStateLayout;
  /** Optional glyph; rendered inside a square bezel above the title. */
  icon?: ReactNode;
  /** Required short headline. */
  title: ReactNode;
  /** Optional explanatory body, typically 1-2 sentences. */
  body?: ReactNode;
  /** Optional CTA / button row rendered under the body. */
  action?: ReactNode;
  /** ARIA role — defaults to `status` for live empty-state announcements. */
  role?: string;
  className?: string;
}

/**
 * Shared "nothing here yet" panel.
 *
 * Replaces 6 hand-rolled `.empty / .emptyTitle / .emptyBody` blocks scattered
 * across Dashboard surfaces. If you need a single-line muted placeholder (e.g.
 * "no messages yet"), this is overkill — render an inline `<div>` directly.
 */
export const EmptyState: FC<EmptyStateProps> = ({
  layout = 'centered',
  icon,
  title,
  body,
  action,
  role = 'status',
  className,
}) => {
  const cls = [styles.root, styles[layout], className].filter(Boolean).join(' ');
  return (
    <div className={cls} role={role}>
      {icon && (
        <span className={styles.glyph} aria-hidden>
          {icon}
        </span>
      )}
      {/* Autofit: the headline fits its box, shrinking to the TYPE_SCALE
          floor before it truncates when the empty state sits in a narrow
          pane. Alignment stays with CSS (centered vs inline layout). */}
      <AutofitHeading as="div" variant="title" className={styles.title}>
        {title}
      </AutofitHeading>
      {body && <div className={styles.body}>{body}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
};
