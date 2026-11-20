import { type FC, type SVGProps } from 'react';

/**
 * Magnifying-glass glyph for search fields (Bootstrap Icons `search`). 14×14
 * by default; callers pass `className`, `width` / `height` to fit their field.
 */
export const SearchIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 16 16"
    width={14}
    height={14}
    fill="currentColor"
    aria-hidden
    focusable="false"
    {...props}
  >
    <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0" />
  </svg>
);
