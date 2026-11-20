import { useRef, type FC, type ReactNode } from 'react';
import { useOverlayFillHeight } from '@desktop/pages/Dashboard/hooks/useOverlayFillHeight';
import { PropertiesDisclosureHeader } from './PropertiesDisclosureHeader';
import styles from './NodeProperties.module.scss';

interface PropertiesDisclosureProps {
  /** Accessible name for the complete properties panel. */
  ariaLabel: string;
  /** Whether the panel body is visible. */
  expanded: boolean;
  /** Toggle the panel body open or closed. */
  onToggle: () => void;
  /** Disclosure label. Defaults to "Properties". */
  label?: string;
  /** Compact controls or metadata placed after the disclosure button. */
  header?: ReactNode;
  /** Property fields shown in the body. */
  children: ReactNode;
  /** Pane-specific body styling without duplicating the panel chrome. */
  bodyClassName?: string;
  /** Pane-specific section styling without duplicating the panel structure. */
  sectionClassName?: string;
  /**
   * Adds the standard pane inset used by container, document, and media views.
   * Embedded disclosures can opt out when their parent already owns spacing.
   */
  inset?: boolean;
  /**
   * Float the expanded body over the pane content. This is the default for
   * Properties dropdowns so opening one never shifts the content underneath.
   */
  overlay?: boolean;
}

/**
 * Shared Properties disclosure shell.
 *
 * Owns the interaction and layout rules that must stay identical between
 * panes: inset spacing, header chrome, opaque overlay surface, and the
 * viewport-aware body height. Callers supply only header controls and fields.
 */
export const PropertiesDisclosure: FC<PropertiesDisclosureProps> = ({
  ariaLabel,
  expanded,
  onToggle,
  label = 'Properties',
  header,
  children,
  bodyClassName,
  sectionClassName,
  inset = true,
  overlay = true,
}) => {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const overlayMaxHeight = useOverlayFillHeight(bodyRef, expanded && overlay);
  const section = (
    <section
      className={[styles.section, overlay ? styles.overlayAnchor : '', sectionClassName ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-label={ariaLabel}
    >
      <PropertiesDisclosureHeader expanded={expanded} onToggle={onToggle} label={label}>
        {header}
      </PropertiesDisclosureHeader>

      {expanded && (
        <div
          ref={bodyRef}
          className={[styles.body, overlay ? styles.overlayBody : '', bodyClassName ?? '']
            .filter(Boolean)
            .join(' ')}
          style={overlay && overlayMaxHeight != null ? { maxHeight: overlayMaxHeight } : undefined}
        >
          {children}
        </div>
      )}
    </section>
  );

  return inset ? <div className={styles.host}>{section}</div> : section;
};
