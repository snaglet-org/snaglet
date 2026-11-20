import { useId, useState, type RefObject } from 'react';
import type { TableFieldDefinition } from '@snaglet/shared/types';
import { OptionToggle, OptionToggleRow, Select } from '@desktop/components';
import { SelectOptionsEditor } from './SelectOptionsEditor';
import { SelectOptionTag } from './SelectOptionTag';
import editorStyles from './TableFieldEditor.module.scss';
import styles from './SelectFieldSettings.module.scss';

interface Props {
  tableId: string;
  fieldId?: string;
  persistedOptionIds?: readonly string[];
  draft: TableFieldDefinition;
  disabled: boolean;
  flushPendingRef: RefObject<(() => boolean) | null>;
  onChange: (value: Partial<TableFieldDefinition>) => void;
  onRequiredChange: (required: boolean) => void;
}

/** Select-only settings keep option metadata and label-based defaults in sync. */
export function SelectFieldSettings({
  tableId,
  fieldId,
  persistedOptionIds,
  draft,
  disabled,
  flushPendingRef,
  onChange,
  onRequiredChange,
}: Props) {
  const defaultId = useId();
  const [conversionProblem, setConversionProblem] = useState<string | null>(null);
  const options = draft.options ?? [];
  const defaults = Array.isArray(draft.defaultValue) ? draft.defaultValue : [];
  return (
    <div className={styles.settings}>
      <OptionToggleRow aria-label="Choice options">
        <OptionToggle
          pressed={draft.multiple ?? false}
          disabled={disabled}
          onChange={(multiple) => {
            if (!multiple && defaults.length > 1) {
              setConversionProblem(
                'Keep at most one default option before switching to a single choice.'
              );
              return;
            }
            setConversionProblem(null);
            onChange({
              multiple,
              nullable: multiple ? false : true,
              defaultValue: multiple
                ? typeof draft.defaultValue === 'string'
                  ? [draft.defaultValue]
                  : []
                : (defaults[0] ?? null),
            });
          }}
        >
          Allow multiple choices
        </OptionToggle>
        {!draft.multiple && (
          <OptionToggle pressed={!draft.nullable} disabled={disabled} onChange={onRequiredChange}>
            Required
          </OptionToggle>
        )}
      </OptionToggleRow>
      {conversionProblem && (
        <p role="alert" className={styles.notice}>
          {conversionProblem}
        </p>
      )}
      <SelectOptionsEditor
        tableId={tableId}
        fieldId={fieldId}
        persistedOptionIds={persistedOptionIds}
        required={!draft.multiple && !draft.nullable}
        options={options}
        defaultValue={draft.defaultValue}
        disabled={disabled}
        flushPendingRef={flushPendingRef}
        onChange={onChange}
      />
      <div className={styles.defaults}>
        {draft.multiple ? (
          <>
            <span id={defaultId}>Default choices</span>
            {options.length ? (
              <div className={styles.defaultChoices} role="group" aria-labelledby={defaultId}>
                {options.map((option) => (
                  <button
                    key={option.id ?? option.label}
                    type="button"
                    disabled={disabled}
                    aria-label={`Default ${option.label}`}
                    aria-pressed={defaults.includes(option.label)}
                    className={styles.defaultChoice}
                    onClick={() => {
                      setConversionProblem(null);
                      onChange({
                        defaultValue: defaults.includes(option.label)
                          ? defaults.filter((label) => label !== option.label)
                          : [...defaults, option.label],
                      });
                    }}
                  >
                    <SelectOptionTag label={option.label} color={option.color} />
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.notice}>Add an option to choose a default.</p>
            )}
          </>
        ) : (
          <>
            <label htmlFor={defaultId}>Default choice</label>
            <Select
              id={defaultId}
              className={editorStyles.typeSelect}
              value={typeof draft.defaultValue === 'string' ? draft.defaultValue : ''}
              disabled={disabled}
              onChange={(event) => onChange({ defaultValue: event.target.value || null })}
            >
              <option value="">No default</option>
              {options.map((option) => (
                <option key={option.id ?? option.label} value={option.label}>
                  {option.label}
                </option>
              ))}
            </Select>
          </>
        )}
      </div>
    </div>
  );
}
