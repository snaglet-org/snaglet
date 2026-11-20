import type { FC } from 'react';
import { ConfigField } from '../ConfigField/ConfigField';
import { TextInput, Select, RadioGroup, Radio } from '../controls';
import styles from '../AgentConfigCard/parts.module.scss';

export interface BudgetValues {
  // No output-token cap here: the per-request ceiling comes from the model
  // registry, not user config.
  maxToolCallsPerTurn?: number;
  maxDurationSeconds?: number | null;
}

interface BudgetControlProps {
  value: BudgetValues;
  onChange: (value: BudgetValues) => void;
  /** Persist after a typed field loses focus; receives the values to save. */
  onCommit?: (value: BudgetValues) => void;
  /**
   * Persist a discrete choice (limit mode, unit) right away. Receives the new
   * values directly: the parent's state has not re-rendered yet, so anything
   * it reads back from its own state or a ref would still be stale.
   */
  onImmediateChange?: (value: BudgetValues) => void;
}

interface NumericField {
  key: keyof BudgetValues;
  label: string;
  placeholder: string;
}

// Per-agent budget knobs. Conversation-wide caps (maxWaves, maxAgentDispatches)
// are thread-scoped and edited in the Routing settings pane, not here.
const AGENT_NUMERIC_FIELDS: NumericField[] = [
  { key: 'maxToolCallsPerTurn', label: 'Tool calls per turn', placeholder: '1000' },
];

const DURATION_UNITS = [
  { label: 'seconds', factor: 1 },
  { label: 'minutes', factor: 60 },
  { label: 'hours', factor: 3600 },
] as const;

function secondsToDisplay(seconds: number): { value: number; unitIndex: number } {
  if (seconds >= 3600 && seconds % 3600 === 0) return { value: seconds / 3600, unitIndex: 2 };
  if (seconds >= 60 && seconds % 60 === 0) return { value: seconds / 60, unitIndex: 1 };
  return { value: seconds, unitIndex: 0 };
}

export const BudgetControl: FC<BudgetControlProps> = ({
  value,
  onChange,
  onCommit,
  onImmediateChange,
}) => {
  const handleChange = (key: keyof BudgetValues, raw: string) => {
    const num = raw === '' ? undefined : Number(raw);
    onChange({ ...value, [key]: num });
  };

  const changeAndPersist = (next: BudgetValues) => {
    onChange(next);
    onImmediateChange?.(next);
  };

  const commit = () => onCommit?.(value);

  const limitSeconds = value.maxDurationSeconds;
  const isLimited = typeof limitSeconds === 'number';
  const display = isLimited ? secondsToDisplay(limitSeconds) : { value: 0, unitIndex: 1 };

  return (
    <div className={styles.budgetGridSingle}>
      {AGENT_NUMERIC_FIELDS.map(({ key, label, placeholder }) => (
        <ConfigField key={key} label={label}>
          <TextInput
            type="number"
            inputSize="sm"
            aria-label={label}
            value={value[key] ?? ''}
            onChange={(e) => handleChange(key, e.target.value)}
            onBlur={commit}
            placeholder={placeholder}
            min={0}
            fullWidth
          />
        </ConfigField>
      ))}

      <div className={styles.budgetDurationSpan}>
        <ConfigField label="Run time limit">
          <div className={styles.durationControl}>
            <RadioGroup
              value={isLimited ? 'limited' : 'unlimited'}
              onChange={(next) =>
                changeAndPersist({
                  ...value,
                  maxDurationSeconds: next === 'unlimited' ? null : 900,
                })
              }
              size="sm"
              aria-label="Run time limit mode"
            >
              <Radio value="unlimited">Unlimited</Radio>
              <Radio value="limited">Limited</Radio>
            </RadioGroup>
            {isLimited && (
              <div className={styles.durationInputRow}>
                <TextInput
                  type="number"
                  inputSize="sm"
                  aria-label="Run time limit amount"
                  value={display.value || ''}
                  min={1}
                  onChange={(e) => {
                    const num = Number(e.target.value);
                    if (num > 0) {
                      onChange({
                        ...value,
                        maxDurationSeconds: num * DURATION_UNITS[display.unitIndex].factor,
                      });
                    }
                  }}
                  onBlur={commit}
                  containerClassName={styles.durationValueInput}
                />
                <Select
                  size="sm"
                  aria-label="Run time limit unit"
                  value={display.unitIndex}
                  onChange={(e) => {
                    const idx = Number(e.target.value) as 0 | 1 | 2;
                    changeAndPersist({
                      ...value,
                      maxDurationSeconds: display.value * DURATION_UNITS[idx].factor,
                    });
                  }}
                  className={styles.durationUnitSelect}
                >
                  {DURATION_UNITS.map((u, i) => (
                    <option key={u.label} value={i}>
                      {u.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        </ConfigField>
      </div>
    </div>
  );
};
