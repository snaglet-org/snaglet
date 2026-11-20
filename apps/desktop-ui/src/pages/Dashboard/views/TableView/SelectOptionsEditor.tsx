import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  TABLE_SELECT_MAX_OPTIONS,
  TABLE_SELECT_OPTION_COLORS,
  type TableSelectOptionInput,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { TextInput } from '@desktop/components';
import { PlusIcon, TrashIcon } from '@desktop/components/Icons';
import { tablesApi } from '@desktop/utils/api';
import { SelectOptionTag, selectOptionColorClass } from './SelectOptionTag';
import {
  addSelectOption,
  moveSelectOption,
  removeSelectOption,
  renameSelectOption,
  selectOptionEditProblem,
  type SelectOptionsValue,
} from './selectFieldDefinition';
import styles from './SelectOptionsEditor.module.scss';

const REORDER_MIME = 'application/x-snaglet-select-option-order';
const optionKey = (option: TableSelectOptionInput) => option.id ?? option.label;
const rows = (count = 0) => `${count} ${count === 1 ? 'row' : 'rows'}`;

export interface SelectOptionsEditorProps extends SelectOptionsValue {
  tableId: string;
  fieldId?: string;
  /** A required single choice refills removed values with its default. */
  required?: boolean;
  /** Saved ids, refreshed after autosave. Omit to conservatively check every identified option. */
  persistedOptionIds?: readonly string[];
  disabled?: boolean;
  /** Parent invokes before close/persist/unmount; false retains an invalid pending label. */
  flushPendingRef?: RefObject<(() => boolean) | null>;
  onChange: (value: SelectOptionsValue) => void;
}

interface Removal {
  key: string;
  loading: boolean;
  count?: number;
  error?: string;
}

