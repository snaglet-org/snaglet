import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { TABLE_RELATION_MAX_LINKS, type TableEntryValue } from '@snaglet/shared/types';
import { capitalize, getErrorMessage } from '@snaglet/shared/utils';
import { TextInput } from '@desktop/components';
import { usePointerMoveGate } from '@desktop/hooks/usePointerMoveGate';
import { useLiveEntryLabels } from '@desktop/features/table-entries';
import type { EntryCellEditorProps } from './cells/EntryCellEditor';
import { CellPickerPopover } from './CellPickerPopover';
import { entryValueList } from './entryValueList';
import type { RelationChoice, RelationSource } from './relationSources';
import styles from './RelationEntryPicker.module.scss';

const REORDER_MIME = 'application/x-snaglet-relation-order';

interface SearchSession {
  query: string;
  exclude: string[];
  offset: number;
  results: RelationChoice[];
  pending: boolean;
  canceled: boolean;
}

type Props = Omit<EntryCellEditorProps, 'relatedEntries' | 'relatedItems'> & {
  source: RelationSource;
};

/**
 * A relation cell's editor: the linked values stay in the cell as chips while
 * the search floats outside the row. What it links to (a table's entries, or
 * one kind of Snaglet item) comes from `source`.
 */
export function RelationPicker({
  field,
  value,
  source,
  onChange,
  onCommit,
  onCancel,
  busy,
  error,
  autoFocus,
}: Props) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusOnMount = useRef(false);
  focusOnMount.current = !!autoFocus && !busy;
  const latestValue = useRef<TableEntryValue>(field.multiple ? entryValueList(value) : value);
  const dragId = useRef<string | null>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchRef = useRef<SearchSession | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const [selected, setSelected] = useState(() => entryValueList(value));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RelationChoice[]>([]);
  const [knownNames, setKnownNames] = useState<Record<string, string>>({});
  const [active, setActive] = useState<number | null>(null);
  // Hover moves the highlight only once the pointer really moves, so results
  // that appear under a resting pointer after typing cannot take Enter.
  const pointer = usePointerMoveGate();
  const [loading, setLoading] = useState(!!source.key);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [pageFailed, setPageFailed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const { key: sourceKey, noun, normalize } = source;
  const same = (left: string, right: string) => normalize(left) === normalize(right);
  // Order is irrelevant to exclusion: rearranging linked chips should not restart a search.
  const exclusionKey = [...new Set(selected.map(normalize))].sort().join(',');
  const atLimit = field.multiple && selected.length >= TABLE_RELATION_MAX_LINKS;
  const canLoadMore = hasMore && nextOffset <= source.maxOffset;
  const message = error ?? failure ?? (!sourceKey ? source.missingTarget : null);
  const choices = results.filter((result) => !selected.some((linked) => same(linked, result.id)));
  const lastIndex = choices.length - 1 + (canLoadMore ? 1 : 0);
  const activeIndex = active === null || lastIndex < 0 ? null : Math.min(active, lastIndex);
  const activeChoice = activeIndex === null ? undefined : choices[activeIndex];
  const moreActive = canLoadMore && activeIndex === choices.length;

  useEffect(() => {
    latestValue.current = field.multiple ? entryValueList(value) : value;
    setSelected(entryValueList(value));
  }, [value, field.multiple]);

  useEffect(() => setKnownNames({}), [sourceKey]);

  useEffect(() => {
    const clearDrag = () => {
      dragId.current = null;
    };
    window.addEventListener('dragstart', clearDrag, true);
    window.addEventListener('dragend', clearDrag, true);
    return () => {
      window.removeEventListener('dragstart', clearDrag, true);
      window.removeEventListener('dragend', clearDrag, true);
    };
  }, []);

  const loadPage = useCallback(
    async (session: SearchSession, append: boolean) => {
      if (session.canceled || session.pending) return;
      session.pending = true;
      if (append) setLoadingMore(true);
      setFailure(null);
      setPageFailed(false);
      try {
        const page = await sourceRef.current.search({
          q: session.query,
          limit: 20,
          offset: session.offset,
          exclude: session.exclude,
        });
        if (session.canceled) return;
        session.offset += page.results.length;
        const byId = new Map(
          [...session.results, ...page.results].map((choice) => [
            sourceRef.current.normalize(choice.id),
            choice,
          ])
        );
        session.results = [...byId.values()];
        setResults(session.results);
        setHasMore(page.hasMore && page.results.length > 0);
        setNextOffset(session.offset);
        setKnownNames((previous) => ({
          ...previous,
          ...Object.fromEntries(page.results.map((choice) => [choice.id, choice.label])),
        }));
      } catch (err: unknown) {
        if (!session.canceled) {
          setFailure(getErrorMessage(err, `Could not search ${noun.many}`));
          setPageFailed(append);
        }
      } finally {
        session.pending = false;
        if (!session.canceled) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [noun.many]
  );

  useEffect(() => {
    setLoading(true);
    setLoadingMore(false);
    setHasMore(false);
    setNextOffset(0);
    setFailure(null);
    setPageFailed(false);
    setResults([]);
    setActive(query.trim() ? 0 : null);
    pointer.reset();
    if (!sourceKey) {
      searchRef.current = null;
      setLoading(false);
      return;
    }
    const session: SearchSession = {
      query: query.trim(),
      exclude: exclusionKey ? exclusionKey.split(',') : [],
      offset: 0,
      results: [],
      pending: false,
      canceled: false,
    };
    searchRef.current = session;
    const timer = window.setTimeout(() => void loadPage(session, false), query ? 200 : 0);
    return () => {
      session.canceled = true;
      window.clearTimeout(timer);
    };
  }, [sourceKey, query, exclusionKey, nonce, loadPage, pointer]);

  const loadMore = () => {
    if (busy || loading || !canLoadMore || !searchRef.current) return;
    void loadPage(searchRef.current, true);
  };
  const retry = () => {
    if (pageFailed) loadMore();
    else setNonce((previous) => previous + 1);
  };

  useLayoutEffect(() => {
    if (autoFocus && !busy) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus, busy]);
  // The popover mounts its contents only once it has a position.
  const attachInput = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element;
    if (element && focusOnMount.current) element.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (activeChoice || moreActive)
      document
        .getElementById(moreActive ? `${id}-more` : `${id}-option-${activeChoice?.id}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeChoice, moreActive, id]);

  const nameFor = (valueId: string) =>
    sourceKey ? (knownNames[valueId] ?? source.pageLabel(valueId)) : undefined;
  // Unnamed entries read as "Untitled N" here too, matching their chips.
  const liveLabel = useLiveEntryLabels(source.entryTableId, [
    ...selected.map((valueId) => ({ id: valueId, name: nameFor(valueId) })),
    ...choices.map((choice) => ({ id: choice.id, name: choice.label })),
  ]);
  const labelFor = (valueId: string) =>
    liveLabel(valueId, nameFor(valueId)) ??
    (source.entryTableId ? `Entry ${valueId.slice(0, 8)}` : 'Unavailable');
  const change = (ids: string[]) => {
    const next = field.multiple ? ids : (ids[0] ?? null);
    latestValue.current = next;
    setSelected(ids);
    onChange(next);
    return next;
  };
  const choose = (choice: RelationChoice) => {
    if (busy || atLimit) return;
    const current = entryValueList(latestValue.current);
    if (field.multiple && current.length >= TABLE_RELATION_MAX_LINKS) return;
    if (current.some((linked) => same(linked, choice.id))) return;
    setKnownNames((previous) => ({ ...previous, [choice.id]: choice.label }));
    source.remember(choice);
    const next = change(field.multiple ? [...current, choice.id] : [choice.id]);
    setQuery('');
    setActive(null);
    if (!field.multiple) onCommit(next);
    else inputRef.current?.focus({ preventScroll: true });
  };
  const remove = (valueId: string) => {
    if (busy) return;
    change(entryValueList(latestValue.current).filter((linked) => linked !== valueId));
    inputRef.current?.focus({ preventScroll: true });
  };
  const reorder = (valueId: string, to: number) => {
    if (busy || !field.multiple) return;
    const ids = entryValueList(latestValue.current);
    const from = ids.indexOf(valueId);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, valueId);
    change(next);
    setAnnouncement(`${labelFor(valueId)} moved to position ${to + 1} of ${next.length}.`);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onCommit(latestValue.current);
    } else if (event.target === inputRef.current) {
      if (event.key === 'ArrowLeft' && !query && selected.length) {
        event.preventDefault();
        const last = selected[selected.length - 1];
        if (last) chipRefs.current.get(last)?.focus();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((previous) => {
          if (lastIndex < 0) return null;
          if (previous === null) return event.key === 'ArrowDown' ? 0 : lastIndex;
          return Math.max(0, Math.min(lastIndex, previous + (event.key === 'ArrowDown' ? 1 : -1)));
        });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (moreActive) loadMore();
        else if (!loading && activeChoice && !atLimit) choose(activeChoice);
        else if (!query.trim()) onCommit(latestValue.current);
        else if (failure && !loading) retry();
      }
    }
  };

  const placeholder = `Find ${noun.article}…`;
  return (
    <div className={styles.picker} ref={setAnchor} onKeyDown={onKeyDown} data-keeps-cell="">
      <div className={styles.selected} aria-label={`Linked ${noun.many} in ${field.name}`}>
        {sourceKey &&
          selected.map((valueId, index) => (
            <span className={styles.selectedEntry} key={valueId}>
              <button
                type="button"
                ref={(element) => {
                  if (element) chipRefs.current.set(valueId, element);
                  else chipRefs.current.delete(valueId);
                }}
                className={styles.chipHandle}
                draggable={field.multiple && !busy}
                aria-label={
                  field.multiple
                    ? `Reorder ${labelFor(valueId)}, position ${index + 1} of ${selected.length}`
                    : `Search ${field.name}`
                }
                aria-keyshortcuts={field.multiple ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined}
                title={field.multiple ? 'Drag to reorder, or use Alt + Left / Right' : undefined}
                disabled={busy}
                onClick={() => inputRef.current?.focus()}
                onKeyDown={(event) => {
                  if (event.key === 'Backspace' || event.key === 'Delete') {
                    event.preventDefault();
                    remove(valueId);
                    return;
                  }
                  if (!event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                    event.preventDefault();
                    const next = selected[index + (event.key === 'ArrowLeft' ? -1 : 1)];
                    if (next) chipRefs.current.get(next)?.focus();
                    else inputRef.current?.focus();
                    return;
                  }
                  if (
                    !event.altKey ||
                    !field.multiple ||
                    !['ArrowLeft', 'ArrowRight'].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  reorder(valueId, index + (event.key === 'ArrowLeft' ? -1 : 1));
                }}
                onDragStart={(event) => {
                  dragId.current = valueId;
                  event.dataTransfer.setData(REORDER_MIME, id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.stopPropagation();
                }}
                onDragOver={(event) => {
                  if (!dragId.current || busy) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  // The local source survives WKWebView stripping custom MIME payloads.
                  if (!dragId.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                  reorder(dragId.current, index);
                  dragId.current = null;
                }}
                onDragEnd={() => {
                  dragId.current = null;
                }}
              >
                {source.renderChip(valueId, nameFor(valueId))}
              </button>
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${labelFor(valueId)}`}
                disabled={busy}
                onClick={() => remove(valueId)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))}
        {selected.length === 0 && <span className={styles.placeholder}>{placeholder}</span>}
      </div>
      <CellPickerPopover anchor={anchor} minWidth={260}>
        <TextInput
          unstyled
          ref={attachInput}
          className={styles.search}
          role="combobox"
          aria-label={`Search ${field.name}`}
          aria-description={
            failure && query.trim()
              ? 'Press Enter to retry this search.'
              : field.multiple
                ? `With an empty search, press Left Arrow to reach linked ${noun.many}. Use Alt + Left or Right to reorder, or Delete to remove.`
                : `With an empty search, press Left Arrow to reach the linked ${noun.one}, then Delete to remove it.`
          }
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={
            loading
              ? undefined
              : moreActive
                ? `${id}-more`
                : activeChoice
                  ? `${id}-option-${activeChoice.id}`
                  : undefined
          }
          aria-busy={loading || loadingMore}
          aria-invalid={!!message}
          aria-describedby={message ? `${id}-error` : atLimit ? `${id}-limit` : undefined}
          placeholder={placeholder}
          maxLength={source.maxQueryLength}
          value={query}
          readOnly={busy || !sourceKey}
          onChange={(event) => {
            if (!busy) {
              setQuery(event.target.value);
              setActive(event.target.value.trim() ? 0 : null);
            }
          }}
        />
        <div
          role="listbox"
          id={`${id}-list`}
          aria-label={`${capitalize(noun.many)} for ${field.name}`}
          className={styles.results}
          aria-busy={loading || loadingMore}
        >
          {!loading &&
            choices.map((choice, index) => {
              const label = liveLabel(choice.id, choice.label) ?? choice.label;
              return (
                <div
                  role="option"
                  aria-label={`${label}${choice.secondary ? ` ${choice.secondary}` : ''}`}
                  key={choice.id}
                  id={`${id}-option-${choice.id}`}
                  aria-selected={index === activeIndex}
                  aria-disabled={busy || atLimit}
                  className={styles.option}
                  // An untouched empty search never highlights, so Enter there
                  // commits the value unchanged.
                  onPointerMove={(event) => {
                    if (pointer.moved(event) && (query.trim() || active !== null)) setActive(index);
                  }}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(choice)}
                >
                  <span>{label}</span>
                  {choice.secondary && <span className={styles.preview}>{choice.secondary}</span>}
                </div>
              );
            })}
          {!loading && canLoadMore && (
            <div
              role="option"
              id={`${id}-more`}
              aria-label={`Show more ${noun.many}`}
              aria-selected={moreActive}
              aria-disabled={busy || loadingMore}
              className={styles.option}
              onPointerMove={(event) => {
                if (pointer.moved(event) && (query.trim() || active !== null))
                  setActive(choices.length);
              }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setActive(choices.length);
                loadMore();
              }}
            >
              {loadingMore ? 'Loading more…' : 'Show more'}
            </div>
          )}
        </div>
        {loading && (
          <p className={styles.hint} role="status">
            Searching…
          </p>
        )}
        {!loading && !message && choices.length === 0 && (
          <p className={styles.hint}>
            {query
              ? `No matching ${noun.many}`
              : selected.length
                ? `No more ${noun.many} to link`
                : `No ${noun.many} yet`}
          </p>
        )}
        {!loading && hasMore && !canLoadMore && (
          <p className={styles.hint}>{`Refine your search to find more ${noun.many}.`}</p>
        )}
        {atLimit && (
          <p id={`${id}-limit`} className={styles.hint}>
            {`Up to ${TABLE_RELATION_MAX_LINKS} ${noun.many} can be linked.`}
          </p>
        )}
        {message && (
          <p id={`${id}-error`} className={styles.error} role="alert">
            {message}
          </p>
        )}
        {failure && (
          <button
            type="button"
            className={styles.retry}
            disabled={busy || loading || loadingMore}
            onClick={() => {
              retry();
              inputRef.current?.focus();
            }}
          >
            Retry
          </button>
        )}
      </CellPickerPopover>
      <span className={styles.srOnly} aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
