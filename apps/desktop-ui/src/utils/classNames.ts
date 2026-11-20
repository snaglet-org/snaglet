/**
 * cn — compose a className string from conditional parts.
 *
 *   <div className={cn(styles.row, active && styles.active, className)} />
 *
 * The canonical classname helper for desktop-ui. Components import this
 * instead of declaring a local copy. `0` and `0n` are accepted so a
 * `node && styles.x` part type-checks when `node` is a ReactNode.
 */
export function cn(...parts: Array<string | false | null | undefined | 0 | 0n>): string {
  return parts.filter(Boolean).join(' ');
}
