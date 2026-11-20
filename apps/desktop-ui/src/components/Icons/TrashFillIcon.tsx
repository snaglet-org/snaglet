import { type FC } from 'react';

/**
 * Filled trash-can glyph used by the archive drop-zone. Inherits color
 * via `currentColor` so the surrounding button drives the tint (idle
 * vs hover vs drag-hover all flow through CSS). Bootstrap Icons
 * `trash-fill`.
 */
export const TrashFillIcon: FC = () => (
  <svg viewBox="0 0 16 16" width={20} height={20} fill="currentColor" aria-hidden focusable="false">
    <path d="M2.5 1a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1H3v9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V4h.5a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1zm3 4a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5M8 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7A.5.5 0 0 1 8 5m3 .5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 1 0" />
  </svg>
);
