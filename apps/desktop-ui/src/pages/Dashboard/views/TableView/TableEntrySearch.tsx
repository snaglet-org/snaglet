import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { TABLE_ENTRY_FILTER_QUERY_MAX_LENGTH } from '@snaglet/shared/types';
import { Button } from '@desktop/components';
import { SearchIcon } from '@desktop/components/Icons';
import styles from './TableEntrySearch.module.scss';

/** Typing pauses this long before the search runs. */
const SEARCH_DELAY_MS = 200;

interface Props {
  /** The applied search; a change from outside (Clear search) replaces the text. */
  query: string;
  onQueryChange: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * The table pane's search box. Typing filters the entries after a short
 * pause (Enter runs it at once); × or Escape clears it, and Escape in the
 * empty box blurs it.
 */
export function TableEntrySearch({ query, onQueryChange, inputRef }: Props) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const [text, setText] = useState(query);
  const sent = useRef(query);
  const onChangeRef = useRef(onQueryChange);
  onChangeRef.current = onQueryChange;

  useEffect(() => {
    if (query === sent.current) return;
    sent.current = query;
    setText(query);
  }, [query]);

  const send = useCallback((value: string) => {
    const next = value.trim();
    if (next === sent.current) return;
    sent.current = next;
    onChangeRef.current(next);
  }, []);

  useEffect(() => {
    if (text.trim() === sent.current) return;
    const timer = window.setTimeout(() => send(text), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, send]);

  const clear = () => {
    setText('');
    send('');
  };

  return (
    <div className={styles.search} role="search">
      <SearchIcon className={styles.glyph} width={13} height={13} />
      <input
        ref={ref}
        type="text"
        role="searchbox"
        className={styles.input}
        placeholder="Search entries"
        aria-label="Search entries"
        title="Search every field; each word must match (Cmd/Ctrl+F)"
        spellCheck={false}
        autoComplete="off"
        maxLength={TABLE_ENTRY_FILTER_QUERY_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            send(text);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (text) clear();
            else event.currentTarget.blur();
          }
        }}
      />
      {text && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          className={styles.clear}
          aria-label="Clear search"
          title="Clear search (Esc)"
          onClick={() => {
            clear();
            ref.current?.focus();
          }}
        >
          ×
        </Button>
      )}
    </div>
  );
}
