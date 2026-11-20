import type { FC } from 'react';

import styles from './MarkdownTextToggle.module.scss';

type MarkdownTextToggleSide = 'left' | 'right';
type MarkdownTextToggleSize = 'xs' | 'sm';
type MarkdownTextToggleChrome = 'bordered' | 'plain' | 'pill';
type MarkdownTextToggleFont = 'inherit' | 'mono';

export interface MarkdownTextToggleProps {
  /** Which side is currently selected. */
  activeSide: MarkdownTextToggleSide;
  /** Left-hand label, e.g. `md`, `rendered`, or `edit`. */
  leftLabel: string;
  /** Right-hand label, e.g. `txt`, `md`, or `preview`. */
  rightLabel: string;
  /** Toggle to the other mode. */
  onToggle: () => void;
  /** Native button title. */
  title?: string;
  /** Disable the toggle while preserving the visual state. */
  disabled?: boolean;
  /** Optional test id for callers that already assert this control. */
  testId?: string;
  /** Size preset. `xs` matches compact strip/source-peek controls. */
  size?: MarkdownTextToggleSize;
  /**
   * Visual chrome. `pill` is the canonical toolbar treatment (compact
   * field-tinted control, active side lit with the selected surface) shared
   * by the chat render-mode and doc source toggles; `plain` is for small
   * read-only preview rows; `bordered` is a square chip for popovers.
   */
  chrome?: MarkdownTextToggleChrome;
  /** Font treatment. Chat strip inherits uppercase letter spacing from its parent. */
  font?: MarkdownTextToggleFont;
  /** Optional additional class for layout tweaks. */
  className?: string;
  /** Override aria-pressed when the caller has an existing semantic. */
  ariaPressed?: boolean;
}

/**
 * Shared two-state toggle for markdown/text-style display controls.
 *
 * Used by chat render mode, markdown source previews, and editor source
 * toggles so every surface gets the same active-side/slash treatment instead
 * of each feature hand-rolling `md / txt` or `rendered / md` chrome.
 */
export const MarkdownTextToggle: FC<MarkdownTextToggleProps> = ({
  activeSide,
  leftLabel,
  rightLabel,
  onToggle,
  title,
  disabled = false,
  testId,
  size = 'sm',
  chrome = 'bordered',
  font = 'mono',
  className,
  ariaPressed,
}) => {
  return (
    <button
      type="button"
      className={[styles.toggle, className].filter(Boolean).join(' ')}
      onClick={onToggle}
      onMouseDown={(e) => e.preventDefault()}
      title={title}
      disabled={disabled}
      aria-pressed={ariaPressed ?? activeSide === 'right'}
      data-size={size}
      data-chrome={chrome}
      data-font={font}
      data-testid={testId}
    >
      <span className={activeSide === 'left' ? `${styles.side} ${styles.active}` : styles.side}>
        {leftLabel}
      </span>
      <span className={styles.slash}>/</span>
      <span className={activeSide === 'right' ? `${styles.side} ${styles.active}` : styles.side}>
        {rightLabel}
      </span>
    </button>
  );
};
