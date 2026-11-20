import { type ReactNode } from 'react';
import { SwirlIcon } from '@desktop/components/Icons';
import { cn } from '@desktop/utils/classNames';
import styles from './RunningSwirl.module.scss';

/**
 * Spins whatever swirl glyph it wraps while `spinning`, with the workspace
 * tree's run-swirl motion (still under reduced motion). The activity bar wraps
 * the Automations glyph in it; {@link RunningBadge} uses it for rows and panes.
 */
export function SwirlSpin({ spinning, children }: { spinning: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(styles.spinBox, spinning && styles.spin)}
      data-spinning={spinning || undefined}
    >
      {children}
    </span>
  );
}

/** "Running" with a spinning swirl: an automation's wake is going right now. */
export function RunningBadge({ className }: { className?: string }) {
  return (
    <span className={cn(styles.badge, className)} role="status" title="A wake is going right now">
      <SwirlSpin spinning>
        <SwirlIcon size={11} />
      </SwirlSpin>
      Running
    </span>
  );
}
