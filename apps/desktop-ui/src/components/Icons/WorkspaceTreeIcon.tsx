import { type FC } from 'react';

/**
 * Activity-bar glyph for the Library/workspace-tree view: a tree. One rounded
 * canopy outline over a trunk that forks twice inside it, standing on a short
 * ground line. Three shapes read as a tree at the rail's 20px where a cluster
 * of small outlines turns to noise, and every gap is wider than the stroke so
 * the lines stay apart on a non-retina display. 24 grid, `currentColor` strokes
 * like the other rail glyphs, so the activity bar controls the active and hover
 * states in both themes.
 */
export const WorkspaceTreeIcon: FC = () => (
  <svg
    viewBox="0 0 24 24"
    width={20}
    height={20}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
    data-icon="workspace"
  >
    <path d="M7.6 15.6C4.8 15.6 3 13.6 3 11.4c0-2 1.4-3.5 3.2-3.8C6.5 4.9 8.9 3 12 3s5.5 1.9 5.8 4.6c1.8.3 3.2 1.8 3.2 3.8 0 2.2-1.8 4.2-4.6 4.2Z" />
    <path d="M12 21.5V10.5M12 15l-3-3M12 13l2.8-2.8M8.5 21.5h7" />
  </svg>
);
