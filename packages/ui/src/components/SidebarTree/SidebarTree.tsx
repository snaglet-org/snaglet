import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { LeafToggle } from '../LeafToggle';
import styles from './SidebarTree.module.scss';

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * SidebarTree — the primitives behind every sidebar tree view (Settings,
 * Logs, Agents, Tools, …), styled by SidebarTree.module.scss.
 *
 *   <Tree>
 *     <TreeGroup label="Agents" count={4} open={open} onToggle={...}>
 *       <TreeRow icon={…} label="clio" paneSelection={{ kind: 'agent', agent }} />
 *     </TreeGroup>
 *   </Tree>
 */

export const Tree = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Tree(
  { className, children, ...rest },
  ref
) {
  return (
    <div role="group" {...rest} ref={ref} className={cn(styles.tree, className)}>
      {children}
    </div>
  );
});

export interface TreeChildrenProps extends HTMLAttributes<HTMLDivElement> {
  /** Px offset of the dashed guide — the parent row's chevron center. Default 14. */
  guideLeft?: number;
}

export function TreeChildren({
  guideLeft = 14,
  className,
  style,
  children,
  ...rest
}: TreeChildrenProps) {
  return (
    <div
      role="group"
      {...rest}
      className={cn(styles.children, className)}
      style={{ ['--guide-left' as string]: `${guideLeft}px`, ...style }}
    >
      {children}
    </div>
  );
}

export interface TreeGroupProps {
  /** Attributes for integrations observing the mounted disclosure header. */
  headerProps?: HTMLAttributes<HTMLDivElement> & {
    ref?: import('react').Ref<HTMLDivElement>;
    'data-sidebar-disclosure'?: string;
  };
  label: ReactNode;
  count?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Extra content on the header line, after the count. */
  trailing?: ReactNode;
  guideLeft?: number;
  /** Nesting level — indents the header on the same rhythm as TreeRow. */
  depth?: number;
  className?: string;
  children?: ReactNode;
}

export function TreeGroup({
  headerProps,
  label,
  count,
  open,
  onToggle,
  trailing,
  guideLeft,
  depth = 0,
  className,
  children,
}: TreeGroupProps) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <>
      <div
        {...headerProps}
        className={cn(styles.groupHeader, className)}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        style={depth > 0 ? { paddingLeft: 8 + depth * 14 } : undefined}
      >
        <span className={styles.chevron} aria-hidden>
          <LeafToggle open={open} className={styles.leafToggle} />
        </span>
        <span className={styles.groupLabel} data-sidebar-label="">
          {label}
        </span>
        {count !== undefined && <span className={styles.groupCount}>{count}</span>}
        {trailing}
      </div>
      {open && (
        <TreeChildren guideLeft={guideLeft ?? (depth > 0 ? 8 + depth * 14 + 6 : undefined)}>
          {children}
        </TreeChildren>
      )}
    </>
  );
}

/** Chevron slot config: 'empty' keeps the 20px column on leaf rows. */
export type TreeRowChevron =
  | 'empty'
  | {
      open: boolean;
      onToggle: (e: ReactMouseEvent<HTMLElement>) => void;
      'aria-label'?: string;
    };

export interface TreeRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** Render element. Rows that act are buttons (default); pure display rows divs. */
  as?: 'button' | 'div';
  /**
   * Nesting level — indents on the canonical `8 + depth * 14` rhythm
   * (the same rule WorkspaceTree rows use). Rows under a TreeGroup are
   * depth 1. Omit for un-nested rows.
   */
  depth?: number;
  chevron?: TreeRowChevron;
  icon?: ReactNode;
  /** Simple content: single-line label (+ optional muted description). */
  label?: ReactNode;
  description?: ReactNode;
  /** Free-form middle content — replaces label/description when provided. */
  children?: ReactNode;
  /** Right-aligned extras (switches, chips, badges) — render after the content. */
  trailing?: ReactNode;
  active?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  /** Transient cross-view search-reveal pulse. */
  reveal?: boolean;
  disabled?: boolean;
}

export const TreeRow = forwardRef<HTMLElement, TreeRowProps>(function TreeRow(
  {
    as = 'button',
    depth,
    chevron,
    icon,
    label,
    description,
    children,
    trailing,
    active = false,
    selected = false,
    dimmed = false,
    reveal = false,
    disabled = false,
    className,
    style,
    draggable,
    onClick,
    onKeyDown,
    onDragStart,
    tabIndex,
    ...rest
  },
  ref
) {
  const Tag = as as 'button';

  return (
    <Tag
      {...(as === 'button' ? { type: 'button' as const } : {})}
      {...(rest as HTMLAttributes<HTMLButtonElement>)}
      ref={ref as never}
      className={cn(
        styles.row,
        active && styles.rowActive,
        selected && styles.rowSelected,
        dimmed && styles.rowDimmed,
        reveal && styles.rowReveal,
        className
      )}
      style={depth !== undefined ? { paddingLeft: 8 + depth * 14, ...style } : style}
      disabled={as === 'button' ? disabled : undefined}
      aria-disabled={as === 'div' && disabled ? true : undefined}
      inert={as === 'div' && disabled ? true : undefined}
      tabIndex={as === 'div' && disabled ? -1 : tabIndex}
      draggable={disabled ? false : draggable}
      onClick={disabled ? undefined : onClick}
      onKeyDown={disabled ? undefined : onKeyDown}
      onDragStart={disabled ? undefined : onDragStart}
    >
      {chevron === 'empty' && (
        <span className={cn(styles.chevron, styles.chevronEmpty)} aria-hidden />
      )}
      {chevron && chevron !== 'empty' && (
        <span
          className={styles.chevron}
          aria-label={chevron['aria-label']}
          onClick={
            disabled
              ? undefined
              : (e) => {
                  // Chevron must not bubble — the row's own onClick opens the
                  // node; the chevron only expands.
                  e.stopPropagation();
                  chevron.onToggle(e);
                }
          }
        >
          <LeafToggle open={chevron.open} className={styles.leafToggle} />
        </span>
      )}
      {icon !== undefined && (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      )}
      {children !== undefined ? (
        <span className={styles.content}>{children}</span>
      ) : (
        <>
          {label !== undefined && (
            // A long name ellipsizes, so a plain-text label carries its full
            // text as a tooltip unless the row already has one.
            <span
              className={styles.label}
              data-sidebar-label=""
              title={typeof label === 'string' && rest.title === undefined ? label : undefined}
            >
              {label}
            </span>
          )}
          {description !== undefined && description !== null && (
            <span className={styles.description}>{description}</span>
          )}
        </>
      )}
      {trailing}
    </Tag>
  );
});

/** Class hooks for views that need to style kit internals (rare). */
export const sidebarTreeClasses = styles;
