import { type FC } from 'react';

export interface LeafToggleProps {
  open: boolean;
  /**
   * Optional className passed onto the root `<svg>`. Callers (eg. LibraryTree)
   * use this to drive size, color, and the open/closed rotation transform
   * via their own CSS module.
   */
  className?: string;
}

/**
 * Expand/collapse affordance using a kawaii leaf glyph. The artwork's
 * natural orientation is vertical (tip up, stem down); callers typically
 * rotate via CSS — 90° closed (tip points right, like ▸) and 180° open
 * (tip points down, like ▾).
 *
 * `data-open` is rendered on the root so consumers can target the open
 * state with `[data-open='true']` selectors without re-rendering.
 */
export const LeafToggle: FC<LeafToggleProps> = ({ open, className }) => (
  <svg
    className={className}
    data-open={open ? 'true' : 'false'}
    viewBox="0 0 512 512"
    width={16}
    height={16}
    fill="currentColor"
    aria-hidden
    focusable="false"
  >
    <path d="M376.749,131.123L275.385,232.487v48.558l118.263-118.263C388.472,152.017,382.777,141.428,376.749,131.123z" />
    <path d="M409.547,201.712L275.385,335.873v90.992c81.752-9.524,145.386-78.494,145.386-161.903C420.771,244.24,416.558,222.896,409.547,201.712z" />
    <path d="M99.744,210.429c-5.364,18.306-8.515,36.65-8.515,54.532c0,83.409,63.634,152.38,145.386,161.903V336.35L99.744,210.429z" />
    <path d="M275.385,0v177.659l80.07-80.07C323.481,50.833,289.007,13.96,275.385,0z" />
    <path d="M135.251,131.123c-7.6,12.994-14.678,26.437-20.843,40.116l122.207,112.429v-51.181L135.251,131.123z" />
    <path d="M156.545,97.59l80.07,80.07V0C222.992,13.96,188.519,50.833,156.545,97.59z" />
    <path d="M256,427.999c-6.559,0-13.025-0.393-19.385-1.133v7.595V512h38.77v-77.539v-7.595C269.025,427.606,262.559,427.999,256,427.999z" />
  </svg>
);
