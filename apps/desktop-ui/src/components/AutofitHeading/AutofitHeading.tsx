import { createElement, useRef, type FC, type JSX, type ReactNode } from 'react';
import { useAutofitText, type AlignX, type AlignY, type WrapOption } from 'autofit-text';
import { TYPE_SCALE } from '@desktop/styles/typeScale';

/**
 * Autofit bound presets. Bounds come from TYPE_SCALE only, never
 * raw numbers, so the fit floor tracks the shared type scale.
 *  - `hero`   — big empty-state / profile headings (18–38px)
 *  - `title`  — pane-chrome / empty-state titles (12–17px)
 *  - `header` — view header strips (13–22px)
 */
const BOUNDS = {
  hero: { min: TYPE_SCALE.heroMin, max: TYPE_SCALE.heroMax },
  title: { min: TYPE_SCALE.titleMin, max: TYPE_SCALE.titleMax },
  header: { min: TYPE_SCALE.headerMin, max: TYPE_SCALE.headerMax },
} as const;

export type AutofitHeadingVariant = keyof typeof BOUNDS;

export interface AutofitHeadingProps {
  children: ReactNode;
  /** Bound preset; picks [min,max] from TYPE_SCALE. Default `title`. */
  variant?: AutofitHeadingVariant;
  /** Inner text element tag (default `span`). Use `h1`/`h2` for semantics. */
  as?: keyof JSX.IntrinsicElements;
  /** Class for the inner text element (carries font-family / weight / color). */
  className?: string;
  /** Class for the outer measuring box (defaults to full-width block). */
  boxClassName?: string;
  /** Wrapping behavior forwarded to autofit-text (default: never wrap). */
  wrap?: WrapOption;
  /**
   * Opt into hook-controlled horizontal placement. Omit (default) to keep
   * the text in normal flow so your own CSS (`text-align`) positions it —
   * the right choice for centered empty states.
   */
  alignX?: AlignX;
  /** Opt into hook-controlled vertical placement. Omit to stay in flow. */
  alignY?: AlignY;
  /** Native title attribute (hover tooltip for truncation-prone headings). */
  title?: string;
}

/**
 * A heading that fits its text to its box, shrinking (down to the
 * TYPE_SCALE floor) before it truncates — the same autofit pattern
 * PathHeader / AgentView use, packaged for the remaining fit-to-box
 * hotspots (view headers, empty-state titles, big stat numbers).
 *
 * Keep it out of virtualized or long lists (tree rows, chat messages): a
 * ResizeObserver per row is a perf trap. Those scale with the pane's fluid
 * zoom instead.
 *
 * Renders `<span box><as text/></span>`: the box is measured, the inner
 * element holds the text and receives the fitted font-size. Font family,
 * weight and color inherit from `className` on the inner element.
 */
export const AutofitHeading: FC<AutofitHeadingProps> = ({
  children,
  variant = 'title',
  as = 'span',
  className,
  boxClassName,
  wrap = false,
  alignX,
  alignY,
  title,
}) => {
  const boxRef = useRef<HTMLElement | null>(null);
  const textRef = useRef<HTMLElement | null>(null);
  const { min, max } = BOUNDS[variant];

  useAutofitText(
    textRef,
    boxRef,
    {
      wrap,
      minFontSize: min,
      maxFontSize: max,
      ...(alignX ? { alignX } : {}),
      ...(alignY ? { alignY } : {}),
    },
    [children]
  );

  return createElement(
    'span',
    {
      ref: boxRef,
      className: boxClassName,
      // The box fills its parent's inline space so the fit has a width to
      // measure against; block so it doesn't collapse to content width.
      style: { display: 'block', width: '100%', minWidth: 0 },
    },
    createElement(as, { ref: textRef, className, title }, children)
  );
};
