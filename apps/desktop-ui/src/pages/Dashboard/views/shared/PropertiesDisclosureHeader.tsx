import { type FC, type ReactNode } from 'react';
import { LeafToggle } from '@desktop/components/Icons';
import styles from './NodeProperties.module.scss';

interface PropertiesDisclosureHeaderProps {
  /** Whether the panel body is expanded — drives `aria-expanded` and the leaf glyph rotation. */
  expanded: boolean;
  /** Toggle the panel open/closed. */
  onToggle: () => void;
  /** Disclosure label. Defaults to "Properties". */
  label?: string;
  /**
   * Trailing header content rendered after the toggle button, inside the same
   * `.header` row (e.g. the doc panel's type badge, header-controls slot, and
   * save-status chip). ContainerProperties passes none.
   */
  children?: ReactNode;
}

/**
 * The single shared disclosure header for Properties-style panels. The
 * LeafToggle glyph, mono label, spacing, and interaction stay pixel-identical;
 * only the label and trailing controls differ.
 */
export const PropertiesDisclosureHeader: FC<PropertiesDisclosureHeaderProps> = ({
  expanded,
  onToggle,
  label = 'Properties',
  children,
}) => (
  <div className={styles.header}>
    <button type="button" className={styles.headerBtn} onClick={onToggle} aria-expanded={expanded}>
      <LeafToggle open={expanded} className={styles.headerLeaf} />
      <span className={styles.title}>{label}</span>
    </button>
    {children}
  </div>
);
