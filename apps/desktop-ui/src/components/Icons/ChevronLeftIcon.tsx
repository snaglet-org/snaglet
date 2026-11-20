import { type FC, type SVGProps } from 'react';

/** Left chevron: back / previous (Bootstrap Icons `chevron-left`). 14×14 by default. */
export const ChevronLeftIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
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
      d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0"
    />
  </svg>
);
