import { Checkbox } from '../controls';
import { cn } from '@desktop/utils/classNames';
import styles from './SearchModeControl.module.scss';

export interface SearchChannels {
  keyword: boolean;
  vector: boolean;
}

export const DEFAULT_SEARCH_CHANNELS: SearchChannels = {
  keyword: true,
  vector: true,
};

export interface SearchModeControlProps {
  value: SearchChannels;
  onChange: (next: SearchChannels) => void;
  className?: string;
  /** Short context included in the accessible group label. */
  context?: string;
}

/**
 * Compact, per-query channel picker shared by every interactive search surface.
 * At least one channel stays enabled so the UI never has to invent a "none"
 * backend mode or leave a typed query looking broken.
 */
export function SearchModeControl({
  value,
  onChange,
  className,
  context = 'search',
}: SearchModeControlProps) {
  const keyword = Boolean(value.keyword);
  const vector = Boolean(value.vector);

  const toggle = (channel: keyof SearchChannels, enabled: boolean) => {
    const next = { ...value, [channel]: enabled };
    if (!next.keyword && !next.vector) return;
    onChange(next);
  };

  return (
    <fieldset className={cn(styles.root, className)} aria-label={`Search methods for ${context}`}>
      <legend className={styles.legend}>Search with</legend>
      <Checkbox
        size="sm"
        checked={keyword}
        disabled={keyword && !vector}
        onChange={(enabled) => toggle('keyword', enabled)}
        className={styles.option}
        title="Match exact words and titles"
      >
        Keyword
      </Checkbox>
      <span className={styles.divider} aria-hidden="true" />
      <Checkbox
        size="sm"
        checked={vector}
        disabled={vector && !keyword}
        onChange={(enabled) => toggle('vector', enabled)}
        className={styles.option}
        title="Match meaning with local embeddings"
      >
        Vector
      </Checkbox>
    </fieldset>
  );
}
