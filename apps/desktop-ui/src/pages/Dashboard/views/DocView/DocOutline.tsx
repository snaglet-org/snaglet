import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FC,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import type {
  DocOutlineStore,
  OutlineEntry,
} from '@desktop/features/rich-markdown/outline/docOutline';
import { PropertiesGroup } from '../shared/PropertiesPanel';
import styles from './DocOutline.module.scss';

/** Indent steps drawn; anything deeper lines up with the deepest one. */
const MAX_DEPTH = 5;

interface DocOutlineProps {
  /** The doc view's outline; its editor keeps it current. */
  store: DocOutlineStore;
  /** Scroll the editor to this heading. */
  onJump: (entry: OutlineEntry) => void;
  /** List the headings without jumping (a version preview replaces the editor). */
  disabled?: boolean;
}

/**
 * DocOutline — the Outline group in the doc's Properties panel: the doc's own
 * headings, indented by level, as buttons that jump to them. The heading in
 * view is marked as the doc scrolls. One tab stop: arrow keys, Home and End
 * move between entries, Enter or Space jumps.
 */
export const DocOutline: FC<DocOutlineProps> = ({ store, onJump, disabled = false }) => {
  const { entries, active } = useSyncExternalStore(store.subscribe, store.getState);
  const minLevel = useMemo(
    () => entries.reduce((min, entry) => Math.min(min, entry.level), 6),
    [entries]
  );
  const listRef = useRef<HTMLOListElement>(null);
  // The entry holding keyboard focus; while focus is elsewhere the tab stop
  // follows the heading in view.
  const [focused, setFocused] = useState<number | null>(null);
  const tabStop = Math.max(0, Math.min(focused ?? active, entries.length - 1));

  const select = useCallback(
    (index: number) => {
      const entry = store.getState().entries[index];
      if (!entry) return;
      store.hold(index);
      onJump(entry);
    },
    [store, onJump]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    if (focused === null) return;
    const last = entries.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(focused + 1, last)
        : event.key === 'ArrowUp'
          ? Math.max(focused - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  const onBlur = (event: FocusEvent<HTMLOListElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null);
  };

  // A long outline scrolls in its own box; keep the heading in view visible.
  useLayoutEffect(() => {
    const list = listRef.current;
    const item = list?.children[active] as HTMLElement | undefined;
    if (!list || !item || list.scrollHeight <= list.clientHeight) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight;
  }, [active, entries]);

  return (
    <PropertiesGroup label="Outline">
      {entries.length === 0 ? (
        <p className={styles.empty}>No headings yet</p>
      ) : (
        <nav aria-label="Outline" className={styles.outline}>
          <ol ref={listRef} className={styles.list} onKeyDown={onKeyDown} onBlur={onBlur}>
            {entries.map((entry, index) => (
              <OutlineItem
                // Index keys: an edit above a heading shifts lines, not rows.
                key={index}
                entry={entry}
                index={index}
                depth={Math.min(entry.level - minLevel, MAX_DEPTH)}
                active={index === active}
                tabbable={index === tabStop}
                disabled={disabled}
                onSelect={select}
                onFocusItem={setFocused}
              />
            ))}
          </ol>
        </nav>
      )}
    </PropertiesGroup>
  );
};

interface OutlineItemProps {
  entry: OutlineEntry;
  index: number;
  depth: number;
  active: boolean;
  tabbable: boolean;
  disabled: boolean;
  onSelect: (index: number) => void;
  onFocusItem: (index: number) => void;
}

// Memoized so a scroll that moves the mark re-renders two rows, not hundreds.
const OutlineItem = memo(function OutlineItem({
  entry,
  index,
  depth,
  active,
  tabbable,
  disabled,
  onSelect,
  onFocusItem,
}: OutlineItemProps) {
  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.item}
        data-level={entry.level}
        data-depth={depth}
        aria-current={active ? 'location' : undefined}
        tabIndex={tabbable ? 0 : -1}
        title={entry.text}
        disabled={disabled}
        onClick={() => onSelect(index)}
        onFocus={() => onFocusItem(index)}
      >
        {entry.text}
      </button>
    </li>
  );
});
