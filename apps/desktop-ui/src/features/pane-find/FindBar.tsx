import { useEffect, useState, type ReactNode } from 'react';
import { Button, TextInput } from '@desktop/components';
import { ConfirmModal } from '@desktop/components/Modal';
import type { PaneFindSession } from './PaneFindContext';
import styles from './FindBar.module.scss';

interface FindBarProps {
  session: PaneFindSession;
  count: number;
  label: string;
  status?: ReactNode;
  children?: ReactNode;
  onReplace?: (replacement: string, all: boolean) => void;
  /** Invalidates a confirmation if the underlying draft changes. */
  revision?: unknown;
}

export function FindBar({
  session,
  count,
  label,
  status,
  children,
  onReplace,
  revision,
}: FindBarProps) {
  const [replacement, setReplacement] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { index, setIndex, query, caseSensitive, open } = session;
  const current = count ? Math.min(index, count - 1) : 0;
  useEffect(() => {
    if (index !== current) setIndex(current);
  }, [index, current, setIndex]);
  useEffect(() => {
    setConfirming(false);
  }, [query, caseSensitive, replacement, revision, count, open]);
  if (!open) return null;
  const move = (delta: number) => {
    if (count) setIndex((current + delta + count) % count);
  };
  return (
    <div className={styles.bar} role="search" aria-label={label}>
      <div className={styles.row}>
        <TextInput
          unstyled
          ref={session.queryRef}
          className={styles.input}
          aria-label={label}
          placeholder={label}
          value={query}
          onChange={(event) => session.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className={styles.count} role="status" aria-live="polite">
          {query ? `${count ? current + 1 : 0} of ${count}` : 'Type to find'}
        </span>
        <Button
          variant="ghost"
          size="xs"
          title="Match case"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          onClick={() => session.setCaseSensitive(!caseSensitive)}
        >
          Aa
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={!count}
          onClick={() => move(-1)}
        >
          ↑
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={!count}
          onClick={() => move(1)}
        >
          ↓
        </Button>
        {onReplace && (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={replaceOpen}
            onClick={() => setReplaceOpen(!replaceOpen)}
          >
            Replace
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          aria-label="Close find"
          title="Close find (Escape)"
          onClick={() => session.close()}
        >
          ×
        </Button>
      </div>
      {replaceOpen && onReplace && (
        <div className={styles.row}>
          <TextInput
            unstyled
            className={styles.input}
            aria-label="Replace with"
            placeholder="Replace with"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
          />
          <Button
            variant="neutral"
            size="xs"
            disabled={!count}
            onClick={() => onReplace(replacement, false)}
          >
            Replace next
          </Button>
          <Button variant="neutral" size="xs" disabled={!count} onClick={() => setConfirming(true)}>
            Replace all…
          </Button>
        </div>
      )}
      {status && (
        <div className={styles.status} role="status">
          {status}
        </div>
      )}
      {children}
      {confirming && (
        <ConfirmModal
          title="Replace all matches?"
          confirmLabel={`Replace ${count} ${count === 1 ? 'match' : 'matches'}`}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            onReplace?.(replacement, true);
            setConfirming(false);
            session.queryRef.current?.focus();
          }}
        >
          {`Replace all ${count} occurrences of “${query}” with “${replacement}” in this document? You can undo this change.`}
        </ConfirmModal>
      )}
    </div>
  );
}
