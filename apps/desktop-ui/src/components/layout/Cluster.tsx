import type { CSSProperties, HTMLAttributes } from 'react';
import type { SpaceStep } from './Stack';
import styles from './layout.module.scss';

export interface ClusterProps extends HTMLAttributes<HTMLDivElement> {
  /** Gap between items as a space-scale step. Default 2 (8px). */
  gap?: SpaceStep;
  /** Cross-axis alignment. Default center. */
  align?: 'start' | 'center' | 'baseline';
  /** Main-axis distribution. */
  justify?: 'start' | 'between' | 'end';
  /** Keep items on one line (default wraps). */
  nowrap?: boolean;
}

/**
 * Cluster — horizontal group that wraps by default. For button rows, chip
 * rows, toolbars, and label+value pairs. Tokenized gap keeps spacing uniform.
 */
export const Cluster = ({
  gap = 2,
  align,
  justify,
  nowrap,
  className,
  style,
  ...rest
}: ClusterProps) => (
  <div
    className={`${styles.cluster} ${className ?? ''}`}
    data-align={align}
    data-justify={justify}
    data-nowrap={nowrap ? 'true' : undefined}
    style={{ ['--gap']: `var(--space-${gap})`, ...style } as CSSProperties}
    {...rest}
  />
);
