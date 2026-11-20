import { useState, type ReactNode } from 'react';
import styles from './ContainerView.module.scss';

/** Rows a section lists before it folds the rest behind "Show all". */
export const PROJECT_SECTION_PREVIEW = 8;

interface ProjectPaneSectionProps<T> {
  /** Section name — also the accessible heading. */
  title: string;
  /** Everything the section lists, in display order; `null` while unknown
   *  (no count, shows `empty`). */
  items: readonly T[] | null;
  /** Shown instead of the list when `items` is empty or unknown. */
  empty: string;
  /** Rows that stay on screen while the section is folded, e.g. the row
   *  being renamed. */
  keepVisible?: (item: T) => boolean;
  /** Renders the rows currently on screen. */
  children: (visible: readonly T[]) => ReactNode;
}

/**
 * ProjectPaneSection — one labeled block of the project pane (Contents,
 * Threads, Tables). The project pane is three simple sections stacked in one
 * scroll body; this supplies the shared header + empty-line chrome so they
 * read as one list family. A long section shows its first
 * PROJECT_SECTION_PREVIEW rows and a "Show all N" toggle, so one busy list
 * doesn't push the others out of view.
 */
export function ProjectPaneSection<T>({
  title,
  items,
  empty,
  keepVisible,
  children,
}: ProjectPaneSectionProps<T>) {
  const [expanded, setExpanded] = useState(false);
  const folds = items !== null && items.length > PROJECT_SECTION_PREVIEW;
  const visible =
    items && folds && !expanded
      ? items.filter((item, i) => i < PROJECT_SECTION_PREVIEW || keepVisible?.(item))
      : items;

  return (
    <section className={styles.section} aria-label={title}>
      <header className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {items && <span className={styles.sectionCount}>{items.length}</span>}
      </header>
      {visible && visible.length > 0 ? (
        children(visible)
      ) : (
        <p className={styles.sectionEmpty}>{empty}</p>
      )}
      {folds && (
        <button
          type="button"
          className={styles.sectionMore}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}
