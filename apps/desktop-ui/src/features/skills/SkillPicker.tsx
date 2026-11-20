import { useId, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { useDismissable } from '@desktop/components/Popover';
import { usePointerMoveGate } from '@desktop/hooks/usePointerMoveGate';
import type { SkillInfo } from '@desktop/utils/api/skills';
import styles from './skills.module.scss';

export interface SkillPickerProps {
  /** The user's skills (from skillsApi.list; built-ins are never listed). */
  skills: SkillInfo[];
  /** Ids currently assigned. */
  selected: readonly string[];
  /** Called with the next assigned list (registry order). */
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Accessible name for the assigned list; the search box is "Add … ". */
  label: string;
  /** Shown inside the dropdown when the registry has no skills at all. */
  emptyRegistry?: ReactNode;
}

function matches(skill: SkillInfo, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [skill.slug, skill.name, skill.description].some((v) => v.toLowerCase().includes(needle));
}

/**
 * Assigned skills as a removable list, plus a searchable add-dropdown
 * (combobox). Standard combobox ARIA/keyboard contract: arrows move the active
 * option, Enter adds it, Escape closes and keeps focus in the box. Assigned
 * skills never appear in the dropdown; an
 * invalid skill appears with its error but cannot be added. Outside presses
 * close it through the shared useDismissable contract.
 */
export const SkillPicker: FC<SkillPickerProps> = ({
  skills,
  selected,
  onChange,
  disabled,
  label,
  emptyRegistry,
}) => {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Hover moves the highlight only once the pointer really moves: skills that
  // appear under a resting pointer must not take Enter.
  const pointer = usePointerMoveGate();

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const byId = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills]);
  const options = useMemo(
    () => skills.filter((s) => !selectedSet.has(s.id) && matches(s, query.trim())),
    [skills, selectedSet, query]
  );
  const addable = (i: number) => options[i]?.status === 'valid';

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const dismiss = useDismissable({
    open,
    onDismiss: close,
    surfaceRef: rootRef,
    // The input owns Escape so it can stop it reaching the pane underneath.
    closeOnEscape: false,
  });

  const firstAddable = (from: number, step: 1 | -1): number => {
    for (let i = from; i >= 0 && i < options.length; i += step) if (addable(i)) return i;
    return -1;
  };

  const openList = () => {
    if (!open) pointer.reset();
    setOpen(true);
    setActive((a) => (a >= 0 ? a : firstAddable(0, 1)));
  };

  const add = (skill: SkillInfo) => {
    if (skill.status !== 'valid' || disabled) return;
    const next = new Set(selectedSet).add(skill.id);
    onChange(skills.filter((s) => next.has(s.id)).map((s) => s.id));
    setQuery('');
    close();
    inputRef.current?.focus();
  };

  const remove = (id: string) => {
    const next = selected.filter((s) => s !== id);
    onChange(next);
    inputRef.current?.focus();
  };

  return (
    <div className={styles.picker} ref={rootRef} {...dismiss}>
      {selected.length === 0 ? (
        <p className={styles.hint}>No skills</p>
      ) : (
        <ul className={styles.assignedList} aria-label={label}>
          {selected.map((id) => {
            const skill = byId.get(id);
            return (
              <li key={id} className={styles.assignedItem}>
                <div className={styles.pickerItem}>
                  <span className={styles.skillName}>
                    {skill?.slug ?? id}
                    {skill?.status === 'invalid' && (
                      <span className={styles.invalidTag}>invalid</span>
                    )}
                  </span>
                  {skill && <span className={styles.skillDescription}>{skill.description}</span>}
                </div>
                <button
                  type="button"
                  className={styles.removeBtn}
                  aria-label={`Remove ${skill?.slug ?? id}`}
                  disabled={disabled}
                  onClick={() => remove(id)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.combo}>
        <input
          ref={inputRef}
          className={styles.comboInput}
          type="search"
          role="combobox"
          aria-label={`Add to ${label}`}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listboxId}-opt-${active}` : undefined}
          placeholder="Add a skill…"
          value={query}
          // Not disabled while saving, so focus stays here between picks.
          aria-busy={disabled || undefined}
          // Open on click, typing or ArrowDown — not on focus, so removing a
          // skill (which refocuses the input) doesn't pop the list open.
          onClick={openList}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(-1);
            pointer.reset();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (open) {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
              return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (!open) {
                openList();
                return;
              }
              const step = e.key === 'ArrowDown' ? 1 : -1;
              const start = active < 0 ? (step === 1 ? 0 : options.length - 1) : active + step;
              const next = firstAddable(start, step);
              if (next >= 0) setActive(next);
              return;
            }
            if (e.key === 'Enter' && open) {
              e.preventDefault();
              const i = active >= 0 ? active : firstAddable(0, 1);
              const skill = options[i];
              if (skill) add(skill);
            }
          }}
        />
        {open && (
          <div
            id={listboxId}
            role="listbox"
            aria-label={`${label} options`}
            className={styles.comboList}
          >
            {skills.length === 0 ? (
              <div className={styles.comboEmpty}>{emptyRegistry ?? 'No skills yet.'}</div>
            ) : options.length === 0 ? (
              <div className={styles.comboEmpty}>
                {query.trim() ? 'No matching skills' : 'Every skill is already added'}
              </div>
            ) : (
              options.map((skill, i) => {
                const ok = skill.status === 'valid';
                return (
                  <div
                    key={skill.id}
                    id={`${listboxId}-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={!ok}
                    className={[
                      styles.comboOption,
                      i === active ? styles.comboOptionActive : '',
                      ok ? '' : styles.comboOptionDisabled,
                    ].join(' ')}
                    // Keep focus in the input; pick on mouse down.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(skill);
                    }}
                    onMouseMove={(e) => {
                      if (pointer.moved(e) && ok) setActive(i);
                    }}
                  >
                    <span className={styles.skillName}>
                      {skill.slug}
                      {!ok && <span className={styles.invalidTag}>invalid</span>}
                    </span>
                    {ok ? (
                      <span className={styles.skillDescription}>{skill.description}</span>
                    ) : (
                      <span className={styles.skillError}>{skill.error ?? 'Invalid SKILL.md'}</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
};
