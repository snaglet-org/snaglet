import type { FC } from 'react';
import { Section, Segmented } from '@desktop/components';
import {
  THREAD_TEXT_SIZES,
  THREAD_TEXT_SIZE_LABELS,
  isThreadTextSize,
  setThreadTextSize,
  useThreadTextSize,
} from '../threadTextSize';
import { InfoHint } from './InfoHint';
import styles from './ChatSettings.module.scss';

interface TextSizeSectionProps {
  threadId: string;
}

/**
 * Text size — how large this thread's messages read, in the General tab.
 * Applies live to the open chat. A per-device view preference (see
 * threadTextSize.ts): other threads, other devices and the agents are
 * unaffected.
 */
export const TextSizeSection: FC<TextSizeSectionProps> = ({ threadId }) => {
  const size = useThreadTextSize(threadId);
  return (
    <Section
      label={
        <span className={styles.labelWithHint}>
          Text size
          <InfoHint
            topic="the thread's text size"
            text="How large this thread's messages and composer read on this device. Other threads keep their own size."
          />
        </span>
      }
    >
      <Segmented
        size="sm"
        className={styles.textSizeGroup}
        aria-label="Text size"
        value={size}
        onChange={(next) => {
          if (isThreadTextSize(next)) setThreadTextSize(threadId, next);
        }}
      >
        {THREAD_TEXT_SIZES.map((option) => (
          <Segmented.Option key={option} value={option}>
            {THREAD_TEXT_SIZE_LABELS[option]}
          </Segmented.Option>
        ))}
      </Segmented>
    </Section>
  );
};
