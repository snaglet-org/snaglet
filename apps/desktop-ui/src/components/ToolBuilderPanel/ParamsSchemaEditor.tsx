import type { FC } from 'react';
import { Button, Select, Switch, TextInput } from '@desktop/components';
import { makeEmptyParamRow, type ParamFieldRow, type ParamType } from './scaffold';
import styles from './ParamsSchemaEditor.module.scss';

interface ParamsSchemaEditorProps {
  rows: ParamFieldRow[];
  onChange: (rows: ParamFieldRow[]) => void;
  disabled?: boolean;
}

const PARAM_TYPES: { value: ParamType; label: string }[] = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'enum', label: 'enum' },
  { value: 'array', label: 'array' },
  { value: 'object', label: 'object' },
];

function parseEnumValues(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * ParamsSchemaEditor — rows of {name, type, required, description[, enum
 * values]} that ToolBuilderPanel assembles into a JSON-Schema
 * `parametersSchema` via scaffold.ts's `buildParametersSchema`. Each row is
 * its own bordered card (`role="group"`) so add/remove reads clearly against
 * the sharp-corner house style — no drag handles or table grid, matching
 * ToolView's stacked-field grammar rather than a spreadsheet.
 */
export const ParamsSchemaEditor: FC<ParamsSchemaEditorProps> = ({
  rows,
  onChange,
  disabled = false,
}) => {
  const updateRow = (id: string, patch: Partial<ParamFieldRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: string) => {
    onChange(rows.filter((row) => row.id !== id));
  };

  const addRow = () => {
    onChange([...rows, makeEmptyParamRow()]);
  };

  return (
    <div className={styles.root}>
      {rows.length === 0 && (
        <p className={styles.empty}>No parameters yet — this tool takes no input.</p>
      )}

      <div className={styles.rows}>
        {rows.map((row) => (
          <fieldset key={row.id} role="group" className={styles.row} disabled={disabled}>
            <div className={styles.rowMain}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Name</span>
                <TextInput
                  size="sm"
                  value={row.name}
                  onChange={(e) => updateRow(row.id, { name: e.target.value })}
                  placeholder="param_name"
                  aria-label="Parameter name"
                  disabled={disabled}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Type</span>
                <Select
                  size="sm"
                  value={row.type}
                  onChange={(e) => updateRow(row.id, { type: e.target.value as ParamType })}
                  aria-label="Parameter type"
                  disabled={disabled}
                >
                  {PARAM_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </label>

              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className={styles.removeBtn}
                onClick={() => removeRow(row.id)}
                disabled={disabled}
                title="Remove parameter"
                aria-label="Remove parameter"
              >
                ×
              </Button>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Description</span>
              <TextInput
                size="sm"
                value={row.description}
                onChange={(e) => updateRow(row.id, { description: e.target.value })}
                placeholder="What is this parameter for?"
                aria-label="Parameter description"
                disabled={disabled}
              />
            </label>

            {row.type === 'enum' && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Enum values (comma-separated)</span>
                <TextInput
                  size="sm"
                  value={row.enumValues.join(',')}
                  onChange={(e) =>
                    updateRow(row.id, { enumValues: parseEnumValues(e.target.value) })
                  }
                  placeholder="option_a,option_b"
                  aria-label="Enum values"
                  disabled={disabled}
                />
              </label>
            )}

            <label className={styles.requiredRow}>
              <Switch
                size="sm"
                checked={row.required}
                onChange={(next) => updateRow(row.id, { required: next })}
                disabled={disabled}
              />
              <span className={styles.fieldLabel}>Required</span>
            </label>
          </fieldset>
        ))}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={addRow}
        disabled={disabled}
        className={styles.addBtn}
      >
        + Add parameter
      </Button>
    </div>
  );
};