/** Option metadata only; the enclosing field editor owns persistence and its errors. */
export function SelectOptionsEditor({
  tableId,
  fieldId,
  options,
  defaultValue,
  persistedOptionIds,
  required = false,
  disabled = false,
  flushPendingRef,
  onChange,
}: SelectOptionsEditorProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRender = useRef<string | null>(null);
  const latest = useRef({ options, defaultValue });
  latest.current = { options, defaultValue };
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const [editing, setEditing] = useState<{ key: string; label: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [newLabel, setNewLabel] = useState('');
  const newLabelRef = useRef(newLabel);
  newLabelRef.current = newLabel;
  const [error, setError] = useState<string | null>(null);
  const [palette, setPalette] = useState<string | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const request = useRef(0);
  const dragged = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const busy = disabled || !!removal;
  const removedIndex = options.findIndex((option) => optionKey(option) === removal?.key);
  const removedOption = removedIndex < 0 ? undefined : options[removedIndex];
  // The backend refills a required single choice with the default left after removal.
  const refill =
    removal && removedIndex >= 0 && required
      ? removeSelectOption({ options, defaultValue }, removedIndex).defaultValue
      : null;
  const replacement = typeof refill === 'string' ? refill : null;
  const blockedByRequired = required && !replacement;

  const publish = (next: SelectOptionsValue) => {
    if (disabledRef.current || next === latest.current) return;
    latest.current = next;
    setError(null);
    onChange(next);
  };
  const finishLabel = (restoreFocus = false): boolean => {
    if (disabledRef.current) return true;
    const edit = editingRef.current;
    const label = (edit?.label ?? newLabelRef.current).trim();
    if (!edit && !label) return true;
    const index = edit
      ? latest.current.options.findIndex((option) => optionKey(option) === edit.key)
      : undefined;
    if (index === -1) {
      editingRef.current = null;
      setEditing(null);
      return true;
    }
    const problem = selectOptionEditProblem(latest.current.options, label, index);
    if (problem) {
      setError(problem);
      return false;
    }
    const next =
      index === undefined
        ? addSelectOption(latest.current, label)
        : renameSelectOption(latest.current, index, label);
    if (edit) {
      const renamed = index === undefined ? undefined : next.options[index];
      if (restoreFocus && renamed) focusAfterRender.current = `rename:${optionKey(renamed)}`;
      editingRef.current = null;
      setEditing(null);
    } else {
      newLabelRef.current = '';
      setNewLabel('');
    }
    publish(next);
    return true;
  };
  const finishRef = useRef(finishLabel);
  finishRef.current = finishLabel;

  useLayoutEffect(() => {
    if (!flushPendingRef) return;
    // The parent may flush in its passive unmount cleanup, after this child's
    // layout cleanup. Keep the callback available until the parent replaces it.
    flushPendingRef.current = () => finishRef.current();
  }, [flushPendingRef]);

  useEffect(() => {
    setRemoval(null);
    const clearDrag = () => {
      dragged.current = null;
    };
    window.addEventListener('dragstart', clearDrag, true);
    window.addEventListener('dragend', clearDrag, true);
    return () => {
      request.current += 1;
      window.removeEventListener('dragstart', clearDrag, true);
      window.removeEventListener('dragend', clearDrag, true);
    };
  }, [tableId, fieldId]);

  useEffect(() => {
    if (removal && !removedOption) {
      request.current += 1;
      setRemoval(null);
    }
  }, [removal, removedOption]);

  useLayoutEffect(() => {
    const key = focusAfterRender.current;
    if (key) buttons.current.get(key)?.focus({ preventScroll: true });
    focusAfterRender.current = null;
  });

  const remove = (key: string) => {
    const index = latest.current.options.findIndex((option) => optionKey(option) === key);
    if (index < 0 || disabledRef.current) return;
    publish(removeSelectOption(latest.current, index));
    setRemoval(null);
    addInput.current?.focus({ preventScroll: true });
  };
  const requestRemoval = async (key: string) => {
    if (disabledRef.current) return;
    const option = latest.current.options.find((item) => optionKey(item) === key);
    if (!option) return;
    setPalette(null);
    if (!fieldId || !option.id || (persistedOptionIds && !persistedOptionIds.includes(option.id))) {
      remove(key);
      return;
    }
    const sequence = ++request.current;
    setRemoval({ key, loading: true });
    try {
      const { usage } = await tablesApi.selectOptionUsage(tableId, fieldId);
      if (sequence !== request.current) return;
      if (disabledRef.current) {
        setRemoval(null);
        return;
      }
      const count = usage[option.id] ?? 0;
      if (count > 0) setRemoval({ key, loading: false, count });
      else remove(key);
    } catch (err) {
      if (sequence === request.current)
        setRemoval({
          key,
          loading: false,
          error: getErrorMessage(err, 'Could not check option usage'),
        });
    }
  };
  const cancelRemoval = () => {
    request.current += 1;
    setRemoval(null);
  };
  const move = (key: string, to: number) => {
    if (busy) return;
    const from = latest.current.options.findIndex((option) => optionKey(option) === key);
    const option = latest.current.options[from];
    const next = moveSelectOption(latest.current, from, to);
    if (!option || next === latest.current) return;
    publish(next);
    setAnnouncement(`${option.label} moved to position ${to + 1} of ${next.options.length}.`);
  };

  return (
    <div className={styles.editor} role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className={styles.label}>
        Options
      </span>
      <ol className={styles.list}>
        {options.map((option, index) => {
          const key = optionKey(option);
          const isEditing = editing?.key === key;
          return (
            <li
              key={key}
              className={styles.row}
              onDragOverCapture={(event) => {
                if (!dragged.current || busy) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDropCapture={(event) => {
                if (!dragged.current) return;
                event.preventDefault();
                event.stopPropagation();
                move(dragged.current, index);
                dragged.current = null;
              }}
            >
              <div className={styles.option}>
                <button
                  type="button"
                  className={`${styles.control} ${styles.drag}`}
                  draggable={!busy}
                  disabled={busy}
                  aria-label={`Reorder ${option.label}, position ${index + 1} of ${options.length}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  title="Drag to reorder, or use Alt + Up / Down"
                  onKeyDown={(event) => {
                    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    move(key, index + (event.key === 'ArrowUp' ? -1 : 1));
                  }}
                  onDragStart={(event) => {
                    dragged.current = key;
                    event.dataTransfer.setData(REORDER_MIME, id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.stopPropagation();
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                  }}
                >
                  <span aria-hidden="true">⋮⋮</span>
                </button>
                {isEditing ? (
                  <TextInput
                    unstyled
                    autoFocus
                    ref={input}
                    className={styles.input}
                    aria-label="Option label"
                    aria-invalid={!!error}
                    aria-describedby={error ? `${id}-error` : undefined}
                    value={editing.label}
                    disabled={busy}
                    onChange={(event) => {
                      const next = { key, label: event.target.value };
                      editingRef.current = next;
                      setEditing(next);
                      setError(null);
                    }}
                    onBlur={() => {
                      finishLabel();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.stopPropagation();
                        finishLabel(true);
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        editingRef.current = null;
                        setEditing(null);
                        setError(null);
                        focusAfterRender.current = `rename:${key}`;
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className={styles.name}
                    disabled={busy}
                    aria-label={`Rename option ${option.label}`}
                    ref={(element) => {
                      if (element) buttons.current.set(`rename:${key}`, element);
                      else buttons.current.delete(`rename:${key}`);
                    }}
                    onClick={() => {
                      setPalette(null);
                      setEditing({ key, label: option.label });
                    }}
                  >
                    <SelectOptionTag label={option.label} color={option.color} />
                  </button>
                )}
                <button
                  type="button"
                  className={`${styles.control} ${styles.color} ${selectOptionColorClass(option.color)}`}
                  aria-label={`Change color for ${option.label}`}
                  aria-expanded={palette === key}
                  aria-controls={palette === key ? `${id}-colors` : undefined}
                  disabled={busy}
                  ref={(element) => {
                    if (element) buttons.current.set(`color:${key}`, element);
                    else buttons.current.delete(`color:${key}`);
                  }}
                  onClick={() => setPalette(palette === key ? null : key)}
                >
                  <span aria-hidden="true">●</span>
                </button>
                <button
                  type="button"
                  className={`${styles.control} ${styles.remove}`}
                  aria-label={`Remove option ${option.label}`}
                  disabled={busy}
                  onClick={() => void requestRemoval(key)}
                >
                  <TrashIcon />
                </button>
              </div>
              {palette === key && (
                <div
                  id={`${id}-colors`}
                  className={styles.palette}
                  role="group"
                  aria-label={`Colors for ${option.label}`}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    event.stopPropagation();
                    focusAfterRender.current = `color:${key}`;
                    setPalette(null);
                  }}
                >
                  {TABLE_SELECT_OPTION_COLORS.map((color) => (
                    <button
                      type="button"
                      key={color}
                      className={`${styles.control} ${styles.swatch} ${selectOptionColorClass(color)}`}
                      aria-label={`Set ${option.label} color to ${color}`}
                      aria-pressed={(option.color ?? 'gray') === color}
                      disabled={busy}
                      onClick={() => {
                        publish({
                          ...latest.current,
                          options: latest.current.options.map((item) =>
                            optionKey(item) === key ? { ...item, color } : item
                          ),
                        });
                        focusAfterRender.current = `color:${key}`;
                        setPalette(null);
                      }}
                    >
                      <span aria-hidden="true">●</span>
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {removal && removedOption && (
        <div
          className={styles.confirmation}
          role="group"
          aria-label={`Remove ${removedOption.label}`}
        >
          {removal.loading ? (
            <p role="status">Checking how many rows use this option…</p>
          ) : removal.error ? (
            <p role="alert">{removal.error}</p>
          ) : blockedByRequired ? (
            <p>
              {`${rows(removal.count)} ${removal.count === 1 ? 'uses' : 'use'} “${removedOption.label}”. `}
              Choose another default choice first, or make the field optional.
            </p>
          ) : replacement ? (
            <p>
              {`Remove “${removedOption.label}”? The ${rows(removal.count)} using it `}
              {`${removal.count === 1 ? 'changes' : 'change'} to “${replacement}”.`}
            </p>
          ) : (
            <p>{`Remove “${removedOption.label}” from ${rows(removal.count)}?`}</p>
          )}
          <div className={styles.actions}>
            {!removal.loading && !(blockedByRequired && !removal.error) && (
              <button
                type="button"
                className={styles.action}
                disabled={disabled}
                onClick={() =>
                  removal.error ? void requestRemoval(removal.key) : remove(removal.key)
                }
              >
                {removal.error ? 'Retry usage check' : 'Remove option'}
              </button>
            )}
            <button type="button" className={styles.action} autoFocus onClick={cancelRemoval}>
              Keep option
            </button>
          </div>
        </div>
      )}
      <div className={styles.add}>
        <TextInput
          unstyled
          ref={addInput}
          className={styles.input}
          aria-label="New option"
          aria-invalid={!!error && !editing}
          aria-describedby={error && !editing ? `${id}-error` : undefined}
          value={newLabel}
          placeholder={
            options.length >= TABLE_SELECT_MAX_OPTIONS ? '100 options maximum' : 'Add an option…'
          }
          disabled={busy || options.length >= TABLE_SELECT_MAX_OPTIONS}
          onChange={(event) => {
            newLabelRef.current = event.target.value;
            setNewLabel(event.target.value);
            setError(null);
          }}
          onBlur={() => {
            finishLabel();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              finishLabel();
            } else if (event.key === 'Escape' && newLabel) {
              event.preventDefault();
              event.stopPropagation();
              newLabelRef.current = '';
              setNewLabel('');
              setError(null);
            }
          }}
        />
        <button
          type="button"
          className={styles.control}
          aria-label="Add option"
          disabled={busy || !newLabel.trim() || options.length >= TABLE_SELECT_MAX_OPTIONS}
          onClick={() => {
            finishLabel();
          }}
        >
          <PlusIcon />
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </p>
      )}
      <span className={styles.srOnly} role="status">
        {announcement}
      </span>
    </div>
  );
}
