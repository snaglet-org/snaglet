import type { FC } from 'react';
import { HelpTooltip } from '@desktop/components';

interface InfoHintProps {
  /** The detail relocated out of inline prose; shown on hover and keyboard focus. */
  text: string;
  /**
   * What the help is about, e.g. "max dispatch waves". Names the trigger
   * "About max dispatch waves" so a screen reader hears a short label and then
   * the tooltip text as its description, instead of the full text twice.
   */
  topic?: string;
  className?: string;
}

/**
 * A muted `?` glyph backed by the shared accessible Tooltip. It opens on hover
 * and keyboard focus, closes on Escape/blur, and remains in the tab order.
 */
export const InfoHint: FC<InfoHintProps> = ({ text, topic, className }) => (
  <HelpTooltip
    label={text}
    ariaLabel={topic ? `About ${topic}` : text}
    side="left"
    className={className}
  />
);
