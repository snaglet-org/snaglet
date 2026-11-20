import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type TextareaHTMLAttributes,
} from 'react';
import clsx from 'clsx';

import { highlightMarkdownSource, type SourceLine } from './sourceHighlight';
import styles from './WorkspaceEditor.module.scss';

const SPAN_CLASS: Record<string, string | undefined> = {
  marker: styles.hlMarker,
  bold: styles.hlBold,
  italic: styles.hlItalic,
  strike: styles.hlStrike,
  code: styles.hlCode,
  link: styles.hlLink,
  url: styles.hlUrl,
};

const LINE_CLASS: Record<SourceLine['kind'], string | undefined> = {
  text: undefined,
  heading: styles.hlHeading,
  list: styles.hlList,
  quote: styles.hlQuote,
  fence: styles.hlFence,
  code: styles.hlCodeLine,
  rule: styles.hlRule,
};

/** The styled backdrop text of source line `line` (0-based), or null when it is not rendered. */
function sourceLineSpan(area: HTMLTextAreaElement, line: number): HTMLElement | null {
  const backdrop = area.parentElement?.querySelector<HTMLElement>('[data-source-backdrop]');
  // Each line's span starts with the previous line's newline; its first
  // styled child starts the line itself.
  return backdrop?.querySelector<HTMLElement>(`[data-source-line="${line}"] > span`) ?? null;
}

/**
 * Top of source line `line` (0-based) in the textarea's content, wrapping
 * included, read off the styled backdrop; null when it is not rendered.
 */
export function sourceLineTop(area: HTMLTextAreaElement, line: number): number | null {
  return sourceLineSpan(area, line)?.offsetTop ?? null;
}

const flashTimers = new WeakMap<HTMLElement, number>();

/**
 * Flash source line `line` (0-based) for `ms` on the backdrop, which shows
 * through the transparent textarea. A data attribute, not a class: React
 * owns the span's class and leaves an attribute it does not render alone.
 */
export function flashSourceLine(area: HTMLTextAreaElement, line: number, ms: number): void {
  const span = sourceLineSpan(area, line);
  if (!span) return;
  window.clearTimeout(flashTimers.get(span));
  span.removeAttribute('data-line-flash');
  // Reading layout restarts the animation when the same line flashes again.
  void span.offsetWidth;
  span.setAttribute('data-line-flash', '');
  flashTimers.set(
    span,
    window.setTimeout(() => span.removeAttribute('data-line-flash'), ms)
  );
}

type SourceMarkdownAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  value: string;
};

/**
 * The raw markdown textarea with live-preview styling: a styled copy of the
 * text (headings by level, list and quote markers, bold, italic, code, links,
 * fences) is drawn behind a textarea whose own glyphs are transparent. The
 * value stays plain markdown, and the textarea keeps native editing, find and
 * line links. Both layers share one monospace face, size and line height,
 * and every style keeps glyph widths, so the layers line up.
 */
export const SourceMarkdownArea = forwardRef<HTMLTextAreaElement, SourceMarkdownAreaProps>(
  function SourceMarkdownArea({ value, className, onScroll, ...rest }, ref) {
    const areaRef = useRef<HTMLTextAreaElement | null>(null);
    const backdropRef = useRef<HTMLDivElement>(null);
    const lines = useMemo(() => highlightMarkdownSource(value), [value]);

    const setAreaRef = useCallback(
      (el: HTMLTextAreaElement | null) => {
        areaRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      },
      [ref]
    );

    const sync = useCallback(() => {
      const area = areaRef.current;
      const backdrop = backdropRef.current;
      if (!area || !backdrop) return;
      // The textarea's client box leaves out its scrollbar; match it so lines
      // wrap at the same width.
      backdrop.style.width = `${area.clientWidth}px`;
      backdrop.style.height = `${area.clientHeight}px`;
      backdrop.scrollTop = area.scrollTop;
      backdrop.scrollLeft = area.scrollLeft;
    }, []);

    useLayoutEffect(sync, [sync, value]);
    useLayoutEffect(() => {
      const area = areaRef.current;
      if (!area || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(sync);
      observer.observe(area);
      return () => observer.disconnect();
    }, [sync]);

    return (
      <div className={styles.sourceStack}>
        <div
          ref={backdropRef}
          className={styles.sourceBackdrop}
          aria-hidden="true"
          data-source-backdrop=""
          data-testid="workspace-editor-source-highlight"
        >
          {/* Lines and spans are plain text, keyed by position. */}
          {lines.map((line, i) => (
            <span key={i} data-source-line={i}>
              {i > 0 ? '\n' : null}
              <span
                className={LINE_CLASS[line.kind]}
                data-line-kind={line.kind}
                data-level={line.level}
              >
                {line.spans.map((span, j) => (
                  <span key={j} className={SPAN_CLASS[span.kind]}>
                    {span.text}
                  </span>
                ))}
              </span>
            </span>
          ))}
          {/* A trailing newline still takes a line in the textarea. */}
          {value.endsWith('\n') ? '​' : null}
        </div>
        <textarea
          {...rest}
          ref={setAreaRef}
          value={value}
          className={clsx(styles.sourceArea, className)}
          onScroll={(event) => {
            sync();
            onScroll?.(event);
          }}
        />
      </div>
    );
  }
);
