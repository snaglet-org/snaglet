import { useId, useMemo, useState, type FC, type KeyboardEvent } from 'react';
import { TextInput } from '@desktop/components';
import { PlusIcon } from '@desktop/components/Icons';
import { cn } from '@desktop/utils/classNames';
import { SectionLabel, SectionState } from './HubSection';
import { HubSurface } from './HubSurface';
import { PIN_KIND_LABEL, PinIcon, PinKindIcon } from './hubIcons';
import { pinKey, type PinKind } from './hubModel';
import type { HubPinCandidate, HubPinRow, HubSelection, LoadStatus } from './hubTypes';
import styles from './HubView.module.scss';

export interface PinnedSectionProps {
  status: LoadStatus;
  error: string | null;
  onRetry?: () => void;
  rows: HubPinRow[];
  onOpen: (selection: HubSelection) => void;
  onUnpin: (kind: PinKind, id: string) => void;
  /** Everything the picker can offer; read when it opens. */
  candidates: HubPinCandidate[] | null;
  onPin: (candidate: HubPinCandidate) => void;
  /** Told when the picker opens or closes, so its list can load. */
  onPickerOpenChange?: (open: boolean) => void;
}

/** Kind-tint class for pinned chips and picker options. */
const KIND_CLASS: Record<PinKind, string> = {
  doc: styles.kindDoc,
  thread: styles.kindThread,
  project: styles.kindProject,
  table: styles.kindTable,
};

const PICKER_GROUPS: Array<{ kind: PinKind; label: string }> = [
  { kind: 'project', label: 'Projects' },
  { kind: 'table', label: 'Tables' },
  { kind: 'doc', label: 'Docs' },
  { kind: 'thread', label: 'Threads' },
];

/** Options shown per kind before the user types a filter. */
const PICKER_PREVIEW = 5;

/** Up/Down move between the picker's options. */
function moveOptionFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-pin-option]:not(:disabled)')
  );
  if (options.length === 0) return;
  event.preventDefault();
  const at = options.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  const next = at < 0 ? (step > 0 ? 0 : options.length - 1) : at + step;
  options[Math.max(0, Math.min(options.length - 1, next))]?.focus();
}

/** A pinned chip's full name: title, kind and project (its hover title). */
function chipLabel(row: HubPinRow): string {
  if (row.missing) return `${row.title}, not found (archived or deleted)`;
  const kind = PIN_KIND_LABEL[row.kind];
  return row.meta ? `${row.title} · ${kind} · ${row.meta}` : `${row.title} · ${kind}`;
}

/**
 * Pinned items as compact chips in a wrapping row (two rows, then it
 * scrolls): kind icon and title, with the kind and project in the hover
 * title. A chip opens its item; its pin unpins it. The "+" chip at the end
 * opens a filterable list of projects, tables, docs and threads to pin.
 */
export const PinnedSection: FC<PinnedSectionProps> = ({
  status,
  error,
  onRetry,
  rows,
  onOpen,
  onUnpin,
  candidates,
  onPin,
  onPickerOpenChange,
}) => {
  const labelId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const pinned = useMemo(() => new Set(rows.map((row) => pinKey(row.kind, row.id))), [rows]);

  const openPicker = (target: HTMLElement) => {
    setQuery('');
    setAnchor(target);
    onPickerOpenChange?.(true);
  };
  const closePicker = () => {
    setAnchor(null);
    onPickerOpenChange?.(false);
  };

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PICKER_GROUPS.map(({ kind, label }) => {
      const all = (candidates ?? []).filter((c) => c.kind === kind);
      const matching = needle ? all.filter((c) => c.title.toLowerCase().includes(needle)) : all;
      return { kind, label, options: needle ? matching : matching.slice(0, PICKER_PREVIEW) };
    }).filter((group) => group.options.length > 0);
  }, [candidates, query]);

  const choose = (candidate: HubPinCandidate) => {
    onPin(candidate);
    closePicker();
  };

  return (
    <section className={styles.pinned} aria-labelledby={labelId}>
      <SectionLabel id={labelId} count={status === 'ready' ? rows.length : undefined}>
        Pinned
      </SectionLabel>
      <SectionState
        status={status}
        error={error}
        loadingText="Loading your pins…"
        onRetry={onRetry}
      />
      {status === 'ready' && error && (
        <p className={styles.inlineError} role="alert">
          {error}
        </p>
      )}
      {status === 'ready' && (
        <ul className={styles.chips}>
          {rows.map((row) => (
            <li
              key={pinKey(row.kind, row.id)}
              className={cn(styles.chip, KIND_CLASS[row.kind], row.missing && styles.missing)}
              title={chipLabel(row)}
            >
              <button
                type="button"
                className={styles.chipOpen}
                disabled={!row.selection}
                onClick={() => row.selection && onOpen(row.selection)}
                aria-label={chipLabel(row)}
              >
                <span className={styles.kindGlyph} aria-hidden>
                  <PinKindIcon kind={row.kind} />
                </span>
                <span className={styles.chipTitle}>{row.title}</span>
              </button>
              <button
                type="button"
                className={styles.chipUnpin}
                aria-label={`Unpin ${row.title}`}
                title="Unpin"
                onClick={() => onUnpin(row.kind, row.id)}
              >
                <PinIcon filled />
              </button>
            </li>
          ))}
          {rows.length === 0 && (
            <li className={styles.chipsEmpty}>
              Nothing pinned yet. Pin the threads, docs, projects and tables you come back to.
            </li>
          )}
          <li className={styles.chipAddItem}>
            <button
              type="button"
              className={cn(styles.chipAdd, rows.length === 0 && styles.chipAddLabeled)}
              aria-label="Pin something"
              title="Pin something"
              aria-haspopup="dialog"
              aria-expanded={anchor !== null}
              onClick={(event) => (anchor ? closePicker() : openPicker(event.currentTarget))}
            >
              <PlusIcon />
              {rows.length === 0 && <span aria-hidden>Pin something</span>}
            </button>
          </li>
        </ul>
      )}
      {anchor && (
        <HubSurface anchor={anchor} label="Pin to Home" onDismiss={closePicker} width={320}>
          <div className={styles.pickerBody} onKeyDown={moveOptionFocus}>
            <TextInput
              size="sm"
              fullWidth
              data-autofocus=""
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a project, table, doc or thread"
              aria-label="Find something to pin"
            />
            {candidates === null ? (
              <p className={styles.pickerNote} role="status">
                Loading…
              </p>
            ) : groups.length === 0 ? (
              <p className={styles.pickerNote}>
                {query.trim() ? 'Nothing matches.' : 'Nothing to pin yet.'}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.kind} role="group" aria-label={group.label}>
                  <p className={styles.pickerGroupLabel} aria-hidden>
                    {group.label}
                  </p>
                  {group.options.map((option) => {
                    const isPinned = pinned.has(pinKey(option.kind, option.id));
                    return (
                      <button
                        key={option.id}
                        type="button"
                        data-pin-option=""
                        className={cn(styles.pickerOption, KIND_CLASS[option.kind])}
                        disabled={isPinned}
                        onClick={() => choose(option)}
                      >
                        <span className={styles.kindGlyph} aria-hidden>
                          <PinKindIcon kind={option.kind} />
                        </span>
                        <span className={styles.pickerOptionTitle}>{option.title}</span>
                        <span className={styles.pickerOptionMeta}>
                          {isPinned ? 'Pinned' : option.meta}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </HubSurface>
      )}
    </section>
  );
};
