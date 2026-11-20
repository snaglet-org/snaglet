import type { CSSProperties, ReactNode } from 'react';
import type { SpaceStep } from './Stack';
import styles from './layout.module.scss';

export interface SectionProps {
  /** Small mono uppercase label above the content. */
  label?: ReactNode;
  /** Optional controls aligned to the right of the label row. */
  actions?: ReactNode;
  /** Gap between label and content as a space-scale step. Default 2 (8px). */
  gap?: SpaceStep;
  className?: string;
  children: ReactNode;
}

/**
 * Section — the app's canonical "labeled block": a small label + content
 * framed as a raised panel (old-Windows outset bevel). Panes compose Sections
 * inside a Stack instead of inventing their own headers or card wrappers.
 */
export const Section = ({ label, actions, gap = 2, className, children }: SectionProps) => (
  <section
    className={`${styles.section} ${className ?? ''}`}
    style={{ ['--gap']: `var(--space-${gap})` } as CSSProperties}
  >
    {(label || actions) && (
      <div className={styles.sectionHead}>
        {label ? <h3 className={styles.sectionLabel}>{label}</h3> : <span />}
        {actions}
      </div>
    )}
    {children}
  </section>
);
