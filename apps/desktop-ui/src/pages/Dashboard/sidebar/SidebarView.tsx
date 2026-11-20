import { type FC, type ReactNode } from 'react';
import styles from './SidebarView.module.scss';

interface SidebarViewProps {
  /** Display title rendered in the sticky view header. */
  title: string;
  /** Optional action buttons (eg. "+", view-mode toggles) for the header. */
  actions?: ReactNode;
  /** The view's primary content — typically a tree or list. */
  children: ReactNode;
}

/**
 * SidebarView — shared chrome for every sidebar view (Library, Agents,
 * …). Renders a title bar with optional actions on the right, plus a
 * scrollable body region. Individual views (LibraryView, AgentsView)
 * compose this with their specific tree / list content.
 */
export const SidebarView: FC<SidebarViewProps> = ({ title, actions, children }) => (
  <section className={styles.root} aria-label={title}>
    <header className={styles.header}>
      <span className={styles.title}>{title}</span>
      {actions && <span className={styles.actions}>{actions}</span>}
    </header>
    <div className={styles.body}>{children}</div>
  </section>
);
