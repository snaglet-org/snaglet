import type { CSSProperties, HTMLAttributes } from 'react';
import styles from './layout.module.scss';

/** Space-scale step (maps to `--space-1`…`--space-8`). */
export type SpaceStep = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  /** Vertical gap as a space-scale step. Default 4 (16px). */
  gap?: SpaceStep;
  /** Cross-axis alignment. Default stretch. */
  align?: 'start' | 'center' | 'end';
}

/**
 * Stack — vertical rhythm primitive. Composes children in a column with a
 * tokenized gap so vertical spacing is consistent across every pane.
 */
export const Stack = ({ gap = 4, align, className, style, ...rest }: StackProps) => (
  <div
    className={`${styles.stack} ${className ?? ''}`}
    data-align={align}
    style={{ ['--gap']: `var(--space-${gap})`, ...style } as CSSProperties}
    {...rest}
  />
);
