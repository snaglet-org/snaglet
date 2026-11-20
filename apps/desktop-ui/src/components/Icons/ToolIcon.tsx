import { type FC } from 'react';

/**
 * Shared tool-node glyph: a garden shovel tipped 45° (blade at the lower left,
 * D-handle at the upper right). Drawn upright on the 24 grid, then rotated
 * about the center. Outline icon family conventions (`currentColor` strokes
 * 1.6 wide, round caps and joins), with a solid blade so it reads as a shovel
 * at 16px. Decorative: the caller owns the accessible label.
 */
export const ToolIcon: FC<{ size?: number }> = ({ size = 18 }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
    data-icon="tool"
  >
    <g transform="rotate(45 12 12)">
      {/* D-handle: flat grip on top, sides meeting at the shaft */}
      <path d="M12 6.3C10.2 5.3 9 3.7 9 1.3h6c0 2.4-1.2 4-3 5Z" />
      {/* Shaft */}
      <path d="M12 6.3v8" />
      {/* Blade: shoulders, straight sides, rounded point */}
      <path
        fill="currentColor"
        d="M7.6 15.1Q12 13.7 16.4 15.1v3.6c0 2.7-1.9 4.9-4.4 6.4-2.5-1.5-4.4-3.7-4.4-6.4Z"
      />
    </g>
  </svg>
);
