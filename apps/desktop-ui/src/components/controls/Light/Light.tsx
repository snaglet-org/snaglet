import styles from './Light.module.scss';
import { cn } from '@desktop/utils/classNames';

/**
 * Map of friendly status names to theme tokens, so status lights track the
 * active color theme instead of fixed hues. Any other value (hex, rgb(),
 * var(--token), …) passes through untouched.
 */
const NAMED_COLORS: Record<string, string> = {
  green: 'var(--color-success)',
  red: 'var(--color-error)',
  amber: 'var(--color-warning)',
  blue: 'var(--color-info)',
  // Online/active indicator — a calm white dot rather than a loud green.
  // The token stays white across themes; the control's hairline ring
  // keeps it visible on pale surfaces.
  white: 'var(--color-status-online)',
};

export interface LightProps {
  /** Any CSS color (`green`, `#22c55e`, `var(--color-brand)`, …). */
  color: string;
  /** Whether the light is lit. Off renders a dim socket, not nothing. */
  on: boolean;
  /** Dot diameter in px. Default 8. */
  size?: number;
  /** Animate a glow pulse while on. */
  pulse?: boolean;
  className?: string;
  /** Accessible label, e.g. "Agent running". Defaults to decorative. */
  'aria-label'?: string;
  title?: string;
}

/**
 * Light — a small status indicator dot with a soft glow.
 *
 * Generic on/off + color primitive: live-run indicators,
 * agent online/idle, webhook activity, etc.
 *
 *   <Light color="white" on={isRunning} pulse />
 */
export function Light({
  color,
  on,
  size = 8,
  pulse = false,
  className,
  'aria-label': ariaLabel,
  title,
}: LightProps) {
  return (
    <span
      className={cn(styles.light, !on && styles.off, on && pulse && styles.pulse, className)}
      style={
        {
          '--light-color': NAMED_COLORS[color] ?? color,
          '--light-size': `${size}px`,
        } as React.CSSProperties
      }
      role={ariaLabel ? 'status' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      title={title}
    />
  );
}
