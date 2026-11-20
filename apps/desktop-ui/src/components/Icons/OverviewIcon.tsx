import { type FC, type SVGProps } from 'react';

/**
 * A panel at the right: shows or hides a side strip, such as the Calendar's
 * overview (Bootstrap Icons `layout-sidebar-inset-reverse`). 14×14 by default.
 */
export const OverviewIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 16 16"
    width={14}
    height={14}
    fill="currentColor"
    aria-hidden
    focusable="false"
    {...props}
  >
    <path d="M2 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zm12-1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" />
    <path d="M13 4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z" />
  </svg>
);
