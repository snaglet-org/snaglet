import type { SVGProps } from 'react';

/**
 * Small single-color glyphs used by the Table views (field-type marker, undo
 * / redo buttons), from Bootstrap Icons. 14px, `currentColor`, no strokes, so
 * they tint with the pane-chrome button family.
 */

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 16 16',
  width: 14,
  height: 14,
  fill: 'currentColor',
  'aria-hidden': true,
  focusable: 'false',
} as const;

/** Text field — a serif "T" (Bootstrap Icons `fonts`). */
export function TextToolIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12.258 3h-8.51l-.083 2.46h.479c.26-1.544.758-1.783 2.693-1.845l.424-.013v7.827c0 .663-.144.82-1.3.923v.52h4.082v-.52c-1.162-.103-1.306-.26-1.306-.923V3.602l.431.013c1.934.062 2.434.301 2.693 1.846h.479z" />
    </svg>
  );
}

/** Redo — an arrow turning clockwise (Bootstrap Icons `arrow-clockwise`). */
export function RedoArrowIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path fillRule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z" />
      <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466" />
    </svg>
  );
}

/** Undo — the arrow turning back counterclockwise (Bootstrap Icons `arrow-counterclockwise`). */
export function UndoArrowIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path fillRule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2z" />
      <path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466" />
    </svg>
  );
}
