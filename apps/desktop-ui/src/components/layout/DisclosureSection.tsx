import { useId, useState, type ReactNode } from 'react';
import { LeafToggle } from '@desktop/components/Icons';
import styles from './layout.module.scss';

export interface DisclosureSectionProps {
  /** Primary label announced by the disclosure button. */
  label: ReactNode;
  /** Quiet state or summary that remains visible while collapsed. */
  summary?: ReactNode;
  /** Controls that must remain reachable whether the body is open or closed. */
  actions?: ReactNode;
  /** Compact content that remains visible below the header in both states. */
  preview?: ReactNode;
  /** Disclosure bodies are collapsed by default. */
  defaultOpen?: boolean;
  className?: string;
  previewClassName?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * Settings-card disclosure using Snaglet's shared leaf glyph and section surface.
 * Header actions sit outside the toggle so they stay independently keyboard
 * accessible in both disclosure states.
 */
export const DisclosureSection = ({
  label,
  summary,
  actions,
  preview,
  defaultOpen = false,
  className,
  previewClassName,
  bodyClassName,
  children,
}: DisclosureSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const accessibleLabel =
    typeof label === 'string'
      ? `${label}${typeof summary === 'string' ? `, ${summary}` : ''}`
      : undefined;

  return (
    <section
      className={`${styles.section} ${styles.disclosureSection} ${className ?? ''}`}
      data-open={open || undefined}
    >
      <div className={styles.disclosureHead}>
        <button
          type="button"
          className={styles.disclosureToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={accessibleLabel}
          onClick={() => setOpen((value) => !value)}
        >
          <LeafToggle open={open} className={styles.disclosureLeaf} />
          <span className={styles.disclosureLabel}>{label}</span>
          {summary != null && <span className={styles.disclosureSummary}>{summary}</span>}
        </button>
        {actions != null && <div className={styles.disclosureActions}>{actions}</div>}
      </div>
      {preview != null && (
        <div className={`${styles.disclosurePreview} ${previewClassName ?? ''}`}>{preview}</div>
      )}
      {open && (
        <div id={bodyId} className={`${styles.disclosureBody} ${bodyClassName ?? ''}`}>
          {children}
        </div>
      )}
    </section>
  );
};
