import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  TABLE_SELECT_MAX_OPTIONS,
  TABLE_SELECT_OPTION_LABEL_MAX_LENGTH,
  type TableEntryValue,
  type TableSelectOption,
} from '@snaglet/shared/types';
import { getErrorMessage, selectOptionLabelProblem } from '@snaglet/shared/utils';
import { TextInput } from '@desktop/components';
import { usePointerMoveGate } from '@desktop/hooks/usePointerMoveGate';
import type { EntryCellEditorProps } from './cells/EntryCellEditor';
import { CellPickerPopover } from './CellPickerPopover';
import { SelectOptionTag } from './SelectOptionTag';
import { entryValueList } from './entryValueList';
import styles from './SelectEntryPicker.module.scss';

interface Props extends EntryCellEditorProps {
  /** Resolve only after the new option's schema and entry draft are ready to receive its label. */
  onCreateOption?: (label: string) => Promise<TableSelectOption | null>;
}

type Choice = { kind: 'option'; option: TableSelectOption } | { kind: 'create'; label: string };

export function SelectEntryPicker({
  field,
  value,
  onChange,
  onCommit,
  onCancel,
  busy,
  error,
  autoFocus,
  onCreateOption,
}: Props) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRefs = useRef(new Map<string, HTMLButtonElement>());
  const latestValue = useRef<TableEntryValue>(field.multiple ? entryValueList(value) : value);
  const [selected, setSelected] = useState(() => entryValueList(value));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<number | null>(null);
  // Hover moves the highlight only once the pointer really moves, so options
  // that appear under a resting pointer after typing cannot take Enter.
  const pointer = usePointerMoveGate();
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const closed = useRef(false);
  const generation = useRef(0);
  const [createdOptions, setCreatedOptions] = useState<Record<string, TableSelectOption>>({});
  const callbacks = useRef({ onChange, onCommit, onCancel, onCreateOption, busy });
  callbacks.current = { onChange, onCommit, onCancel, onCreateOption, busy };
  const options = field.options ?? [];
  const label = query.trim();
  const labelProblem = label ? selectOptionLabelProblem(label) : null;
  const existing = options.find((option) => option.label.toLowerCase() === label.toLowerCase());
  const alreadySelected = selected.some((value) => value.toLowerCase() === label.toLowerCase());
  const optionLimit = options.length >= TABLE_SELECT_MAX_OPTIONS;
  const choices: Choice[] = options
    .filter(
      (option) =>
        option.label.toLowerCase().includes(label.toLowerCase()) &&
        !selected.some((value) => value.toLowerCase() === option.label.toLowerCase())
    )
    .map((option) => ({ kind: 'option', option }));
  if (onCreateOption && label && !labelProblem && !existing && !alreadySelected && !optionLimit)
    choices.push({ kind: 'create', label });
  const activeIndex =
    active === null || !choices.length ? null : Math.min(active, choices.length - 1);
  const activeChoice = activeIndex === null ? undefined : choices[activeIndex];
  const blocked = busy || pending;
  const message = error ?? failure ?? labelProblem;

  useEffect(() => {
    latestValue.current = field.multiple ? entryValueList(value) : value;
    setSelected(entryValueList(value));
  }, [value, field.multiple, field.id, field.tableId]);
  useLayoutEffect(() => {
    closed.current = false;
    pendingRef.current = false;
    generation.current += 1;
    setPending(false);
    setQuery('');
    setActive(null);
    pointer.reset();
    setFailure(null);
    setCreatedOptions({});
    return () => {
      closed.current = true;
      generation.current += 1;
    };
  }, [field.id, field.tableId, field.multiple, pointer]);
  useEffect(() => {
    if (activeChoice)
      document
        .getElementById(`${id}-option-${activeIndex}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, activeChoice, id]);

  const change = (labels: string[]) => {
    const next = field.multiple ? labels : (labels[0] ?? null);
    latestValue.current = next;
    setSelected(labels);
    callbacks.current.onChange(next);
    return next;
  };
  const select = (option: TableSelectOption) => {
    if (closed.current) return;
    const current = entryValueList(latestValue.current);
    if (current.some((value) => value.toLowerCase() === option.label.toLowerCase())) return;
    const next = change(field.multiple ? [...current, option.label] : [option.label]);
    setQuery('');
    setActive(null);
    setFailure(null);
    if (!field.multiple) callbacks.current.onCommit(next);
    else inputRef.current?.focus({ preventScroll: true });
  };
  const choose = async (choice: Choice) => {
    if (callbacks.current.busy || pendingRef.current || closed.current) return;
    if (choice.kind === 'option') {
      select(choice.option);
      return;
    }
    const create = callbacks.current.onCreateOption;
    if (!create) return;
    const currentGeneration = ++generation.current;
    pendingRef.current = true;
    setPending(true);
    setFailure(null);
    try {
      const option = await create(choice.label);
      if (closed.current || generation.current !== currentGeneration) return;
      if (option) {
        setCreatedOptions((previous) => ({ ...previous, [option.label]: option }));
        select(option);
      } else setFailure('The option was not added. Try again.');
    } catch (err: unknown) {
      if (!closed.current && generation.current === currentGeneration)
        setFailure(getErrorMessage(err, 'Could not create the option'));
    } finally {
      if (!closed.current && generation.current === currentGeneration) {
        pendingRef.current = false;
        setPending(false);
        inputRef.current?.focus({ preventScroll: true });
      }
    }
  };
  const remove = (label: string) => {
    if (callbacks.current.busy || pendingRef.current || closed.current) return;
    change(entryValueList(latestValue.current).filter((value) => value !== label));
    setFailure(null);
    inputRef.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || closed.current) return;
    if (event.key === 'Escape' && (!busy || pendingRef.current)) {
      event.preventDefault();
      event.stopPropagation();
      closed.current = true;
      generation.current += 1;
      callbacks.current.onCancel();
      return;
    }
    if (event.key === 'Tab') {
      if (busy && !pendingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy && !pendingRef.current) callbacks.current.onCommit(latestValue.current);
      return;
    }
    if (busy || pendingRef.current || event.target !== inputRef.current) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((previous) => {
        if (!choices.length) return null;
        if (previous === null) return event.key === 'ArrowDown' ? 0 : choices.length - 1;
        return Math.max(
          0,
          Math.min(choices.length - 1, previous + (event.key === 'ArrowDown' ? 1 : -1))
        );
      });
    } else if (event.key === 'ArrowLeft' && !query && selected.length) {
      event.preventDefault();
      const last = selected[selected.length - 1];
      if (last) removeRefs.current.get(last)?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeChoice) void choose(activeChoice);
      else if (!label) callbacks.current.onCommit(latestValue.current);
    }
  };

  return (
    <div ref={setAnchor} className={styles.picker} onKeyDown={onKeyDown} data-keeps-cell="">
      <div className={styles.selected} aria-label={`Selected options in ${field.name}`}>
        {selected.map((label) => {
          const option = options.find((option) => option.label === label) ?? createdOptions[label];
          return (
            <span className={styles.selectedOption} key={label}>
              <SelectOptionTag label={label} color={option?.color} />
              <button
                type="button"
                className={styles.remove}
                disabled={blocked}
                aria-label={`Remove ${label}`}
                ref={(element) => {
                  if (element) removeRefs.current.set(label, element);
                  else removeRefs.current.delete(label);
                }}
                onClick={() => remove(label)}
                onKeyDown={(event) => {
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault();
                    remove(label);
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    inputRef.current?.focus();
                  }
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          );
        })}
        {!selected.length && <span className={styles.placeholder}>Choose an option…</span>}
      </div>
      <CellPickerPopover anchor={anchor}>
        <TextInput
          unstyled
          ref={inputRef}
          className={styles.search}
          role="combobox"
          aria-label={`Find ${field.name}`}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={activeChoice ? `${id}-option-${activeIndex}` : undefined}
          aria-busy={pending}
          aria-invalid={!!message}
          aria-describedby={message ? `${id}-error` : undefined}
          aria-description="With an empty search, press Left Arrow to reach selected options, then Enter or Delete to remove."
          placeholder={onCreateOption ? 'Find or create an option…' : 'Find an option…'}
          maxLength={TABLE_SELECT_OPTION_LABEL_MAX_LENGTH}
          value={query}
          readOnly={blocked}
          autoFocus={autoFocus}
          onChange={(event) => {
            if (callbacks.current.busy || pendingRef.current || closed.current) return;
            setQuery(event.target.value);
            setActive(event.target.value.trim() ? 0 : null);
            pointer.reset();
            setFailure(null);
          }}
        />
        <div
          role="listbox"
          id={`${id}-list`}
          className={styles.results}
          aria-label={`Options for ${field.name}`}
          aria-busy={pending}
        >
          {choices.map((choice, index) => (
            <div
              key={choice.kind === 'option' ? choice.option.id : 'create'}
              role="option"
              id={`${id}-option-${index}`}
              aria-label={
                choice.kind === 'option' ? choice.option.label : `Create “${choice.label}”`
              }
              aria-selected={index === activeIndex}
              aria-disabled={blocked}
              className={styles.option}
              // An untouched empty search never highlights, so Enter there
              // commits the value unchanged.
              onPointerMove={(event) => {
                if (pointer.moved(event) && !blocked && (label || active !== null))
                  setActive(index);
              }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void choose(choice)}
            >
              {choice.kind === 'option' ? (
                <SelectOptionTag label={choice.option.label} color={choice.option.color} />
              ) : (
                <span className={styles.create}>Create “{choice.label}”</span>
              )}
            </div>
          ))}
        </div>
        {pending && (
          <p className={styles.hint} role="status">
            Adding option…
          </p>
        )}
        {!pending && !message && !choices.length && (
          <p className={styles.hint}>
            {existing || alreadySelected
              ? 'Already selected'
              : label
                ? 'No matching options'
                : onCreateOption
                  ? 'Type a name to create an option'
                  : 'No options available'}
          </p>
        )}
        {!pending && label && !existing && optionLimit && (
          <p className={styles.hint}>
            This field has reached its {TABLE_SELECT_MAX_OPTIONS}-option limit.
          </p>
        )}
        {message && (
          <p id={`${id}-error`} className={styles.error} role="alert">
            {message}
          </p>
        )}
      </CellPickerPopover>
    </div>
  );
}
