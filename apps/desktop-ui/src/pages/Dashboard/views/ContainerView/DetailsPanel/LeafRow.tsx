import { useState, type FC, type ReactNode } from 'react';
import { LeafToggle } from '@desktop/components/Icons';
import styles from './LeafRow.module.scss';

export interface LeafRowProps {
  /** Row label, e.g. "Description" or "How project embeddings work". */
  label: ReactNode;
  /** Optional inline extras rendered after the label (e.g. a save hint). */
  trailing?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * LeafRow — a collapsed details/leaf disclosure for the project panel.
 *
 * Keeps the default project view compact: Description, the embeddings
 * explainer, and the indexing rules all collapse behind one-line rows and
 * mount their content only when opened. Deliberately NOT persisted —
 * collapsed is the default every time a pane opens (matches useDisclosure's
 * philosophy for the properties panels).
 */
export const LeafRow: FC<LeafRowProps> = ({ label, trailing, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.leafRow} data-open={open || undefined}>
      <button
        type="button"
        className={styles.leafToggle}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {/*
          The shared leaf glyph, not a text chevron — this is the app's
          disclosure mark everywhere else (PropertiesDisclosureHeader,
          PaneHistoryNav, the workspace tree), and it carries its own
          open/closed animation.
        */}
        <LeafToggle open={open} className={styles.leafGlyph} />
        <span className={styles.leafLabel}>{label}</span>
        {trailing != null && <span className={styles.leafTrailing}>{trailing}</span>}
      </button>
      {open && <div className={styles.leafBody}>{children}</div>}
    </div>
  );
};
