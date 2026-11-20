import type { FC, ReactNode } from 'react';
import styles from './StateHint.module.scss';

interface StateHintProps {
  children: ReactNode;
  /** Recolors to the error token. Use for failure copy ("Error: …"). */
  variant?: 'muted' | 'error';
  /** Optional extra className for view-specific overrides. */
  className?: string;
}

/**
 * Centered, muted, monospaced view-body placeholder. Standard treatment
 * for whole-view loading / empty / error states across the Dashboard.
 * Use this instead of rolling a per-view `.loading` / `.placeholder`
 * SCSS rule with the same shape.
 *
 * Doesn't try to cover inline list-hints (smaller padding, sidebar context)
 * or composite empty-states with title + body — those keep their local
 * styles since their layout intent diverges.
 */
export const StateHint: FC<StateHintProps> = ({ children, variant = 'muted', className }) => (
  <div
    className={[styles.hint, variant === 'error' ? styles.error : '', className]
      .filter(Boolean)
      .join(' ')}
  >
    {children}
  </div>
);
