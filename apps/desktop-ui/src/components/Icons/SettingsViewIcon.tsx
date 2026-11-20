import { type FC } from 'react';

/**
 * Activity-bar glyph for the Settings view — a flower that reads as a cog:
 * eight petals double as gear teeth around a solid ring with a center hole
 * (the gear bore). Solid `currentColor` silhouette to match the plant icon
 * family (tree, trowel, hanging monkey).
 */
export const SettingsViewIcon: FC = () => (
  <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" aria-hidden focusable="false">
    <ellipse cx="12" cy="4.9" rx="2.3" ry="3.4" />
    <ellipse cx="12" cy="4.9" rx="2.3" ry="3.4" transform="rotate(45 12 12)" />
    <ellipse cx="12" cy="4.9" rx="2.3" ry="3.4" transform="rotate(90 12 12)" />
    <ellipse cx="12" cy="4.9" rx="2.3" ry="3.4" transform="rotate(135 12 12)" />
    <ellipse cx="12" cy="4.9" rx="2.3" ry="3.4" transform="rotate(180 12 12)" />
    <ellipse cx="12" cy="4.9" rx="2.3" ry="3.4" transform="rotate(225 12 12)" />
    <ellipse cx="12" cy="4.9" rx="2.3" ry="3.4" transform="rotate(270 12 12)" />
    <ellipse cx="12" cy="4.9" rx="2.3" ry="3.4" transform="rotate(315 12 12)" />
    <path
      fillRule="evenodd"
      d="M12 5.9a6.1 6.1 0 1 0 0 12.2 6.1 6.1 0 0 0 0-12.2Zm0 3.9a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z"
    />
  </svg>
);
