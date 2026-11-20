import { useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useElementWidth } from '@desktop/hooks/useElementWidth';
import { Button } from '@desktop/components';
import { cn } from '@desktop/utils/classNames';
import { useHasPaneChrome, usePaneChromeActions } from '../../chrome/PaneChrome/PaneChrome';
import { OpenInSidebarButton, useClaimOpenInSidebar } from '../../chrome/PaneChrome/openInSidebar';
import { useSettingsPanelSize } from '../ChatView/useSettingsPanelSize';
import styles from './PropertiesPanel.module.scss';

/** Below this pane width the panel drops from the top instead of the side
 *  (same breakpoint as the thread settings panel). */
const PROPERTIES_NARROW_THRESHOLD = 520;

/** Properties toggle glyph: a panel with a sidebar rule, like a drawer. */
const PanelGlyph: FC = () => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
  >
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <line x1="14.5" y1="4.5" x2="14.5" y2="19.5" />
  </svg>
);

interface PropertiesPanelProps {
  /** Accessible name for the panel, e.g. "Document properties". */
  ariaLabel: string;
  /** The view's own content (editor, grid, image…). */
  children: ReactNode;
  /** Panel contents; only mounted while the panel is open. */
  panel: ReactNode;
  /** Extra pane-topbar controls placed before the Properties toggle. Rendered
   *  live through a portal, so callers pass plain JSX (no memoizing). */
  topbarActions?: ReactNode;
  /** Fixed right-edge topbar controls placed before the toggle (e.g. a
   *  view-mode switch). The toggle itself always pins to the right edge so
   *  a skinny pane never scrolls it out of view. Memoize this one. */
  rightActions?: ReactNode;
  /** A short state worth seeing while closed (e.g. "save failed"). */
  badge?: ReactNode;
  /** Extra class on the outer shell (the view's own root layout). */
  className?: string;
  /** Start open (tests, deep links). */
  defaultOpen?: boolean;
}

/**
 * PropertiesPanel — node properties (docs, folders, projects, images) as a
 * quiet pull-out panel.
 *
 * A Properties button lives in the pane topbar (with any `topbarActions`).
 * Opening it slides a resizable sidebar in from the right; in a skinny pane
 * (< 520px) it drops down from the top instead and pushes the content down,
 * the same two shapes the thread settings panel uses (and the same resize
 * hook). Closed by default every time the view mounts.
 */
export const PropertiesPanel: FC<PropertiesPanelProps> = ({
  ariaLabel,
  children,
  panel,
  topbarActions,
  rightActions,
  badge,
  className,
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(shellRef);
  const isNarrow = width !== null && width < PROPERTIES_NARROW_THRESHOLD;
  const { drawerStyle, sidebarStyle, drawerHandle, sidebarHandle } = useSettingsPanelSize(shellRef);

  // The topbar holds one stable slot; live controls portal into it. Pushing
  // fresh JSX through usePaneChromeActions every render would loop. Outside a
  // pane (link preview modal) there is no topbar, so the same controls render
  // in a thin strip of the panel's own.
  const inPane = useHasPaneChrome();
  // "Open in sidebar" lives at the top of this panel, not in the topbar.
  useClaimOpenInSidebar();
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null);
  const toggle = (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={open ? 'Hide properties' : 'Show properties'}
      aria-pressed={open}
      aria-expanded={open}
      title={open ? 'Hide properties' : 'Properties'}
      className={cn(styles.toggle, open && styles.toggleOn)}
      onClick={() => setOpen((v) => !v)}
      data-testid="properties-toggle"
    >
      <PanelGlyph />
    </Button>
  );
  usePaneChromeActions(useMemo(() => <span ref={setSlot} className={styles.topbarSlot} />, []));
  usePaneChromeActions(
    useMemo(
      () => (
        <>
          {rightActions}
          {toggle}
        </>
      ),
      [open, rightActions]
    ),
    { zone: 'right' }
  );

  const body = (
    <div className={styles.panelBody} data-testid="properties-panel-body">
      <OpenInSidebarButton className={styles.openInSidebar} />
      {panel}
    </div>
  );

  const portaled =
    slot && (topbarActions || badge)
      ? createPortal(
          <>
            {topbarActions}
            {badge}
          </>,
          slot
        )
      : null;

  return (
    <div ref={shellRef} className={cn(styles.shell, className)} data-narrow={isNarrow || undefined}>
      {inPane ? (
        portaled
      ) : (
        <div className={styles.strip} data-testid="properties-strip">
          {topbarActions}
          {badge}
          {rightActions}
          {toggle}
        </div>
      )}
      {open && isNarrow && (
        <section className={styles.topDrawer} style={drawerStyle} aria-label={ariaLabel}>
          {body}
          <div
            className={styles.drawerHandle}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize properties panel"
            {...drawerHandle}
          />
        </section>
      )}
      <div className={styles.row}>
        <div className={styles.content}>{children}</div>
        {open && !isNarrow && (
          <section className={styles.sidebar} style={sidebarStyle} aria-label={ariaLabel}>
            <div
              className={styles.sidebarHandle}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize properties panel"
              {...sidebarHandle}
            />
            {body}
          </section>
        )}
      </div>
    </div>
  );
};

/** One labeled group inside the panel (Info, Tags, Folder…). */
export const PropertiesGroup: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <div className={styles.group}>
    <div className={styles.groupLabel}>{label}</div>
    {children}
  </div>
);
