import React, { useState, useEffect, useId, useRef } from 'react';
import {
  resetWorkspaceColors,
  setWorkspaceColors,
  subscribeTheme,
} from '@desktop/utils/workspaceTheme';
import styles from './ColorPicker.module.scss';

/** `#rrggbb` from what was typed (the `#` is optional), or null when it is not a hex color. */
function parseHex(input: string): string | null {
  const trimmed = input.trim();
  const hex = trimmed && !trimmed.startsWith('#') ? `#${trimmed}` : trimmed;
  return /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : null;
}

interface ColorPickerProps {
  name: string;
  label: string;
  /** What this color paints on screen, shown under the label. */
  description: string;
  defaultValue: string;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  name,
  label,
  description,
  defaultValue,
}) => {
  const descriptionId = useId();
  const [value, setValue] = useState<string>(() => {
    const current = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    return current || defaultValue;
  });
  const [hexInput, setHexInput] = useState(value);
  const skipBlur = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHexInput(value);
  }, [value]);

  // Follows every theme change, this window's and any other's (another
  // window's save, an agent's change_color_theme); a reset token reads its default.
  useEffect(
    () =>
      subscribeTheme(() => {
        const current = getComputedStyle(document.documentElement)
          .getPropertyValue(`--${name}`)
          .trim();
        setValue(current || defaultValue);
      }),
    [name, defaultValue]
  );

  const handleColorChange = (newColor: string) => {
    setValue(newColor);
    setHexInput(newColor);
    void setWorkspaceColors({ [name]: newColor });
  };

  /**
   * Apply the typed hex. An invalid entry snaps back to the current color, and
   * an unchanged one is not saved again. Returns whether the entry was valid.
   */
  const commitHexInput = (): boolean => {
    const hex = parseHex(hexInput);
    if (hex && hex.toLowerCase() !== value.toLowerCase()) handleColorChange(hex);
    else setHexInput(value);
    return hex !== null;
  };

  const handleHexKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter already committed; the blur it causes must not commit again.
      if (commitHexInput()) {
        skipBlur.current = true;
        inputRef.current?.blur();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      skipBlur.current = true;
      setHexInput(value);
      inputRef.current?.blur();
    }
  };

  const handleHexBlur = () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    commitHexInput();
  };

  // Drops the saved color rather than saving today's default, so this color
  // keeps following the default if a later version changes it.
  const handleReset = () => {
    setValue(defaultValue);
    void resetWorkspaceColors([name]);
  };

  const isDefault = value.toLowerCase() === defaultValue.toLowerCase();

  return (
    <div className={styles.card}>
      <div className={styles.swatchWrapper}>
        <label className={styles.swatch} style={{ backgroundColor: value }}>
          <input
            type="color"
            aria-label={`${label} color`}
            aria-describedby={descriptionId}
            value={value}
            onChange={(e) => handleColorChange(e.target.value)}
            className={styles.colorInput}
          />
        </label>
        {!isDefault && (
          <button
            type="button"
            onClick={handleReset}
            className={styles.resetBtn}
            title="Reset to default"
            aria-label={`Reset ${label} to default`}
          >
            ↺
          </button>
        )}
      </div>
      <div className={styles.info}>
        <div className={styles.label}>{label}</div>
        <p id={descriptionId} className={styles.description}>
          {description}
        </p>
        <input
          ref={inputRef}
          aria-label={`${label} hex color`}
          aria-describedby={descriptionId}
          type="text"
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value)}
          onKeyDown={handleHexKeyDown}
          onBlur={handleHexBlur}
          className={styles.hexInput}
          spellCheck={false}
          placeholder="#000000"
        />
      </div>
    </div>
  );
};
