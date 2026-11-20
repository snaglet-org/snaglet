import React, { useEffect, useRef, useState, type RefObject } from 'react';
import { Button, Select } from '@desktop/components';
import { SearchIcon } from '@desktop/components/Icons';
import { cn } from '@desktop/utils/classNames';
import { matchRanges, type ArchiveSort } from './archiveSearch';
import styles from './ArchivedDrawer.module.scss';

/** `text` with each occurrence of the query's words marked. */
export const Highlighted: React.FC<{ text: string; terms: readonly string[] }> = ({
  text,
  terms,
}) => {
  const ranges = matchRanges(text, terms);
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className={styles.match}>
        {text.slice(start, end)}
      </mark>
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
};

/** A screen reader hears the count once typing pauses this long. */
const ANNOUNCE_DELAY_MS = 500;

/** `value` once it has held still for `delayMs`. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

interface ArchiveSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  sort: ArchiveSort;
  onSortChange: (sort: ArchiveSort) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The drawer's search box and sort. Escape handling lives on the drawer, so
 * it also clears the search from a result row.
 */
export const ArchiveSearchBar: React.FC<ArchiveSearchBarProps> = ({
  query,
  onQueryChange,
  sort,
  onSortChange,
  inputRef,
}) => {
  return (
    <div className={styles.searchRow}>
      <div className={styles.search} role="search">
        <SearchIcon className={styles.searchGlyph} width={13} height={13} />
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          className={styles.searchInput}
          placeholder="Search archived items"
          aria-label="Search archived items"
          title="Matches item names and the folders or projects they sit in. Every word must match."
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query && (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            className={styles.searchClear}
            aria-label="Clear search text"
            title="Clear search (Esc)"
            onClick={() => {
              onQueryChange('');
              inputRef.current?.focus();
            }}
          >
            ×
          </Button>
        )}
      </div>
      <span className={styles.sort}>
        <Select
          size="md"
          aria-label="Sort"
          value={sort}
          onChange={(event) => onSortChange(event.target.value === 'newest' ? 'newest' : 'default')}
        >
          <option value="default">Default order</option>
          <option value="newest">Newest archived first</option>
        </Select>
      </span>
    </div>
  );
};

/**
 * The item or match count. The visible count follows every keystroke; the
 * status region announces it once, after typing pauses.
 */
export const ArchiveResultCount: React.FC<{ status: string }> = ({ status }) => {
  const announced = useSettled(status, ANNOUNCE_DELAY_MS);
  return (
    <>
      <span className={styles.status} aria-hidden>
        {status}
      </span>
      <span className={styles.srOnly} role="status">
        {announced}
      </span>
    </>
  );
};

interface KindOption {
  value: string;
  label: string;
  count: number;
}

interface ArchiveKindFilterProps {
  options: readonly KindOption[];
  value: string;
  onChange: (value: string) => void;
}

const KIND_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * One-choice kind filter as a radio group: only the checked chip is in the
 * tab order, and the arrow keys (Home / End) move and select.
 */
export const ArchiveKindFilter: React.FC<ArchiveKindFilterProps> = ({
  options,
  value,
  onChange,
}) => {
  const groupRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!KIND_KEYS.has(event.key) || options.length === 0) return;
    event.preventDefault();
    const current = Math.max(
      0,
      options.findIndex((option) => option.value === value)
    );
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (current + (forward ? 1 : -1) + options.length) % options.length;
    const target = options[next];
    if (!target) return;
    onChange(target.value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Filter by kind"
      className={styles.kinds}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={cn(
              styles.kind,
              checked && styles.kindActive,
              option.count === 0 && styles.kindEmpty
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label} <span className={styles.kindCount}>{option.count}</span>
          </button>
        );
      })}
    </div>
  );
};
