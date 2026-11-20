import { type FC, type SVGProps } from 'react';

/** Right chevron: forward / next (Bootstrap Icons `chevron-right`). 14×14 by default. */
export const ChevronRightIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 16 16"
    width={14}
    height={14}
    fill="currentColor"
    aria-hidden
    focusable="false"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708"
    />
  </svg>
);
