import { type FC } from 'react';
import type { HubWorkspaceLink } from './hubTypes';
import styles from './HubView.module.scss';

export interface WorkspaceStripProps {
  links: HubWorkspaceLink[];
}

/**
 * One quiet row of links at the foot of Home: the settings that keep their
 * own panes, so nothing Home replaced is out of reach.
 */
export const WorkspaceStrip: FC<WorkspaceStripProps> = ({ links }) => (
  <footer className={styles.strip}>
    <nav aria-label="Workspace settings">
      <ul className={styles.stripLinks}>
        {links.map((link) => (
          <li key={link.id}>
            <button
              type="button"
              className={styles.stripLink}
              onClick={link.onOpen}
              title={link.description}
            >
              <span className={styles.stripGlyph} aria-hidden>
                {link.icon}
              </span>
              {link.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  </footer>
);
