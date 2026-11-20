import { useId, type FC } from 'react';
import { BOX_PATH } from './BoxIcon';

// Five-point star centered at (52, 12) on the 64-unit grid, outer radius 12.
const STAR =
  '52,0 54.94,7.96 63.41,8.29 56.76,13.55 59.05,21.71 52,17 44.95,21.71 47.24,13.55 40.59,8.29 49.06,7.96';

/**
 * Project icon: the container `BoxIcon` (Bootstrap Icons `box-seam-fill`,
 * scaled from its 16-unit grid), a little smaller, with a star floating off
 * its top-right corner. A mask cuts a thin gap into the box around the star
 * so the two read as separate shapes at 14px. Same size and `currentColor`
 * fill as `BoxIcon`, so it drops in wherever a project container is drawn.
 */
export const ProjectIcon: FC = () => {
  // useId's output has characters url(#…) references can trip on; keep word chars.
  const maskId = `project-icon-gap-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <mask id={maskId}>
        <rect width="64" height="64" fill="white" />
        <polygon points={STAR} fill="black" stroke="black" strokeWidth={8} strokeLinejoin="round" />
      </mask>
      {/* The mask sits on an untransformed group so its star lines up with
          the drawn star; only the box inside is scaled down. */}
      <g mask={`url(#${maskId})`}>
        <g transform="translate(0 12.8) scale(3.2)">
          <path fillRule="evenodd" d={BOX_PATH} />
        </g>
      </g>
      <polygon points={STAR} strokeLinejoin="round" />
    </svg>
  );
};
